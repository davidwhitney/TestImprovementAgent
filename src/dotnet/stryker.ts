import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { run } from '../util/exec.ts';
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

export interface StrykerRunResult {
  report?: MutationReport;
  error?: string;
}

export async function runStryker(repo: string, configFile: string, outDir: string, logFile: string, timeoutMs: number): Promise<StrykerRunResult> {
  const env = { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };
  const restore = await run('dotnet', ['tool', 'restore'], { cwd: repo, logFile, timeoutMs: 10 * 60_000, env });
  if (restore.code !== 0) return { error: `dotnet tool restore failed:\n${(restore.stdout + restore.stderr).slice(-3000)}` };

  rmSync(outDir, { recursive: true, force: true });
  const started = Date.now();
  const r = await run(
    'dotnet',
    ['stryker', '--config-file', relative(repo, configFile), '--reporter', 'json', '--reporter', 'progress', '--output', outDir],
    { cwd: repo, logFile, timeoutMs, env },
  );
  // Prefer our --output dir; fall back to the newest StrykerOutput report written during this run.
  const reports = [
    ...findFiles(outDir, (f) => f.endsWith('mutation-report.json'), 4),
    ...findFiles(repo, (f) => f.endsWith('mutation-report.json') && f.includes('StrykerOutput'), 8),
  ].filter((f) => statSync(f).mtimeMs >= started - 1000);
  const newest = reports.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!newest) {
    const why = r.timedOut ? `Stryker timed out after ${Math.round(timeoutMs / 60000)} minutes.` : `Stryker exited with code ${r.code} and produced no mutation-report.json.`;
    return { error: `${why}\n${(r.stdout + r.stderr).slice(-4000)}` };
  }
  return { report: parseMutationReport(readFileSync(newest, 'utf8'), repo, newest) };
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
