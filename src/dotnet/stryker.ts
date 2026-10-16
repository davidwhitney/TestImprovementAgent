import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { run } from '../util/exec.ts';
import { formatDuration } from '../util/log.ts';
import { findFiles } from './projects.ts';

export const STRYKER_CONFIG_NAMES = ['stryker-config.json', 'stryker-config.yaml', 'stryker-config.yml'];

export interface StrykerSetup {
  toolInstalled: boolean;
  configFile?: string;
}

export interface Mutant {
  file: string; // repo-relative
  line: number;
  mutator: string;
  replacement: string;
  original: string;
  status: string;
}

export interface MutationReport {
  score: number;
  killed: number;
  survived: number;
  noCoverage: number;
  timeout: number;
  ignored: number;
  compileErrors: number;
  /** Survived + NoCoverage: the mutants tests must kill. */
  survivors: Mutant[];
  reportFile: string;
}

export function detectStryker(repo: string): StrykerSetup {
  const manifest = join(repo, '.config', 'dotnet-tools.json');
  const toolInstalled = existsSync(manifest) && /"dotnet-stryker"/i.test(readFileSync(manifest, 'utf8'));
  const configFile = STRYKER_CONFIG_NAMES.map((n) => join(repo, n)).find(existsSync);
  return { toolInstalled, configFile };
}

export function parseMutationReport(json: string, repo: string, reportFile = ''): MutationReport {
  const doc = JSON.parse(json) as {
    files?: Record<string, { source?: string; mutants?: { mutatorName: string; replacement?: string; status: string; location: { start: { line: number } } }[] }>;
  };
  const counts = { Killed: 0, Survived: 0, NoCoverage: 0, Timeout: 0, Ignored: 0, CompileError: 0 } as Record<string, number>;
  const survivors: Mutant[] = [];
  for (const [file, data] of Object.entries(doc.files ?? {})) {
    const sourceLines = (data.source ?? '').split('\n');
    const rel = isAbsolute(file) ? relative(repo, file) : file;
    for (const m of data.mutants ?? []) {
      counts[m.status] = (counts[m.status] ?? 0) + 1;
      if (m.status === 'Survived' || m.status === 'NoCoverage') {
        const line = m.location.start.line;
        survivors.push({
          file: rel,
          line,
          mutator: m.mutatorName,
          replacement: (m.replacement ?? '').slice(0, 300),
          original: (sourceLines[line - 1] ?? '').trim().slice(0, 300),
          status: m.status,
        });
      }
    }
  }
  const detected = counts.Killed! + counts.Timeout!;
  const valid = detected + counts.Survived! + counts.NoCoverage!;
  return {
    score: valid === 0 ? 100 : Math.floor((detected / valid) * 10000) / 100,
    killed: counts.Killed!,
    survived: counts.Survived!,
    noCoverage: counts.NoCoverage!,
    timeout: counts.Timeout!,
    ignored: counts.Ignored!,
    compileErrors: counts.CompileError!,
    survivors: survivors.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    reportFile,
  };
}

export interface StrykerProgress {
  total: number;
  tested: number;
  killed: number;
  survived: number;
  timeout: number;
}

/**
 * Follows Stryker's `dots` reporter, which writes one character per tested mutant ('.' killed,
 * 'S' survived, 'T' timeout) without newlines, interleaved with `[hh:mm:ss INF]` log lines.
 * Counting starts once Stryker announces how many mutants will be tested.
 */
export class StrykerProgressTracker {
  readonly progress: StrykerProgress = { total: 0, tested: 0, killed: 0, survived: 0, timeout: 0 };
  private startedAt = 0;
  private logText = ''; // the log message being assembled on the current line, if any
  private lineIsDots = true; // nothing but dot characters seen so far on the current line
  private inLog = false;

  push(chunk: string): void {
    const lines = chunk.split('\n');
    lines.forEach((text, i) => {
      if (i > 0) this.endLine();
      this.consume(text);
    });
  }

  private endLine(): void {
    const total = /(\d+)\s+total mutants will be tested/.exec(this.logText);
    if (total) {
      this.progress.total = Number(total[1]);
      this.startedAt = Date.now();
    }
    this.logText = '';
    this.inLog = false;
    this.lineIsDots = true;
  }

  private consume(text: string): void {
    let dots = text;
    if (!this.inLog) {
      const marker = /\[\d{2}:\d{2}:\d{2} \w{3}\]/.exec(text);
      if (marker) {
        dots = text.slice(0, marker.index);
        this.inLog = true;
        this.logText += text.slice(marker.index);
      }
    } else {
      this.logText += text;
      return;
    }
    if (!this.lineIsDots) return;
    if (!/^[.ST]*$/.test(dots)) {
      this.lineIsDots = false;
      return;
    }
    if (!this.progress.total) return;
    for (const c of dots) {
      this.progress.tested++;
      if (c === '.') this.progress.killed++;
      else if (c === 'S') this.progress.survived++;
      else this.progress.timeout++;
    }
  }

  describe(): string | undefined {
    const p = this.progress;
    if (!p.total) return undefined;
    const pct = Math.min(100, Math.round((p.tested / p.total) * 100));
    let eta = '';
    if (p.tested > 0 && p.tested < p.total) {
      const remainingMs = ((Date.now() - this.startedAt) / p.tested) * (p.total - p.tested);
      eta = `, ETA ~${formatDuration(remainingMs)}`;
    }
    return `Stryker tested ${p.tested}/${p.total} mutants (${pct}%): ${p.killed} killed, ${p.survived} survived, ${p.timeout} timeout${eta}`;
  }
}

export interface StrykerRunResult {
  report?: MutationReport;
  error?: string;
}

export interface StrykerRunOptions {
  repo: string;
  configFile: string;
  outDir: string;
  logFile: string;
  /** Per Stryker invocation (per shard when sharded). */
  timeoutMs: number;
  concurrency?: number;
  onChunk?: (chunk: string) => void;
  /** Mutate only these projects' source, split into resumable shards. Omit to run one unsharded Stryker. */
  shards?: ShardPlan;
  onShard?: (index: number, total: number, shard: StrykerShard, cached: boolean) => void;
}

/** Directories mutation testing skips by default: plain data, wiring and generated code produce mostly noise. */
export const DEFAULT_MUTATE_EXCLUDES = ['obj', 'bin', 'Migrations', 'Models', 'Configuration', 'HealthChecks', 'Program.cs'];

export interface StrykerShard {
  id: string;
  /** `--mutate` patterns: includes for this shard plus the shared excludes. */
  globs: string[];
  files: number;
  lines: number;
}

export interface ShardPlan {
  /** Identifies the code under test; completed shards are reused only while it is unchanged. */
  fingerprint: string;
  cacheDir: string;
  shards: StrykerShard[];
}

const isExcluded = (rel: string, excludes: string[]) => rel.split(sep).some((part) => excludes.includes(part));

const countLines = (file: string) => readFileSync(file, 'utf8').split('\n').length;

/**
 * Splits production source into `count` roughly equal shards (by line count), largest first.
 * Directories are the unit of splitting; one that is bigger than a shard is split by its subdirectories.
 */
export function planShards(projectDirs: string[], count: number, excludes: string[] = DEFAULT_MUTATE_EXCLUDES): StrykerShard[] {
  interface Unit { glob: string; files: number; lines: number }
  const units: Unit[] = [];
  const measureDir = (dir: string): { files: number; lines: number; subdirs: string[]; direct: { files: number; lines: number } } => {
    const total = { files: 0, lines: 0 };
    const direct = { files: 0, lines: 0 };
    const subdirs: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (excludes.includes(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        subdirs.push(full);
        const sub = measureDir(full);
        total.files += sub.files;
        total.lines += sub.lines;
      } else if (e.name.endsWith('.cs')) {
        const lines = countLines(full);
        direct.files++;
        direct.lines += lines;
        total.files++;
        total.lines += lines;
      }
    }
    return { ...total, subdirs, direct };
  };

  const all = projectDirs.map((d) => measureDir(d));
  const grandTotal = all.reduce((n, m) => n + m.lines, 0);
  const cap = Math.max(1, Math.ceil(grandTotal / Math.max(1, count)));

  const add = (dir: string, projectDir: string, isRoot: boolean) => {
    const m = measureDir(dir);
    if (m.files === 0) return;
    const rel = relative(projectDir, dir).split(sep).join('/');
    if (m.lines > cap && m.subdirs.length > 0) {
      if (m.direct.files > 0) units.push({ glob: isRoot ? '*.cs' : `**/${rel}/*.cs`, ...m.direct });
      for (const sub of m.subdirs) add(sub, projectDir, false);
    } else {
      units.push({ glob: isRoot ? '**/*.cs' : `**/${rel}/**/*.cs`, files: m.files, lines: m.lines });
    }
  };
  for (const dir of projectDirs) add(dir, dir, true);

  const n = Math.max(1, Math.min(count, units.length));
  const bins = Array.from({ length: n }, () => ({ units: [] as Unit[], lines: 0, files: 0 }));
  for (const u of units.sort((a, b) => b.lines - a.lines)) {
    const bin = bins.reduce((lo, b) => (b.lines < lo.lines ? b : lo));
    bin.units.push(u);
    bin.lines += u.lines;
    bin.files += u.files;
  }
  const exclusions = excludes.map((e) => (e.endsWith('.cs') ? `!**/${e}` : `!**/${e}/**`));
  return bins
    .filter((b) => b.units.length > 0)
    .sort((a, b) => b.lines - a.lines)
    .map((b, i) => ({ id: `shard-${i + 1}`, globs: [...b.units.map((u) => u.glob), ...exclusions], files: b.files, lines: b.lines }));
}

/** Combines per-shard reports (they cover disjoint files) into a single report document. */
export function mergeReports(jsons: string[]): string {
  const docs = jsons.map((j) => JSON.parse(j) as { files?: Record<string, unknown> });
  const merged = { ...docs[0], files: Object.assign({}, ...docs.map((d) => d.files ?? {})) };
  return JSON.stringify(merged);
}

function findReport(outDir: string, repo: string, since: number): string | undefined {
  // Prefer our --output dir; fall back to the newest StrykerOutput report written during this run.
  const reports = [
    ...findFiles(outDir, (f) => f.endsWith('mutation-report.json'), 4),
    ...findFiles(repo, (f) => f.endsWith('mutation-report.json') && f.includes('StrykerOutput'), 8),
  ].filter((f) => statSync(f).mtimeMs >= since - 1000);
  return reports.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

async function strykerOnce(o: StrykerRunOptions, outDir: string, mutate: string[]): Promise<{ file?: string; error?: string }> {
  const env = { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };
  rmSync(outDir, { recursive: true, force: true });
  const started = Date.now();
  const args = ['stryker', '--config-file', relative(o.repo, o.configFile), '--reporter', 'json', '--reporter', 'dots', '--output', outDir];
  if (o.concurrency) args.push('--concurrency', String(o.concurrency));
  for (const m of mutate) args.push('--mutate', m);
  const r = await run('dotnet', args, { cwd: o.repo, logFile: o.logFile, timeoutMs: o.timeoutMs, env, onStdoutChunk: o.onChunk });
  const file = findReport(outDir, o.repo, started);
  if (file) return { file };
  const why = r.timedOut ? `Stryker timed out after ${Math.round(o.timeoutMs / 60000)} minutes.` : `Stryker exited with code ${r.code} and produced no mutation-report.json.`;
  return { error: `${why}\n${(r.stdout + r.stderr).slice(-4000)}` };
}

export async function runStryker(o: StrykerRunOptions): Promise<StrykerRunResult> {
  const env = { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };
  const restore = await run('dotnet', ['tool', 'restore'], { cwd: o.repo, logFile: o.logFile, timeoutMs: 10 * 60_000, env });
  if (restore.code !== 0) return { error: `dotnet tool restore failed:\n${(restore.stdout + restore.stderr).slice(-3000)}` };

  if (!o.shards) {
    const r = await strykerOnce(o, o.outDir, []);
    return r.file ? { report: parseMutationReport(readFileSync(r.file, 'utf8'), o.repo, r.file) } : { error: r.error };
  }

  const { shards, cacheDir, fingerprint } = o.shards;
  const reports: string[] = [];
  for (const [i, shard] of shards.entries()) {
    const dir = join(cacheDir, fingerprint, shard.id);
    const done = join(dir, 'mutation-report.json');
    const cached = existsSync(done);
    o.onShard?.(i, shards.length, shard, cached);
    if (!cached) {
      const r = await strykerOnce(o, dir, shard.globs);
      if (!r.file) return { error: `${shard.id}/${shards.length} failed (completed shards are kept and reused on the next run): ${r.error}` };
      if (r.file !== done) writeFileSync(done, readFileSync(r.file));
    }
    reports.push(readFileSync(done, 'utf8'));
  }
  mkdirSync(o.outDir, { recursive: true });
  const merged = join(o.outDir, 'mutation-report.json');
  writeFileSync(merged, mergeReports(reports));
  return { report: parseMutationReport(readFileSync(merged, 'utf8'), o.repo, merged) };
}

export function renderSurvivors(report: MutationReport, limit = 40): string {
  if (report.survivors.length === 0) return '_No surviving mutants._';
  const out = [
    `Mutation score: **${report.score}%** — killed ${report.killed}, timeout ${report.timeout}, survived ${report.survived}, no coverage ${report.noCoverage}.`,
    '',
  ];
  let currentFile = '';
  for (const m of report.survivors.slice(0, limit)) {
    if (m.file !== currentFile) {
      currentFile = m.file;
      out.push(`### ${m.file}`);
    }
    out.push(`- line ${m.line} [${m.status}] **${m.mutator}**: \`${m.original}\` → \`${m.replacement}\``);
  }
  if (report.survivors.length > limit) out.push('', `…and ${report.survivors.length - limit} more (see surviving-mutants.json).`);
  return out.join('\n');
}
