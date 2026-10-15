import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parseHarnessReport, type HarnessReport } from './agents/index.ts';
import type { AgentAdapter } from './agents/types.ts';
import type { HarnessConfig } from './config.ts';
import { renderGaps } from './coverage/cobertura.ts';
import { renderFailures } from './dotnet/dotnet.ts';
import { createSolution, findSolution, loadSolution, productionProjects, testProjects, type Solution } from './dotnet/projects.ts';
import { detectStryker, renderSurvivors, runStryker, StrykerProgressTracker, type MutationReport } from './dotnet/stryker.ts';
import { Git } from './git.ts';
import { enforceTestOnlyChanges } from './guard.ts';
import type { ManifestStore, Phase, RepoEntry, RepoStatus } from './manifest.ts';
import { measure, type Measurement } from './measure.ts';
import type { PromptLibrary, PromptName } from './prompts/render.ts';
import { formatDuration, withHeartbeat, type Logger } from './util/log.ts';

type Green = Extract<Measurement, { kind: 'green' }>;

/** Thrown to end a repo's run with a terminal status (blocked, stalled, skipped). */
export class HarnessStop extends Error {
  readonly status: RepoStatus;
  constructor(status: RepoStatus, message: string) {
    super(message);
    this.status = status;
  }
}

const LOCAL_EXCLUDES = ['.coverage-harness/', 'StrykerOutput/', 'TestResults/', 'bin/', 'obj/'];
const MAX_CONSECUTIVE_AGENT_FAILURES = 3;

export class RepoRunner {
  private readonly cfg: HarnessConfig;
  private readonly agent: AgentAdapter;
  private readonly prompts: PromptLibrary;
  private readonly manifest: ManifestStore;
  private readonly repo: string;
  private readonly log: Logger;
  private readonly git: Git;
  private readonly workDir: string;
  private solutionPath = '';
  private agentFailures = 0;

  constructor(cfg: HarnessConfig, agent: AgentAdapter, prompts: PromptLibrary, manifest: ManifestStore, repo: string, log: Logger) {
    this.cfg = cfg;
    this.agent = agent;
    this.prompts = prompts;
    this.manifest = manifest;
    this.repo = repo;
    this.log = log;
    this.git = new Git(repo);
    this.workDir = join(repo, '.coverage-harness');
  }

  private get entry(): RepoEntry {
    return this.manifest.entry(this.repo);
  }

  async run(): Promise<RepoStatus> {
    const started = Date.now();
    this.log.event('repo.start', { path: this.repo, resumeFrom: this.entry.phase, agent: this.agent.name });
    await this.update((e) => {
      e.status = 'in-progress';
      e.startedAt ??= new Date().toISOString();
    });
    try {
      await this.prepare();
      await this.ensureTestProject();
      let green = await this.ensureGreenBaseline();
      green = await this.ensureComponentTests(green);
      green = await this.coverageLoop(green);
      if (this.cfg.skipMutation) {
        this.log.info('Mutation testing skipped (--skip-mutation)');
      } else {
        const report = await this.ensureStryker();
        await this.mutationLoop(green, report);
      }
      await this.update((e) => {
        e.status = 'complete';
        e.phase = 'done';
        e.completedAt = new Date().toISOString();
      });
      this.log.success(`Complete in ${formatDuration(Date.now() - started)}: branch coverage ${this.entry.coverage}%${this.entry.statementCoverage !== undefined ? ` (statement ${this.entry.statementCoverage}%)` : ''}${this.entry.mutationScore !== undefined ? `, mutation score ${this.entry.mutationScore}%` : ''}`);
      this.log.event('repo.end', { status: 'complete', coverage: this.entry.coverage, mutationScore: this.entry.mutationScore, durationMs: Date.now() - started });
      return 'complete';
    } catch (err) {
      const status: RepoStatus = err instanceof HarnessStop ? err.status : 'error';
      const message = err instanceof Error ? err.message : String(err);
      (status === 'error' ? this.log.error : this.log.warn).call(this.log, `${status} after ${formatDuration(Date.now() - started)}: ${message}`);
      this.log.event('repo.end', { status, reason: message, phase: this.entry.phase, coverage: this.entry.coverage, mutationScore: this.entry.mutationScore, durationMs: Date.now() - started });
      await this.update((e) => {
        e.status = status;
        e.notes.push(`${new Date().toISOString()} ${status}: ${message}`);
      });
      return status;
    }
  }

  // ───────────────────────────── phases ─────────────────────────────

  private async prepare(): Promise<void> {
    await this.setPhase('prepare');
    if (!(await this.git.hasCommits())) throw new HarnessStop('blocked', 'repository has no commits');
    // Before the clean check, so harness scratch files (e.g. from `measure`) never count as user changes.
    await this.git.excludeLocally(LOCAL_EXCLUDES);

    const onHarnessBranch = (await this.git.currentBranch()) === this.cfg.branch;
    if (!(await this.git.isClean())) {
      if (!onHarnessBranch) throw new HarnessStop('blocked', `working tree has uncommitted changes on ${await this.git.currentBranch()}; commit or stash them first`);
      // Leftovers from an interrupted iteration on our own branch: resume from the last commit, but stash
      // rather than delete them so nothing an interrupted run produced is ever unrecoverable.
      const message = `coverage-harness: uncommitted work from an interrupted run (${new Date().toISOString()})`;
      await this.git.stashAll(message);
      this.log.warn(`Uncommitted changes left on the harness branch by an interrupted run were stashed ("${message}"); recover with \`git stash list\` / \`git stash pop\``);
      await this.git.resetTo(await this.git.head());
    }
    await this.git.ensureBranch(this.cfg.branch);
    mkdirSync(join(this.workDir, 'logs'), { recursive: true });

    let sln = findSolution(this.repo);
    if (!sln) {
      sln = await createSolution(this.repo);
      if (!sln) throw new HarnessStop('skipped', 'no .NET projects found');
      await this.commit('chore: add solution file for coverage harness');
    }
    this.solutionPath = sln;
    await this.update((e) => {
      e.solution = relative(this.repo, sln);
      e.branch = this.cfg.branch;
    });
    this.log.info(`Solution ${relative(this.repo, sln)} on branch ${this.cfg.branch}`);
  }

  /** Coverage needs no instrumentation package; the only prerequisite is a test project to run. */
  private async ensureTestProject(): Promise<void> {
    const solution = await this.solution();
    if (testProjects(solution).length === 0) await this.createTestProject(solution);
    if (this.cfg.coverageTool === 'coverlet') await this.ensureCoverlet();
  }

  private async ensureCoverlet(): Promise<void> {
    const missing = (s: Solution) => testProjects(s).filter((p) => !p.hasCoverletCollector);
    let solution = await this.solution();
    if (missing(solution).length === 0) return;

    await this.setPhase('test-project');
    this.log.info('coverlet.collector missing from some test projects; dispatching agent to add it');
    const checkpoint = await this.git.head();
    let previousAttempt = '';
    for (let attempt = 1; attempt <= this.cfg.fixAttempts; attempt++) {
      await this.runTask('setup-coverlet', `coverlet-${attempt}`, { projectSummary: this.describeProjects(solution), previousAttempt });
      await this.guard(checkpoint);
      solution = await this.solution();
      const stillMissing = missing(solution);
      if (stillMissing.length > 0) {
        previousAttempt = `## Previous attempt\n\nThe harness re-checked and these test projects still lack coverlet.collector: ${stillMissing.map((p) => p.name).join(', ')}.`;
        continue;
      }
      if (await this.stabilise(checkpoint, 'adding coverlet', `coverlet-${attempt}`)) {
        await this.commit('chore(test): add coverlet coverage instrumentation');
        return;
      }
      previousAttempt = '## Previous attempt\n\nThe solution did not build/test cleanly after your changes, so they were discarded. Try again, more carefully.';
      await this.reset(checkpoint);
    }
    await this.reset(checkpoint);
    throw new HarnessStop('blocked', 'could not add coverlet instrumentation');
  }

  private async createTestProject(initial: Solution): Promise<void> {
    let solution = initial;
    await this.setPhase('test-project');
    this.log.info('No test project found; dispatching agent to create one');
    const checkpoint = await this.git.head();
    let previousAttempt = '';
    for (let attempt = 1; attempt <= this.cfg.fixAttempts; attempt++) {
      await this.runTask('create-test-project', `test-project-${attempt}`, {
        projectSummary: this.describeProjects(solution),
        componentProjectName: this.componentProjectName(solution),
        componentProjectDir: this.componentProjectDir(solution),
        previousAttempt,
      });
      await this.guard(checkpoint);
      solution = await this.solution();
      if (testProjects(solution).length === 0) {
        previousAttempt = '## Previous attempt\n\nThe harness re-checked and still found no test project in the solution.';
        continue;
      }
      const green = await this.stabilise(checkpoint, 'creating the test project', `test-project-${attempt}`);
      if (green) {
        await this.commit('chore(test): add test project');
        return;
      }
      previousAttempt = '## Previous attempt\n\nThe solution did not build/test cleanly after your changes, so they were discarded. Try again, more carefully.';
      await this.reset(checkpoint);
    }
    await this.reset(checkpoint);
    throw new HarnessStop('blocked', 'could not create a test project');
  }

  private async ensureGreenBaseline(): Promise<Green> {
    await this.setPhase('baseline');
    const checkpoint = await this.git.head();
    const green = await this.stabilise(checkpoint, 'establishing the baseline', 'baseline');
    if (!green) {
      await this.reset(checkpoint);
      throw new HarnessStop('blocked', 'the solution does not build or its existing tests fail, and the agent could not repair the tests');
    }
    if (await this.git.changedFiles(checkpoint).then((f) => f.length > 0)) await this.commit('test: repair failing tests before raising coverage');
    await this.update((e) => {
      // Manifests from before the switch to branch coverage hold a statement-coverage baseline; restart it.
      if (e.coverageMetric !== 'branch' || (e.coverageTool && e.coverageTool !== this.cfg.coverageTool)) e.baselineCoverage = undefined;
      e.coverageTool = this.cfg.coverageTool;
      e.baselineCoverage ??= green.coverage.branchPercent;
    });
    await this.recordCoverage(green, 'baseline', 0, 'baseline measured');
    return green;
  }

  private async ensureComponentTests(current: Green): Promise<Green> {
    if (testProjects(current.solution).some((p) => p.hasComponentTests)) return current;

    await this.setPhase('scaffold');
    this.log.info('No component tests found; dispatching agent to scaffold the outside-in harness');
    let previousAttempt = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const checkpoint = await this.git.head();
      await this.runTask('scaffold-component-tests', `scaffold-${attempt}`, {
        coverage: current.coverage.branchPercent,
        target: this.cfg.target,
        projectSummary: this.describeProjects(current.solution),
        componentProjectName: this.componentProjectName(current.solution),
        componentProjectDir: this.componentProjectDir(current.solution),
        previousAttempt,
      });
      await this.guard(checkpoint);
      const green = await this.stabilise(checkpoint, 'scaffolding component tests', `scaffold-${attempt}`);
      if (green && testProjects(green.solution).some((p) => p.hasComponentTests)) {
        await this.commit(`test: scaffold outside-in component tests (coverage ${current.coverage.branchPercent}% → ${green.coverage.branchPercent}%)`);
        await this.recordCoverage(green, 'scaffold', attempt, 'component test harness scaffolded');
        return green;
      }
      await this.reset(checkpoint);
      previousAttempt = green
        ? '## Previous attempt\n\nThe harness could not find a component test project (a test project named `*.ComponentTests` or one using `WebApplicationFactory`). Your changes were discarded.'
        : '## Previous attempt\n\nThe solution did not build or tests did not pass after your changes, so they were discarded.';
    }
    throw new HarnessStop('blocked', 'could not scaffold component tests');
  }

  private async coverageLoop(start: Green): Promise<Green> {
    let best = start;
    let stalls = 0;
    if (best.coverage.branchPercent >= this.cfg.target) return best;
    await this.setPhase('coverage');

    while (best.coverage.branchPercent < this.cfg.target) {
      const iteration = this.entry.iterations.coverage + 1;
      if (iteration > this.cfg.maxCoverageIterations) throw new HarnessStop('stalled', `reached ${this.cfg.maxCoverageIterations} coverage iterations at ${best.coverage.branchPercent}%`);
      await this.update((e) => {
        e.iterations.coverage = iteration;
      });
      const label = `coverage-${iteration}`;
      const checkpoint = await this.git.head();
      const iterationStarted = Date.now();
      this.log.info(`── Coverage iteration ${iteration}/${this.cfg.maxCoverageIterations}: ${best.coverage.branchPercent}% → target ${this.cfg.target}% (${best.coverage.branchCoverable - best.coverage.branchCovered} branches unexercised; statement coverage ${best.coverage.statementPercent}%)`);
      this.log.event('iteration.start', { phase: 'coverage', iteration, coverage: best.coverage.branchPercent, statementCoverage: best.coverage.statementPercent, target: this.cfg.target, uncovered: best.coverage.branchCoverable - best.coverage.branchCovered, checkpoint });

      const report = await this.runTask('raise-coverage', label, {
        iteration,
        coverage: best.coverage.branchPercent,
        statementCoverage: best.coverage.statementPercent,
        target: this.cfg.target,
        componentProjects: testProjects(best.solution).filter((p) => p.hasComponentTests).map((p) => `\`${relative(this.repo, p.path)}\``).join(', ') || '(none detected)',
        gaps: renderGaps(best.coverage, 15),
        history: this.renderHistory('coverage'),
      });
      await this.guard(checkpoint);
      const next = await this.stabilise(checkpoint, `coverage iteration ${iteration}`, label);

      let outcome: string;
      if (!next) {
        await this.reset(checkpoint);
        stalls++;
        outcome = 'reverted: tests could not be made green';
      } else if (next.coverage.branchPercent < best.coverage.branchPercent) {
        await this.reset(checkpoint);
        stalls++;
        outcome = `reverted: coverage fell from ${best.coverage.branchPercent}% to ${next.coverage.branchPercent}%`;
      } else {
        const improved = next.coverage.branchCovered > best.coverage.branchCovered || next.coverage.branchPercent > best.coverage.branchPercent;
        const sha = await this.commit(
          improved
            ? `test: raise branch coverage ${best.coverage.branchPercent}% → ${next.coverage.branchPercent}% (statements ${best.coverage.statementPercent}% → ${next.coverage.statementPercent}%)`
            : `test: add component tests (branch coverage unchanged at ${next.coverage.branchPercent}%)`,
        );
        outcome = improved ? `committed: branches ${best.coverage.branchPercent}% → ${next.coverage.branchPercent}%, statements ${best.coverage.statementPercent}% → ${next.coverage.statementPercent}%` : sha ? 'committed: no coverage gain' : 'no changes made';
        stalls = improved ? 0 : stalls + 1;
        best = next;
      }
      this.noteReport(report);
      await this.recordCoverage(best, 'coverage', iteration, outcome);
      this.log.info(`── Coverage iteration ${iteration} finished in ${formatDuration(Date.now() - iterationStarted)}: ${outcome} (target ${this.cfg.target}%, stalls ${stalls}/${this.cfg.stallLimit})`);
      this.log.event('iteration.end', { phase: 'coverage', iteration, outcome, coverage: best.coverage.branchPercent, statementCoverage: best.coverage.statementPercent, stalls, durationMs: Date.now() - iterationStarted });
      if (stalls >= this.cfg.stallLimit) throw new HarnessStop('stalled', `no coverage progress in ${stalls} consecutive iterations at ${best.coverage.branchPercent}%`);
    }
    this.log.success(`Branch coverage target met: ${best.coverage.branchPercent}% ≥ ${this.cfg.target}% (statement coverage ${best.coverage.statementPercent}%)`);
    return best;
  }

  private async ensureStryker(): Promise<MutationReport> {
    await this.setPhase('stryker-setup');
    const solution = await this.solution();
    let setup = detectStryker(this.repo);
    if (setup.toolInstalled && setup.configFile) {
      const r = await this.mutationRun('mutation-0');
      if (r.report) return r.report;
      this.log.warn('Existing Stryker configuration failed to run; asking the agent to repair it');
    }

    const checkpoint = await this.git.head();
    let previousAttempt = '';
    for (let attempt = 1; attempt <= this.cfg.fixAttempts; attempt++) {
      await this.runTask('setup-stryker', `stryker-setup-${attempt}`, {
        coverage: this.entry.coverage ?? 0,
        testProjects: testProjects(solution).map((p) => `\`${relative(this.repo, p.path)}\``).join(', '),
        mutationTarget: this.cfg.mutationTarget,
        previousAttempt,
      });
      await this.guard(checkpoint);
      setup = detectStryker(this.repo);
      if (!setup.toolInstalled || !setup.configFile) {
        previousAttempt = `## Previous attempt\n\nThe harness could not find ${!setup.toolInstalled ? '`dotnet-stryker` in `.config/dotnet-tools.json`' : '`stryker-config.json` at the repository root'}.`;
        continue;
      }
      const r = await this.mutationRun(`mutation-setup-${attempt}`);
      if (r.report) {
        await this.commit('chore(test): configure Stryker.NET mutation testing');
        return r.report;
      }
      previousAttempt = `## Previous attempt\n\nThe harness ran Stryker with your configuration and it failed:\n\n\`\`\`\n${r.error}\n\`\`\``;
    }
    await this.reset(checkpoint);
    throw new HarnessStop('blocked', 'could not configure Stryker.NET');
  }

  private async mutationLoop(green: Green, initial: MutationReport): Promise<void> {
    let best = initial;
    let coverage = green;
    let stalls = 0;
    await this.recordMutation(best, 0, 'initial mutation run');
    await this.setPhase('mutation');

    while (best.score < this.cfg.mutationTarget) {
      const iteration = this.entry.iterations.mutation + 1;
      if (iteration > this.cfg.maxMutationIterations) throw new HarnessStop('stalled', `reached ${this.cfg.maxMutationIterations} mutation iterations at ${best.score}%`);
      await this.update((e) => {
        e.iterations.mutation = iteration;
      });
      const label = `mutation-${iteration}`;
      this.writeSurvivors(best);
      const checkpoint = await this.git.head();
      const iterationStarted = Date.now();
      this.log.info(`── Mutation iteration ${iteration}/${this.cfg.maxMutationIterations}: ${best.score}% → target ${this.cfg.mutationTarget}% (${best.survivors.length} surviving mutants)`);
      this.log.event('iteration.start', { phase: 'mutation', iteration, mutationScore: best.score, target: this.cfg.mutationTarget, survivors: best.survivors.length, checkpoint });

      const report = await this.runTask('kill-mutants', label, {
        iteration,
        mutationScore: best.score,
        mutationTarget: this.cfg.mutationTarget,
        coverage: coverage.coverage.branchPercent,
        target: this.cfg.target,
        survivors: renderSurvivors(best, 40),
        history: this.renderHistory('mutation'),
      });
      await this.guard(checkpoint);
      const next = await this.stabilise(checkpoint, `mutation iteration ${iteration}`, label);

      let outcome: string;
      if (!next) {
        await this.reset(checkpoint);
        stalls++;
        outcome = 'reverted: tests could not be made green';
      } else if (next.coverage.branchPercent < Math.min(this.cfg.target, coverage.coverage.branchPercent)) {
        await this.reset(checkpoint);
        stalls++;
        outcome = `reverted: branch coverage fell to ${next.coverage.branchPercent}%`;
      } else {
        const run = await this.mutationRun(label);
        if (!run.report) {
          await this.reset(checkpoint);
          stalls++;
          outcome = `reverted: Stryker failed (${run.error?.split('\n')[0]})`;
        } else if (run.report.score < best.score) {
          await this.reset(checkpoint);
          stalls++;
          outcome = `reverted: mutation score fell from ${best.score}% to ${run.report.score}%`;
        } else {
          const improved = run.report.score > best.score;
          await this.commit(improved ? `test: raise mutation score ${best.score}% → ${run.report.score}%` : `test: strengthen assertions (mutation score unchanged at ${run.report.score}%)`);
          outcome = improved ? `committed: ${best.score}% → ${run.report.score}%` : 'committed: no mutation score gain';
          stalls = improved ? 0 : stalls + 1;
          best = run.report;
          coverage = next;
          await this.recordCoverage(next, 'mutation', iteration, 'coverage re-measured');
        }
      }
      this.noteReport(report);
      await this.recordMutation(best, iteration, outcome);
      this.log.info(`── Mutation iteration ${iteration} finished in ${formatDuration(Date.now() - iterationStarted)}: ${outcome} (target ${this.cfg.mutationTarget}%, stalls ${stalls}/${this.cfg.stallLimit})`);
      this.log.event('iteration.end', { phase: 'mutation', iteration, outcome, mutationScore: best.score, coverage: coverage.coverage.branchPercent, stalls, durationMs: Date.now() - iterationStarted });
      if (stalls >= this.cfg.stallLimit) throw new HarnessStop('stalled', `no mutation score progress in ${stalls} consecutive iterations at ${best.score}%`);
    }
    this.log.success(`Mutation score target met: ${best.score}% ≥ ${this.cfg.mutationTarget}%`);
  }

  // ───────────────────────────── building blocks ─────────────────────────────

  /**
   * Measure; while red, hand the failure to the agent (fix-build / fix-tests) and re-measure.
   * Returns the green measurement, or undefined if still red after `fixAttempts` prompts.
   */
  private async stabilise(checkpoint: string, context: string, label: string): Promise<Green | undefined> {
    let m = await this.measure(label);
    for (let attempt = 1; m.kind !== 'green' && attempt <= this.cfg.fixAttempts; attempt++) {
      const fixLabel = `${label}-fix-${attempt}`;
      this.log.warn(`Red after ${context} (${m.kind}); fix attempt ${attempt}/${this.cfg.fixAttempts}`);
      this.log.event('fix.start', { label: fixLabel, attempt, of: this.cfg.fixAttempts, cause: m.kind });
      if (m.kind === 'build-failed') {
        await this.runTask('fix-build', fixLabel, { context, errors: m.errors.slice(0, 60).join('\n'), notes: this.lastGuardNote });
      } else {
        await this.runTask('fix-tests', fixLabel, {
          context,
          failures: m.infrastructureError ? `The test run failed without recording a failing test:\n\n\`\`\`\n${m.infrastructureError.slice(-3000)}\n\`\`\`` : renderFailures(m.tests, 15),
          notes: this.lastGuardNote,
        });
      }
      await this.guard(checkpoint);
      m = await this.measure(fixLabel);
    }
    return m.kind === 'green' ? m : undefined;
  }

  private lastGuardNote = '';

  private async guard(checkpoint: string): Promise<void> {
    const { reverted } = await enforceTestOnlyChanges(this.git, this.repo, checkpoint);
    this.lastGuardNote = '';
    if (reverted.length) {
      this.log.warn(`Reverted ${reverted.length} non-test change(s): ${reverted.join(', ')}`);
      this.log.event('guard.revert', { files: reverted });
      this.lastGuardNote = `## Changes reverted by the harness\n\nThese files are outside the test projects, so your changes to them were reverted: ${reverted.map((f) => `\`${f}\``).join(', ')}. Make the tests work without modifying production code.`;
    }
  }

  private measure(label: string): Promise<Measurement> {
    return measure({ repo: this.repo, solutionPath: this.solutionPath, workDir: this.workDir, buildTimeoutMs: this.cfg.buildTimeoutMs, testTimeoutMs: this.cfg.testTimeoutMs, coverageTool: this.cfg.coverageTool, log: this.log, heartbeatMs: this.cfg.heartbeatMs }, label);
  }

  private async mutationRun(label: string) {
    const setup = detectStryker(this.repo);
    this.log.info(`[${label}] dotnet stryker (this can take a long time; ${this.cfg.strykerConcurrency} parallel runners)`);
    const started = Date.now();
    const tracker = new StrykerProgressTracker();
    let lastMilestone = 0;
    const onChunk = (chunk: string) => {
      tracker.push(chunk);
      const { tested, total } = tracker.progress;
      const milestone = total ? Math.floor((tested / total) * 10) : 0;
      if (milestone > lastMilestone) {
        lastMilestone = milestone;
        this.log.info(`[${label}] ${tracker.describe()}`);
        this.log.event('stryker.progress', { label, ...tracker.progress });
      }
    };
    const r = await withHeartbeat(
      this.log,
      `[${label}] dotnet stryker`,
      this.cfg.heartbeatMs,
      () => runStryker(this.repo, setup.configFile!, join(this.workDir, 'stryker', label), join(this.workDir, 'logs', `${label}.stryker.log`), this.cfg.strykerTimeoutMs, this.cfg.strykerConcurrency, onChunk),
      () => {
        const text = tracker.describe();
        return text ? { at: Date.now(), text } : undefined;
      },
    );
    this.log.event('stryker', {
      label,
      ok: Boolean(r.report),
      score: r.report?.score,
      killed: r.report?.killed,
      survived: r.report?.survived,
      noCoverage: r.report?.noCoverage,
      timeout: r.report?.timeout,
      error: r.error?.split('\n')[0],
      durationMs: Date.now() - started,
    });
    if (r.report) this.log.info(`[${label}] mutation score ${r.report.score}% (${r.report.survived} survived, ${r.report.noCoverage} no coverage)`);
    else this.log.warn(`[${label}] Stryker failed: ${r.error?.split('\n')[0]}`);
    return r;
  }

  /**
   * Send one task to the agent and handle the conversation: if it stops without a report, nudge it
   * to continue; if it asks a question, answer it with the unattended-mode policy. Same session throughout.
   */
  private async runTask(name: PromptName, label: string, vars: Record<string, string | number>): Promise<HarnessReport | undefined> {
    const base = { repoPath: this.repo, solution: relative(this.repo, this.solutionPath) || basename(this.solutionPath) };
    let prompt = this.prompts.render(name, { ...base, ...vars });
    let sessionId: string | undefined;
    let report: HarnessReport | undefined;

    for (let turn = 0; turn <= this.cfg.followUps; turn++) {
      const turnLabel = turn === 0 ? label : `${label}-followup-${turn}`;
      writeFileSync(join(this.workDir, 'logs', `${turnLabel}.prompt.md`), prompt);
      this.log.info(`→ ${this.agent.name}: ${name} (${turnLabel})`);
      this.log.event('agent.start', { task: name, label: turnLabel, turn, agent: this.agent.name, sessionId, promptChars: prompt.length });
      let lastActivity: { at: number; text: string } | undefined;
      let activityCount = 0;
      const result = await withHeartbeat(this.log, `${this.agent.name} ${name} (${turnLabel})`, this.cfg.heartbeatMs, () => this.agent.invoke({
        cwd: this.repo,
        prompt,
        logFile: join(this.workDir, 'logs', `${turnLabel}.agent.log`),
        timeoutMs: this.cfg.agentTimeoutMs,
        idleTimeoutMs: this.cfg.agentIdleTimeoutMs,
        model: this.cfg.model,
        sessionId,
        onEvent: (e) => {
          lastActivity = { at: Date.now(), text: e };
          activityCount++;
          this.log.debug(`  ${e}`);
        },
      }), () => lastActivity);
      this.log.event('agent.end', {
        task: name,
        label: turnLabel,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        idledOut: result.idledOut,
        sessionId: result.sessionId,
        events: activityCount,
        report: parseHarnessReport(result.finalText),
        error: result.error?.slice(0, 500),
        durationMs: result.durationMs,
      });
      await this.update((e) => {
        e.agentInvocations++;
      });
      sessionId = result.sessionId ?? sessionId;
      const took = formatDuration(result.durationMs);

      if (result.timedOut || result.idledOut) {
        this.log.warn(`← ${this.agent.name} ${result.timedOut ? 'timed out' : 'went idle'} after ${took}; measuring whatever it left`);
        return report;
      }
      if (result.exitCode !== 0 && !result.finalText.trim()) {
        this.agentFailures++;
        this.log.warn(`← ${this.agent.name} failed (exit ${result.exitCode}): ${result.error ?? 'no output'}`);
        if (this.agentFailures >= MAX_CONSECUTIVE_AGENT_FAILURES) {
          throw new HarnessStop('error', `${this.agent.name} failed ${this.agentFailures} times in a row (last: ${result.error ?? `exit ${result.exitCode}`}); check the CLI is installed and authenticated`);
        }
        return report;
      }
      this.agentFailures = 0;

      report = parseHarnessReport(result.finalText);
      this.log.info(`← ${this.agent.name} after ${took}: ${report ? `${report.status}: ${report.summary}` : 'no report block'}`);
      if (report && report.status !== 'needs-input') return report;
      if (!sessionId) return report;
      prompt = report?.status === 'needs-input' ? this.prompts.render('answer', { ...base, question: report.question ?? report.summary }) : this.prompts.render('continue', base);
    }
    return report;
  }

  private noteReport(report: HarnessReport | undefined): void {
    if (!report) return;
    const notes: string[] = [];
    if (report.status === 'blocked') notes.push(`agent blocked: ${report.blockers ?? report.summary}`);
    for (const u of report.unreachable ?? []) notes.push(`unreachable (agent): ${u}`);
    for (const m of report.equivalentMutants ?? []) notes.push(`equivalent mutant (agent): ${m}`);
    if (notes.length) void this.update((e) => e.notes.push(...notes));
  }

  private async commit(message: string): Promise<string | undefined> {
    const sha = await this.git.commitAll(`${message}\n\nGenerated by dotnet-coverage-harness using ${this.agent.name}.`);
    if (sha) {
      this.log.info(`Committed ${sha.slice(0, 8)} ${message}`);
      this.log.event('commit', { sha, message });
    }
    return sha;
  }

  private async reset(checkpoint: string): Promise<void> {
    const discarded = await this.git.changedFiles(checkpoint);
    await this.git.resetTo(checkpoint);
    this.log.warn(`Reset to ${checkpoint.slice(0, 8)}, discarding ${discarded.length} changed file(s)`);
    this.log.event('reset', { to: checkpoint, discarded });
  }

  private async solution(): Promise<Solution> {
    return loadSolution(this.solutionPath, this.repo);
  }

  private writeSurvivors(report: MutationReport): void {
    writeFileSync(join(this.workDir, 'surviving-mutants.md'), `# Surviving mutants\n\n${renderSurvivors(report, 1000)}\n`);
    writeFileSync(join(this.workDir, 'surviving-mutants.json'), JSON.stringify(report.survivors, null, 2));
  }

  private describeProjects(s: Solution): string {
    const line = (p: Solution['projects'][number]) => {
      const tags = [p.isWeb ? 'ASP.NET Core' : p.isExecutable ? 'executable' : 'library'];
      if (p.isTest) tags.splice(0, 1, 'test', p.hasCoverletCollector ? 'coverlet.collector ✓' : 'coverlet.collector ✗');
      if (p.hasComponentTests) tags.push('component tests');
      return `- \`${relative(this.repo, p.path)}\` (${tags.join(', ')})`;
    };
    const prod = productionProjects(s);
    const tests = testProjects(s);
    return [`Production projects:`, ...(prod.length ? prod.map(line) : ['- (none)']), '', `Test projects:`, ...(tests.length ? tests.map(line) : ['- (none)'])].join('\n');
  }

  private appName(s: Solution): string {
    const entry = productionProjects(s).find((p) => p.isWeb) ?? productionProjects(s).find((p) => p.isExecutable) ?? productionProjects(s)[0];
    return entry?.name ?? basename(this.repo);
  }

  private componentProjectName(s: Solution): string {
    return `${this.appName(s)}.ComponentTests`;
  }

  private componentProjectDir(s: Solution): string {
    return `tests/${this.componentProjectName(s)}`;
  }

  private renderHistory(phase: Phase): string {
    const recent = this.entry.history.filter((h) => h.phase === phase && h.iteration > 0 && (phase !== 'coverage' || h.metric === 'branch')).slice(-6);
    if (recent.length === 0) return '';
    return ['## Previous iterations', '', ...recent.map((h) => `- Iteration ${h.iteration}: ${h.outcome}`), '', 'Learn from reverted iterations: they were discarded because the suite was red or a number went down.'].join('\n');
  }

  private async setPhase(phase: Phase): Promise<void> {
    if (this.entry.phase !== phase) this.log.info(`▶ phase: ${phase}`);
    this.log.event('phase', { phase });
    await this.update((e) => {
      e.phase = phase;
    });
  }

  private async recordCoverage(m: Green, phase: Phase, iteration: number, outcome: string): Promise<void> {
    await this.update((e) => {
      e.coverage = m.coverage.branchPercent;
      e.statementCoverage = m.coverage.statementPercent;
      e.coverageMetric = 'branch';
      e.history.push({ at: new Date().toISOString(), phase, iteration, outcome, coverage: m.coverage.branchPercent, statementCoverage: m.coverage.statementPercent, metric: 'branch' });
    });
  }

  private async recordMutation(r: MutationReport, iteration: number, outcome: string): Promise<void> {
    await this.update((e) => {
      e.mutationScore = r.score;
      e.history.push({ at: new Date().toISOString(), phase: 'mutation', iteration, outcome, mutationScore: r.score, coverage: e.coverage });
    });
  }

  private update(mutate: (e: RepoEntry) => void): Promise<void> {
    return this.manifest.update(this.repo, mutate);
  }
}
