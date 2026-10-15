import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AGENT_NAMES, createAgent } from './agents/index.ts';
import type { AgentName } from './agents/types.ts';
import { DEFAULTS, type HarnessConfig } from './config.ts';
import { applyEnvDefaults, envNameFor, loadDotEnv } from './env.ts';
import { findSolution } from './dotnet/projects.ts';
import { defaultManifestPath, discoverRepos, ManifestStore, type RepoEntry } from './manifest.ts';
import { measure } from './measure.ts';
import { PromptLibrary } from './prompts/render.ts';
import { RepoRunner } from './repo-runner.ts';
import { run, killAllChildren } from './util/exec.ts';
import { formatDuration, Logger } from './util/log.ts';

const HELP = `coverage-harness — drive agentic coding CLIs to raise .NET test coverage and mutation score

Usage:
  coverage-harness [run] --src <path> --target <percent> [options]
  coverage-harness discover --src <path>          write/refresh the manifest only
  coverage-harness measure --src <repo>           build + test + coverage, no agent
  coverage-harness status [--manifest <file>]     print the manifest

Required:
  --src <path>                 /abs/dir/* for every git repo in dir, or /abs/repo for one repo
  --target <percent>           statement coverage to reach (e.g. 100)

Options:
  --agent <claude|opencode|copilot>   agent CLI to drive (default ${DEFAULTS.agent})
  --agent-binary <path>        override the agent executable
  --model <name>               model passed to the agent CLI
  --mutation-target <percent>  mutation score to reach (default ${DEFAULTS.mutationTarget})
  --skip-mutation              stop once coverage is met
  --manifest <file>            manifest path (default <src dir>/coverage-harness.manifest.json)
  --prompts <dir>              directory of prompt overrides (same file names as ./prompts)
  --branch <name>              work branch created in each repo (default ${DEFAULTS.branch})
  --concurrency <n>            repos processed in parallel (default ${DEFAULTS.concurrency})
  --retry                      also re-run repos marked blocked, stalled or error
  --max-iterations <n>         coverage iterations per repo (default ${DEFAULTS.maxCoverageIterations})
  --max-mutation-iterations <n> (default ${DEFAULTS.maxMutationIterations})
  --stall-limit <n>            consecutive non-improving iterations before giving up (default ${DEFAULTS.stallLimit})
  --fix-attempts <n>           fix prompts per red build/test before reverting (default ${DEFAULTS.fixAttempts})
  --agent-timeout <minutes>    (default ${DEFAULTS.agentTimeoutMinutes})
  --agent-idle-timeout <minutes> kill an agent that prints nothing for this long (default ${DEFAULTS.agentIdleTimeoutMinutes})
  --test-timeout <minutes>     (default ${DEFAULTS.testTimeoutMinutes})
  --stryker-timeout <minutes>  (default ${DEFAULTS.strykerTimeoutMinutes})
  --heartbeat <minutes>        log a "still running" line during long steps (default ${DEFAULTS.heartbeatMinutes}, 0 = off)
  --verbose                    also stream agent activity (tool calls, messages) to the console
  --env-file <path>            load settings from this file instead of ./.env

Environment / .env:
  Every option can also be set as COVERAGE_HARNESS_<OPTION> (e.g. ${envNameFor('max-iterations')}=60,
  ${envNameFor('skip-mutation')}=true). ./.env is loaded automatically if present.
  Precedence: command-line flag > environment variable > .env file > default.
  Other variables in .env (API keys, tokens) are passed through to the agent CLIs.

Logs (all written regardless of --verbose):
  <manifest dir>/coverage-harness.log            run-wide, human readable: tail -f it
  <manifest dir>/coverage-harness.events.jsonl   run-wide structured events (jq-friendly)
  <repo>/.coverage-harness/harness.log           one repo's log, including agent activity
  <repo>/.coverage-harness/events.jsonl          one repo's structured events
  <repo>/.coverage-harness/logs/                 every prompt, agent transcript, dotnet and Stryker log
`;

function fail(message: string): never {
  console.error(`error: ${message}\n\nRun with --help for usage.`);
  process.exit(2);
}

function num(value: string | undefined, fallback: number, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) fail(`--${name} must be a number between ${min} and ${max}`);
  return n;
}

const OPTIONS = {
  src: { type: 'string' },
  target: { type: 'string' },
  agent: { type: 'string' },
  'agent-binary': { type: 'string' },
  model: { type: 'string' },
  'mutation-target': { type: 'string' },
  'skip-mutation': { type: 'boolean' },
  manifest: { type: 'string' },
  prompts: { type: 'string' },
  branch: { type: 'string' },
  concurrency: { type: 'string' },
  retry: { type: 'boolean' },
  'max-iterations': { type: 'string' },
  'max-mutation-iterations': { type: 'string' },
  'stall-limit': { type: 'string' },
  'fix-attempts': { type: 'string' },
  'agent-timeout': { type: 'string' },
  'agent-idle-timeout': { type: 'string' },
  'test-timeout': { type: 'string' },
  'stryker-timeout': { type: 'string' },
  heartbeat: { type: 'string' },
  verbose: { type: 'boolean' },
  'env-file': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

const parsed = parseArgs({ allowPositionals: true, options: OPTIONS });
const { positionals } = parsed;
let envFile: string | undefined;
let values: typeof parsed.values;
try {
  envFile = loadDotEnv(parsed.values['env-file']);
  const { help: _help, 'env-file': _envFile, ...fromEnv } = OPTIONS;
  values = applyEnvDefaults(fromEnv, parsed.values);
} catch (err) {
  fail((err as Error).message);
}

const command = positionals[0] ?? 'run';
if (values.help) {
  console.log(HELP);
  process.exit(0);
}

let log = new Logger('harness', values.verbose ?? false);
if (envFile) log.debug(`Loaded settings from ${envFile}`);
const minutes = (v: string | undefined, d: number, name: string) => num(v, d, name, 1) * 60_000;

async function main(): Promise<number> {
  if (command === 'status') {
    const path = values.manifest ?? (values.src ? defaultManifestPath(discoverRepos(values.src).root) : undefined);
    if (!path || !existsSync(path)) fail('pass --manifest <file> or --src <path>');
    printStatus(ManifestStore.read(path).repos);
    return 0;
  }

  if (!values.src) fail('--src is required');
  const { repos, root } = discoverRepos(values.src);
  if (repos.length === 0) fail(`no git repositories found under ${values.src}`);

  if (command === 'measure') {
    for (const repo of repos) {
      const sln = findSolution(repo);
      if (!sln) {
        log.warn(`${repo}: no solution found`);
        continue;
      }
      const m = await measure(
        { repo, solutionPath: sln, workDir: join(repo, '.coverage-harness'), buildTimeoutMs: DEFAULTS.buildTimeoutMinutes * 60_000, testTimeoutMs: minutes(values['test-timeout'], DEFAULTS.testTimeoutMinutes, 'test-timeout'), log: log.child(repo.split('/').pop()!) },
        'measure',
      );
      if (m.kind !== 'green') log.warn(`${repo}: ${m.kind}`);
    }
    return 0;
  }

  if (command !== 'run' && command !== 'discover') fail(`unknown command ${command}`);
  const target = num(values.target, Number.NaN, 'target', 0, 100);
  if (command === 'run' && Number.isNaN(target)) fail('--target is required');
  const agentName = (values.agent ?? DEFAULTS.agent) as AgentName;
  if (!AGENT_NAMES.includes(agentName)) fail(`--agent must be one of ${AGENT_NAMES.join(', ')}`);

  const cfg: HarnessConfig = {
    src: values.src,
    target,
    mutationTarget: num(values['mutation-target'], DEFAULTS.mutationTarget, 'mutation-target', 0, 100),
    agent: agentName,
    agentBinary: values['agent-binary'],
    model: values.model,
    manifestPath: values.manifest ?? defaultManifestPath(root),
    promptsDir: values.prompts,
    branch: values.branch ?? DEFAULTS.branch,
    concurrency: num(values.concurrency, DEFAULTS.concurrency, 'concurrency', 1, 32),
    maxCoverageIterations: num(values['max-iterations'], DEFAULTS.maxCoverageIterations, 'max-iterations', 1),
    maxMutationIterations: num(values['max-mutation-iterations'], DEFAULTS.maxMutationIterations, 'max-mutation-iterations', 1),
    stallLimit: num(values['stall-limit'], DEFAULTS.stallLimit, 'stall-limit', 1),
    fixAttempts: num(values['fix-attempts'], DEFAULTS.fixAttempts, 'fix-attempts', 0),
    followUps: DEFAULTS.followUps,
    agentTimeoutMs: minutes(values['agent-timeout'], DEFAULTS.agentTimeoutMinutes, 'agent-timeout'),
    agentIdleTimeoutMs: minutes(values['agent-idle-timeout'], DEFAULTS.agentIdleTimeoutMinutes, 'agent-idle-timeout'),
    buildTimeoutMs: DEFAULTS.buildTimeoutMinutes * 60_000,
    testTimeoutMs: minutes(values['test-timeout'], DEFAULTS.testTimeoutMinutes, 'test-timeout'),
    strykerTimeoutMs: minutes(values['stryker-timeout'], DEFAULTS.strykerTimeoutMinutes, 'stryker-timeout'),
    heartbeatMs: num(values.heartbeat, DEFAULTS.heartbeatMinutes, 'heartbeat', 0) * 60_000,
    skipMutation: values['skip-mutation'] ?? false,
    verbose: values.verbose ?? false,
  };

  const manifest = ManifestStore.openOrCreate(
    cfg.manifestPath,
    { source: cfg.src, target: Number.isNaN(target) ? 0 : target, mutationTarget: cfg.mutationTarget, agent: cfg.agent },
    repos,
  );
  const logBase = cfg.manifestPath.replace(/(\.manifest)?\.json$/, '');
  log = log.child('harness', { textFiles: [`${logBase}.log`], eventFiles: [`${logBase}.events.jsonl`] });
  log.info(`Manifest ${cfg.manifestPath}: ${manifest.data.repos.length} repo(s)`);
  log.info(`Logging to ${logBase}.log and ${logBase}.events.jsonl`);
  if (command === 'discover') {
    printStatus(manifest.data.repos);
    return 0;
  }

  await preflight(cfg);
  const agent = createAgent(cfg.agent, cfg.agentBinary);
  const prompts = new PromptLibrary(cfg.promptsDir);
  const runnable = new Set(['pending', 'in-progress', ...(values.retry ? ['blocked', 'stalled', 'error'] : [])]);
  const queue = manifest.data.repos.filter((r) => repos.includes(r.path) && runnable.has(r.status));
  log.info(`${queue.length} repo(s) to process with ${cfg.agent}; target ${cfg.target}% statements${cfg.skipMutation ? '' : `, ${cfg.mutationTarget}% mutation score`}`);

  const runStarted = Date.now();
  log.event('run.start', {
    agent: cfg.agent,
    model: cfg.model,
    target: cfg.target,
    mutationTarget: cfg.skipMutation ? undefined : cfg.mutationTarget,
    repos: queue.map((r) => r.name),
    concurrency: cfg.concurrency,
  });

  process.on('SIGINT', () => {
    log.warn('Interrupted: stopping agents and saving the manifest. Re-run the same command to resume.');
    log.event('run.interrupted', { durationMs: Date.now() - runStarted, inProgress: manifest.data.repos.filter((r) => r.status === 'in-progress').map((r) => ({ repo: r.name, phase: r.phase })) });
    killAllChildren();
    manifest.flushSync();
    process.exit(130);
  });

  const workers = Array.from({ length: Math.min(cfg.concurrency, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const repoDir = join(next.path, '.coverage-harness');
      const repoLog = log.child(next.name, { textFiles: [join(repoDir, 'harness.log')], eventFiles: [join(repoDir, 'events.jsonl')] });
      await new RepoRunner(cfg, agent, prompts, manifest, next.path, repoLog).run();
    }
  });
  await Promise.all(workers);
  log.info(`Run finished in ${formatDuration(Date.now() - runStarted)}`);
  log.event('run.end', {
    durationMs: Date.now() - runStarted,
    repos: manifest.data.repos.map((r) => ({ repo: r.name, status: r.status, coverage: r.coverage, mutationScore: r.mutationScore })),
  });

  printStatus(manifest.data.repos);
  return manifest.data.repos.every((r) => r.status === 'complete' || r.status === 'skipped') ? 0 : 1;
}

async function preflight(cfg: HarnessConfig): Promise<void> {
  const check = async (bin: string, args: string[], what: string) => {
    const r = await run(bin, args, { cwd: process.cwd(), timeoutMs: 60_000 });
    if (r.code !== 0) fail(`${what} not available (${bin} ${args.join(' ')} → ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  };
  await check('git', ['--version'], 'git');
  await check('dotnet', ['--version'], '.NET SDK');
  const agent = createAgent(cfg.agent, cfg.agentBinary);
  await check(agent.binary, ['--version'], `${cfg.agent} CLI`);
}

function printStatus(repos: RepoEntry[]): void {
  const rows = repos.map((r) => ({
    repo: r.name,
    status: r.status,
    phase: r.phase ?? '',
    baseline: r.baselineCoverage === undefined ? '' : `${r.baselineCoverage}%`,
    coverage: r.coverage === undefined ? '' : `${r.coverage}%`,
    mutation: r.mutationScore === undefined ? '' : `${r.mutationScore}%`,
    iterations: `${r.iterations.coverage}/${r.iterations.mutation}`,
  }));
  console.table(rows);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  },
);
