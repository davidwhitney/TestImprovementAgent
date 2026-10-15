import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCoverage, renderGaps, type CoverageReport } from './coverage/cobertura.ts';
import { build, renderFailures, test, writeRunSettings, type CoverageTool } from './dotnet/dotnet.ts';
import { entryPointFiles, loadSolution, productionProjects, testProjects, type Solution } from './dotnet/projects.ts';
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
  coverageTool: CoverageTool;
  log: Logger;
  /** Log a "still running" line this often during build/test (0 disables). */
  heartbeatMs?: number;
}

/**
 * The deterministic core: build, test with the built-in code coverage collector, merge Cobertura, and write the agent-facing
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
  writeRunSettings(runSettings, opts.coverageTool, {
    production: productionProjects(solution).map((p) => p.assemblyName),
    test: testProjects(solution).map((p) => p.assemblyName),
  });
  log.info(`[${label}] dotnet test (${opts.coverageTool} coverage)`);
  const t = await withHeartbeat(log, `[${label}] dotnet test`, heartbeat, () =>
    test(opts.solutionPath, { tool: opts.coverageTool, runSettings, resultsDir: join(workDir, 'runs', label), logFile, timeoutMs: opts.testTimeoutMs }),
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

  if (t.coberturaFiles.length === 0) {
    const infrastructureError = `dotnet test passed but produced no Cobertura coverage report. Every test project needs ${opts.coverageTool === 'coverlet' ? 'the coverlet.collector package' : 'a recent Microsoft.NET.Test.Sdk (17.x or later), which carries the code coverage collector'}, and the production assemblies must be built with symbols (DebugType portable or full).`;
    log.event('measure', { label, result: 'tests-failed', infrastructureError, durationMs: Date.now() - started });
    writeFileSync(join(workDir, 'failing-tests.md'), `# Failing tests\n\n\`\`\`\n${infrastructureError}\n\`\`\`\n`);
    log.warn(`[${label}] no coverage report produced`);
    return { kind: 'tests-failed', tests: t.summary, infrastructureError, solution };
  }

  const coverage = loadCoverage(t.coberturaFiles, repo, entryPointFiles(solution));
  writeFileSync(join(workDir, 'coverage-gaps.md'), `# Coverage gaps\n\n${renderGaps(coverage, 200)}\n`);
  writeFileSync(
    join(workDir, 'coverage-summary.json'),
    JSON.stringify(
      {
        branchPercent: coverage.branchPercent,
        branchCovered: coverage.branchCovered,
        branchCoverable: coverage.branchCoverable,
        statementPercent: coverage.statementPercent,
        statementCovered: coverage.statementCovered,
        statementCoverable: coverage.statementCoverable,
        excludedFiles: coverage.excludedFiles,
        files: coverage.files.map((f) => ({ path: f.relPath, branchCovered: f.branchCovered, branchCoverable: f.branchCoverable, missingBranchesByMethod: f.missingBranchesByMethod, statementCovered: f.covered, statementCoverable: f.coverable, uncoveredByMethod: f.uncoveredByMethod })),
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
    coverage: coverage.branchPercent,
    branchCovered: coverage.branchCovered,
    branchCoverable: coverage.branchCoverable,
    statementCoverage: coverage.statementPercent,
    durationMs: Date.now() - started,
  });
  log.info(`[${label}] ${t.summary.passed}/${t.summary.total} tests passed; branch coverage ${coverage.branchPercent}% (${coverage.branchCovered}/${coverage.branchCoverable}), statement ${coverage.statementPercent}%`);
  return { kind: 'green', tests: t.summary, coverage, solution };
}
