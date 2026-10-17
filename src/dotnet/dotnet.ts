import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/** Makes xunit.v3 test projects emit an entry point that always runs on Microsoft.Testing.Platform, so the executables can be started directly. */
export const TESTING_PLATFORM_BUILD_ARGS = ['-p:UseMicrosoftTestingPlatformRunner=true'];

export async function build(sln: string, logFile: string, timeoutMs: number, extraArgs: string[] = []): Promise<BuildResult> {
  const r = await run('dotnet', ['build', sln, '-nologo', '-v', 'q', '-clp:NoSummary', ...extraArgs], {
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

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeXml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export interface RunSettingsAssemblies {
  production: string[];
}

/** Harness-owned runsettings for the built-in Microsoft collector: the agent cannot weaken them. */
export function writeRunSettings(path: string, assemblies: RunSettingsAssemblies): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, microsoftRunSettings(assemblies.production));
}

/** The same collector configuration in the standalone format that Microsoft.Testing.Platform's `--coverage-settings` expects. */
export function writeCoverageSettings(path: string, assemblies: RunSettingsAssemblies): void {
  mkdirSync(dirname(path), { recursive: true });
  const xml = microsoftRunSettings(assemblies.production);
  const inner = /<CodeCoverage>[\s\S]*<\/CodeCoverage>/.exec(xml)?.[0] ?? '<CodeCoverage />';
  writeFileSync(path, `<?xml version="1.0" encoding="utf-8"?>\n<Configuration>\n  ${inner}\n</Configuration>\n`);
}

/**
 * True when global.json (searched upwards from `dir`) opts `dotnet test` into the Microsoft.Testing.Platform runner.
 * That mode rejects the VSTest-only `--settings`, `--logger` and `--collect` options: the test hosts exit
 * without running anything and `dotnet test` reports "Zero tests ran".
 */
export function usesTestingPlatform(dir: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    const file = join(d, 'global.json');
    if (existsSync(file)) {
      try {
        const json = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as { test?: { runner?: string } };
        return /^Microsoft\.Testing\.Platform$/i.test(json.test?.runner ?? '');
      } catch {
        return false;
      }
    }
    if (dirname(d) === d) return false;
  }
}

/**
 * The built-in Microsoft code coverage collector (`--collect "Code Coverage"`,
 * which ships with Microsoft.NET.Test.Sdk, so no extra package is needed). The agent cannot weaken it, and
 * only production assemblies are instrumented: test projects and third-party packages never count.
 */
function microsoftRunSettings(productionAssemblyNames: string[]): string {
  const modules = productionAssemblyNames.map((n) => `                <ModulePath>(^|.*[\\/])${escapeXml(escapeRegex(n))}\\.dll$</ModulePath>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<RunSettings>
  <DataCollectionRunSettings>
    <DataCollectors>
      <DataCollector friendlyName="Code Coverage">
        <Configuration>
          <Format>cobertura</Format>
          <CodeCoverage>
            <ModulePaths>
              <Include>
${modules}
              </Include>
            </ModulePaths>
            <Sources>
              <Exclude>
                <Source>.*[\\/]obj[\\/].*</Source>
                <Source>.*\\.g\\.cs$</Source>
                <Source>.*\\.Designer\\.cs$</Source>
              </Exclude>
            </Sources>
            <Attributes>
              <Exclude>
                <Attribute>^System\\.CodeDom\\.Compiler\\.GeneratedCodeAttribute$</Attribute>
                <Attribute>^System\\.Diagnostics\\.DebuggerHiddenAttribute$</Attribute>
                <Attribute>^System\\.Diagnostics\\.DebuggerNonUserCodeAttribute$</Attribute>
                <Attribute>^System\\.Diagnostics\\.CodeAnalysis\\.ExcludeFromCodeCoverageAttribute$</Attribute>
              </Exclude>
            </Attributes>
          </CodeCoverage>
        </Configuration>
      </DataCollector>
    </DataCollectors>
  </DataCollectionRunSettings>
</RunSettings>
`;
}

/** Arguments for one Microsoft.Testing.Platform test host (a test project's own executable). */
export function testHostArgs(opts: { coverageSettings?: string; resultsDir: string }): string[] {
  return [
    '--results-directory', opts.resultsDir,
    '--report-xunit-trx', '--coverage', '--coverage-output-format', 'cobertura', '--coverage-output', 'coverage.cobertura.xml',
    ...(opts.coverageSettings ? ['--coverage-settings', opts.coverageSettings] : []),
  ];
}

/** Newest built `<assemblyName>.dll` under the project's bin directory that can be launched with `dotnet <dll>`. */
export function findTestHost(projectDir: string, assemblyName: string): string | undefined {
  const bin = join(projectDir, 'bin');
  const hits: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name === `${assemblyName}.dll` && existsSync(join(dir, `${assemblyName}.runtimeconfig.json`))) hits.push(full);
    }
  };
  walk(bin, 0);
  return hits.sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)[0];
}

export interface TestHostProject {
  dir: string;
  assemblyName: string;
  /** The project file, used to ask MSBuild for the real output path when AssemblyName is set through a property. */
  path?: string;
}

async function resolveTestHost(p: TestHostProject, logFile: string): Promise<string | undefined> {
  const found = findTestHost(p.dir, p.assemblyName);
  if (found || !p.path) return found;
  const r = await run('dotnet', ['msbuild', p.path, '-nologo', '-getProperty:TargetPath'], { cwd: p.dir, logFile, timeoutMs: 120_000, env: testEnv });
  const target = r.code === 0 ? r.stdout.trim().split('\n').pop()?.trim() : undefined;
  return target && existsSync(target) ? target : undefined;
}

export interface TestOptions {
  runSettings: string;
  coverageSettings?: string;
  /** When set, the solution uses Microsoft.Testing.Platform: run these projects' test hosts directly. */
  testHosts?: TestHostProject[];
  resultsDir: string;
  logFile: string;
  timeoutMs: number;
}

const testEnv = { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', TESTINGPLATFORM_TELEMETRY_OPTOUT: '1' };

/**
 * `dotnet test` under Microsoft.Testing.Platform launches each host over a named pipe and can report "Zero tests ran"
 * (exit code 5) while the hosts run fine when started directly, so the hosts are run directly and their
 * trx and Cobertura output is merged.
 */
async function runTestHosts(opts: TestOptions & { testHosts: TestHostProject[] }): Promise<{ results: RunResult[]; missing: string[] }> {
  const results: RunResult[] = [];
  const missing: string[] = [];
  const deadline = Date.now() + opts.timeoutMs;
  for (const p of opts.testHosts) {
    const dll = await resolveTestHost(p, opts.logFile);
    if (!dll) {
      missing.push(p.assemblyName);
      continue;
    }
    const resultsDir = join(opts.resultsDir, p.assemblyName);
    mkdirSync(resultsDir, { recursive: true });
    results.push(await run('dotnet', [dll, ...testHostArgs({ coverageSettings: opts.coverageSettings, resultsDir })], { cwd: dirname(dll), logFile: opts.logFile, timeoutMs: Math.max(1000, deadline - Date.now()), env: testEnv }));
  }
  return { results, missing };
}

export async function test(sln: string, opts: TestOptions): Promise<TestRunResult> {
  rmSync(opts.resultsDir, { recursive: true, force: true });
  mkdirSync(opts.resultsDir, { recursive: true });
  let runs: RunResult[];
  let missing: string[] = [];
  if (opts.testHosts) {
    ({ results: runs, missing } = await runTestHosts({ ...opts, testHosts: opts.testHosts }));
  } else {
    runs = [
      await run(
        'dotnet',
        ['test', sln, '--no-build', '--nologo', '--settings', opts.runSettings, '--results-directory', opts.resultsDir, '--logger', 'trx', '--collect', 'Code Coverage'],
        { cwd: dirname(sln), logFile: opts.logFile, timeoutMs: opts.timeoutMs, env: testEnv },
      ),
    ];
  }
  const trxFiles = findFiles(opts.resultsDir, (f) => f.endsWith('.trx'), 4);
  const coberturaFiles = findFiles(opts.resultsDir, (f) => f.endsWith('.cobertura.xml'), 4);
  const summary = mergeTrx(trxFiles);
  const output = runs.map((r) => `${r.stdout}\n${r.stderr}`).join('\n');

  if (runs.some((r) => r.timedOut)) {
    return { ok: false, summary, coberturaFiles, infrastructureError: `dotnet test timed out after ${Math.round(opts.timeoutMs / 60000)} minutes (a test is probably hanging).\n${tail(output, 3000)}` };
  }
  if (missing.length > 0) {
    return { ok: false, summary, coberturaFiles, infrastructureError: `No built test host found under bin/ for: ${missing.join(', ')}. Did the build succeed for those projects?` };
  }
  if (runs.some((r) => r.code !== 0) && summary.failed === 0) {
    // No failing test recorded, yet the run failed: a crashed test host, a missing SDK, or a build problem.
    return { ok: false, summary, coberturaFiles, infrastructureError: tail(output, 4000) };
  }
  return { ok: runs.every((r) => r.code === 0) && summary.failed === 0, summary, coberturaFiles };
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
