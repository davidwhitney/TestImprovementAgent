import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { XMLParser } from 'fast-xml-parser';

interface LineHit {
  hits: number;
  branchCovered: number;
  branchTotal: number;
  method?: string;
}

export interface FileCoverage {
  path: string; // absolute
  relPath: string; // repo-relative
  coverable: number;
  covered: number;
  uncoveredLines: number[];
  /** Uncovered lines grouped by the method that owns them, e.g. "OrderService.PlaceOrder" -> [40, 41, 52]. */
  uncoveredByMethod: Record<string, number[]>;
  branchCovered: number;
  branchCoverable: number;
  /** Lines with unexercised branches, grouped by owning method. */
  missingBranchesByMethod: Record<string, BranchGap[]>;
  missingBranches: number;
}

export interface BranchGap {
  line: number;
  covered: number;
  total: number;
}

export interface CoverageReport {
  /** Branch coverage %, entry points excluded. This is the number the harness targets (a file with no branches counts as fully covered). */
  branchPercent: number;
  branchCoverable: number;
  branchCovered: number;
  /** Statement (line/sequence-point) coverage %, entry points excluded. Informational. */
  statementPercent: number;
  statementCoverable: number;
  statementCovered: number;
  /** Same as statementPercent but including entry-point files, for information. */
  rawStatementPercent: number;
  excludedFiles: string[];
  files: FileCoverage[];
  reportFiles: string[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => ['source', 'package', 'class', 'method', 'line'].includes(name),
});

type Merged = Map<string, Map<number, LineHit>>;

function resolvePath(filename: string, sources: string[]): string {
  if (isAbsolute(filename)) return filename;
  for (const s of sources) {
    const candidate = join(s, filename);
    if (existsSync(candidate)) return candidate;
  }
  return sources[0] ? join(sources[0], filename) : filename;
}

function parseBranches(line: { 'condition-coverage'?: string }): [number, number] {
  const m = /\((\d+)\/(\d+)\)/.exec(line['condition-coverage'] ?? '');
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

function mergeLine(target: Map<number, LineHit>, n: number, hit: LineHit): void {
  const prev = target.get(n);
  if (!prev) {
    target.set(n, hit);
    return;
  }
  prev.hits = Math.max(prev.hits, hit.hits);
  prev.branchTotal = Math.max(prev.branchTotal, hit.branchTotal);
  prev.branchCovered = Math.max(prev.branchCovered, hit.branchCovered);
  prev.method ??= hit.method;
}

/** Union one cobertura document into the merged map (max hits per line), so N test projects give one picture. */
export function mergeCobertura(xml: string, into: Merged = new Map()): Merged {
  const doc = parser.parse(xml);
  const cov = doc.coverage ?? {};
  const sources: string[] = (cov.sources?.source ?? []).map(String);
  for (const pkg of cov.packages?.package ?? []) {
    for (const cls of pkg.classes?.class ?? []) {
      const file = resolvePath(String(cls.filename), sources);
      const lines = into.get(file) ?? new Map<number, LineHit>();
      into.set(file, lines);
      // Method lines carry the method name; class lines are the authoritative superset.
      for (const m of cls.methods?.method ?? []) {
        const methodName = methodLabel(String(cls.name ?? ''), String(m.name ?? ''));
        for (const l of m.lines?.line ?? []) {
          const [bc, bt] = parseBranches(l);
          mergeLine(lines, Number(l.number), { hits: Number(l.hits), branchCovered: bc, branchTotal: bt, method: methodName });
        }
      }
      for (const l of cls.lines?.line ?? []) {
        const [bc, bt] = parseBranches(l);
        mergeLine(lines, Number(l.number), { hits: Number(l.hits), branchCovered: bc, branchTotal: bt });
      }
    }
  }
  return into;
}

/** "Ns.OrderService/<PlaceOrder>d__3" + "MoveNext" -> "OrderService.PlaceOrder" (async/iterator state machines). */
export function methodLabel(className: string, method: string): string {
  const parts = className.split('/');
  const owner = parts
    .filter((p) => !p.startsWith('<'))
    .map((p) => p.split('.').pop())
    .join('.');
  const generated = parts.map((p) => /^<(\w+)>/.exec(p)?.[1]).find(Boolean);
  return `${owner}.${generated ?? method.replace(/^<(\w+)>.*$/, '$1')}`;
}

const isGenerated = (p: string) => /[\\/](obj|bin)[\\/]/.test(p) || /\.(g|g\.i|designer|generated)\.cs$/i.test(p);

export function summarise(merged: Merged, repo: string, excluded: string[], reportFiles: string[] = []): CoverageReport {
  const excludedSet = new Set(excluded);
  const files: FileCoverage[] = [];
  let coverable = 0;
  let covered = 0;
  let rawCoverable = 0;
  let rawCovered = 0;
  let branchTotal = 0;
  let branchCovered = 0;

  for (const [path, lines] of merged) {
    if (isGenerated(path)) continue;
    const uncoveredLines: number[] = [];
    const uncoveredByMethod: Record<string, number[]> = {};
    let fileCovered = 0;
    let fileBranchCovered = 0;
    let fileBranchTotal = 0;
    const missingBranchesByMethod: Record<string, BranchGap[]> = {};
    for (const [n, hit] of [...lines].sort((a, b) => a[0] - b[0])) {
      fileBranchTotal += hit.branchTotal;
      fileBranchCovered += hit.branchCovered;
      if (hit.branchCovered < hit.branchTotal) (missingBranchesByMethod[hit.method ?? '(type-level)'] ??= []).push({ line: n, covered: hit.branchCovered, total: hit.branchTotal });
      if (hit.hits > 0) fileCovered++;
      else {
        uncoveredLines.push(n);
        (uncoveredByMethod[hit.method ?? '(type-level)'] ??= []).push(n);
      }
    }
    rawCoverable += lines.size;
    rawCovered += fileCovered;
    if (excludedSet.has(path)) continue;
    coverable += lines.size;
    covered += fileCovered;
    branchTotal += fileBranchTotal;
    branchCovered += fileBranchCovered;
    files.push({
      path,
      relPath: relative(repo, path),
      coverable: lines.size,
      covered: fileCovered,
      uncoveredLines,
      uncoveredByMethod,
      branchCovered: fileBranchCovered,
      branchCoverable: fileBranchTotal,
      missingBranchesByMethod,
      missingBranches: fileBranchTotal - fileBranchCovered,
    });
  }

  const pct = (a: number, b: number, whenEmpty = 0) => (b === 0 ? whenEmpty : Math.floor((a / b) * 10000) / 100);
  return {
    branchPercent: pct(branchCovered, branchTotal, 100),
    branchCoverable: branchTotal,
    branchCovered,
    statementPercent: pct(covered, coverable),
    statementCoverable: coverable,
    statementCovered: covered,
    rawStatementPercent: pct(rawCovered, rawCoverable),
    excludedFiles: excluded.filter((e) => merged.has(e)).map((e) => relative(repo, e)),
    files: files.sort((a, b) => b.missingBranches - a.missingBranches || b.uncoveredLines.length - a.uncoveredLines.length),
    reportFiles,
  };
}

export function loadCoverage(reportFiles: string[], repo: string, excluded: string[]): CoverageReport {
  const merged: Merged = new Map();
  for (const f of reportFiles) mergeCobertura(readFileSync(f, 'utf8'), merged);
  return summarise(merged, repo, excluded, reportFiles);
}

/** [1,2,3,7,9,10] -> "1-3, 7, 9-10" */
export function ranges(lines: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j]! + 1) j++;
    out.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
    i = j + 1;
  }
  return out.join(', ');
}

/** Markdown gap report handed to the agent. `limit` caps how many files are listed. */
export function renderGaps(report: CoverageReport, limit = 25): string {
  const gaps = report.files.filter((f) => f.missingBranches > 0);
  if (gaps.length === 0) return '_No unexercised branches._\n';
  const lines = [
    `Branch coverage: **${report.branchPercent}%** (${report.branchCovered}/${report.branchCoverable} branches), statement coverage ${report.statementPercent}%.`,
    report.excludedFiles.length ? `Entry-point files excluded from the target: ${report.excludedFiles.join(', ')}` : '',
    '',
    `| File | Branches covered | Missing branches |`,
    `|---|---|---|`,
    ...gaps.slice(0, limit).map((f) => `| ${f.relPath} | ${f.branchCovered}/${f.branchCoverable} | ${f.missingBranches} |`),
    '',
    'Each entry is `line (covered/total branches at that line)`. A line like `40 (0/2)` means neither outcome of a decision on line 40 has ever run (often the whole method is untested); `52 (1/2)` means only one outcome has, so you need an input that takes the other.',
    '',
  ];
  for (const f of gaps.slice(0, limit)) {
    lines.push(`### ${f.relPath}`);
    for (const [method, gs] of Object.entries(f.missingBranchesByMethod)) lines.push(`- \`${method}\` — ${gs.map((g) => `${g.line} (${g.covered}/${g.total})`).join(', ')}`);
    lines.push('');
  }
  if (gaps.length > limit) lines.push(`…and ${gaps.length - limit} more files with unexercised branches (see coverage-summary.json).`);
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}
