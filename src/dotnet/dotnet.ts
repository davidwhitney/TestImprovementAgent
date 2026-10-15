import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run, type RunResult } from '../util/exec.ts';
import { findFiles } from './projects.ts';
import { mergeTrx, type TestSummary } from './trx.ts';

export interface BuildResult {
  ok: boolean;
  errors: string[];
  outputTail: string;
}

export interface TestRunResult {
  ok: boolean;
  summary: TestSummary;
  coberturaFiles: string[];
  /** Set when dotnet test failed without producing results (crash, restore failure, timeout). */
  infrastructureError?: string;
}

const tail = (s: string, n = 4000) => (s.length > n ? s.slice(-n) : s);

export function extractBuildErrors(output: string): string[] {
  const errors = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /: error [A-Z]+\d*:|error MSB\d+|error NU\d+/.test(l))
    .map((l) => l.replace(/\s+\[[^\]]+\.(cs|fs|vb)proj(::[^\]]*)?\]$/, ''));
  return [...new Set(errors)];
}

export async function build(sln: string, logFile: string, timeoutMs: number): Promise<BuildResult> {
  const r = await run('dotnet', ['build', sln, '-nologo', '-v', 'q', '-clp:NoSummary'], {
    cwd: dirname(sln),
    logFile,
    timeoutMs,
    env: { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
  });
  const output = `${r.stdout}\n${r.stderr}`;
  const errors = extractBuildErrors(output);
  if (r.timedOut) errors.push(`dotnet build timed out after ${Math.round(timeoutMs / 60000)} minutes`);
  return { ok: r.code === 0 && !r.timedOut, errors: r.code !== 0 && errors.length === 0 ? [tail(output, 2000)] : errors, outputTail: tail(output) };
}

/**
 * Harness-owned runsettings: the agent cannot weaken coverage by editing it, and every test
 * project's own assembly is excluded so only production code counts.
 */
export function writeRunSettings(path: string, testAssemblyNames: string[]): void {
  const exclude = ['[xunit*]*', '[NUnit*]*', ...testAssemblyNames.map((n) => `[${n}]*`)].join(',');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="utf-8"?>
<RunSettings>
  <DataCollectionRunSettings>
    <DataCollectors>
      <DataCollector friendlyName="XPlat code coverage">
        <Configuration>
          <Format>cobertura</Format>
          <Exclude>${exclude}</Exclude>
          <ExcludeByFile>**/obj/**,**/*.g.cs,**/*.Designer.cs</ExcludeByFile>
          <ExcludeByAttribute>GeneratedCodeAttribute</ExcludeByAttribute>
          <IncludeTestAssembly>false</IncludeTestAssembly>
          <SkipAutoProps>true</SkipAutoProps>
        </Configuration>
      </DataCollector>
    </DataCollectors>
  </DataCollectionRunSettings>
</RunSettings>
`,
  );
}

export async function test(sln: string, opts: { runSettings: string; resultsDir: string; logFile: string; timeoutMs: number }): Promise<TestRunResult> {
  rmSync(opts.resultsDir, { recursive: true, force: true });
  mkdirSync(opts.resultsDir, { recursive: true });
  const r: RunResult = await run(
    'dotnet',
    ['test', sln, '--no-build', '--nologo', '--settings', opts.runSettings, '--results-directory', opts.resultsDir, '--logger', 'trx', '--collect', 'XPlat Code Coverage'],
    { cwd: dirname(sln), logFile: opts.logFile, timeoutMs: opts.timeoutMs, env: { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } },
  );
  const trxFiles = findFiles(opts.resultsDir, (f) => f.endsWith('.trx'), 3);
  const coberturaFiles = findFiles(opts.resultsDir, (f) => f.endsWith('coverage.cobertura.xml'), 3);
  const summary = mergeTrx(trxFiles);
  const output = `${r.stdout}\n${r.stderr}`;

  if (r.timedOut) {
    return { ok: false, summary, coberturaFiles, infrastructureError: `dotnet test timed out after ${Math.round(opts.timeoutMs / 60000)} minutes (a test is probably hanging).\n${tail(output, 3000)}` };
  }
  if (r.code !== 0 && summary.failed === 0) {
    // No failing test recorded, yet the run failed: a crashed test host, a missing SDK, or a build problem.
    return { ok: false, summary, coberturaFiles, infrastructureError: tail(output, 4000) };
  }
  return { ok: r.code === 0 && summary.failed === 0, summary, coberturaFiles };
}

export function renderFailures(summary: TestSummary, limit = 30): string {
  if (summary.failures.length === 0) return '_No failing tests recorded._';
  const parts = summary.failures.slice(0, limit).map((f) => {
    const stack = f.stackTrace.split('\n').slice(0, 12).join('\n');
    return `### ${f.name}\n\n\`\`\`\n${f.message.slice(0, 3000)}\n${stack}\n\`\`\``;
  });
  if (summary.failures.length > limit) parts.push(`…and ${summary.failures.length - limit} more failures.`);
  return `${summary.failed} of ${summary.total} tests failed.\n\n${parts.join('\n\n')}`;
}

export const resultsDirFor = (workDir: string, label: string) => join(workDir, 'runs', label);
