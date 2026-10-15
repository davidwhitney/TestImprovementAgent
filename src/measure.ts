import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCoverage, renderGaps, type CoverageReport } from './coverage/cobertura.ts';
import { build, renderFailures, test, writeRunSettings } from './dotnet/dotnet.ts';
import { entryPointFiles, loadSolution, testProjects, type Solution } from './dotnet/projects.ts';
import type { TestSummary } from './dotnet/trx.ts';
import { withHeartbeat, type Logger } from './util/log.ts';

export type Measurement =
  | { kind: 'green'; tests: TestSummary; coverage: CoverageReport; solution: Solution }
  | { kind: 'build-failed'; errors: string[]; solution: Solution }
  | { kind: 'tests-failed'; tests: TestSummary; infrastructureError?: string; solution: Solution };

export interface MeasureOptions {
  repo: string;
  solutionPath: string;
  workDir: string;
  buildTimeoutMs: number;
  testTimeoutMs: number;
  log: Logger;
  /** Log a "still running" line this often during build/test (0 disables). */
  heartbeatMs?: number;
}

/**
 * The deterministic core: build, test with coverlet, merge Cobertura, and write the agent-facing
 * reports into `.coverage-harness/`. Nothing here involves an agent.
 */
export async function measure(opts: MeasureOptions, label: string): Promise<Measurement> {
  const { repo, workDir, log } = opts;
  const started = Date.now();
  const heartbeat = opts.heartbeatMs ?? 0;
  mkdirSync(workDir, { recursive: true });
  const solution = await loadSolution(opts.solutionPath, repo);
  const logFile = join(workDir, 'logs', `${label}.dotnet.log`);

  log.info(`[${label}] dotnet build`);
  const b = await withHeartbeat(log, `[${label}] dotnet build`, heartbeat, () => build(opts.solutionPath, logFile, opts.buildTimeoutMs));
  if (!b.ok) {
    log.event('measure', { label, result: 'build-failed', errors: b.errors.length, firstError: b.errors[0], durationMs: Date.now() - started });
    writeFileSync(join(workDir, 'build-errors.md'), `# Build errors\n\n\`\`\`\n${b.errors.join('\n')}\n\`\`\`\n`);
    log.warn(`[${label}] build failed with ${b.errors.length} error(s)`);
    return { kind: 'build-failed', errors: b.errors, solution };
  }

  const runSettings = join(workDir, 'coverage.runsettings');
  writeRunSettings(runSettings, testProjects(solution).map((p) => p.assemblyName));
  log.info(`[${label}] dotnet test (coverlet)`);
  const t = await withHeartbeat(log, `[${label}] dotnet test`, heartbeat, () =>
    test(opts.solutionPath, { runSettings, resultsDir: join(workDir, 'runs', label), logFile, timeoutMs: opts.testTimeoutMs }),
  );
  if (!t.ok) {
    log.event('measure', {
      label,
      result: 'tests-failed',
      total: t.summary.total,
      failed: t.summary.failed,
      failingTests: t.summary.failures.slice(0, 20).map((f) => f.name),
      infrastructureError: t.infrastructureError ? t.infrastructureError.slice(-500) : undefined,
      durationMs: Date.now() - started,
    });
    const body = t.infrastructureError ? `Test run failed without a test failure being recorded:\n\n\`\`\`\n${t.infrastructureError}\n\`\`\`` : renderFailures(t.summary, 200);
    writeFileSync(join(workDir, 'failing-tests.md'), `# Failing tests\n\n${body}\n`);
    log.warn(`[${label}] tests failed: ${t.summary.failed}/${t.summary.total}${t.infrastructureError ? ' (infrastructure error)' : ''}`);
    return { kind: 'tests-failed', tests: t.summary, infrastructureError: t.infrastructureError, solution };
  }

  const coverage = loadCoverage(t.coberturaFiles, repo, entryPointFiles(solution));
  writeFileSync(join(workDir, 'coverage-gaps.md'), `# Coverage gaps\n\n${renderGaps(coverage, 200)}\n`);
  writeFileSync(
    join(workDir, 'coverage-summary.json'),
    JSON.stringify(
      {
        percent: coverage.percent,
        branchPercent: coverage.branchPercent,
        covered: coverage.covered,
        coverable: coverage.coverable,
        excludedFiles: coverage.excludedFiles,
        files: coverage.files.map((f) => ({ path: f.relPath, covered: f.covered, coverable: f.coverable, uncoveredByMethod: f.uncoveredByMethod })),
      },
      null,
      2,
    ),
  );
  log.event('measure', {
    label,
    result: 'green',
    total: t.summary.total,
    passed: t.summary.passed,
    coverage: coverage.percent,
    covered: coverage.covered,
    coverable: coverage.coverable,
    branchCoverage: coverage.branchPercent,
    durationMs: Date.now() - started,
  });
  log.info(`[${label}] ${t.summary.passed}/${t.summary.total} tests passed; statement coverage ${coverage.percent}% (${coverage.covered}/${coverage.coverable}), branch ${coverage.branchPercent}%`);
  return { kind: 'green', tests: t.summary, coverage, solution };
}
