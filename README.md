# dotnet-coverage-harness

A small meta-harness that drives agentic coding CLIs (Claude Code, OpenCode, GitHub Copilot CLI) in a long-running loop to raise **statement coverage** of .NET solutions to a target, using **outside-in component tests**, and then raise the **mutation score** with Stryker.NET.

The harness has no model of its own. It is the deterministic shell around the agent: it discovers solutions, builds, tests, measures coverage, decides what to ask for next, enforces the rules, and commits or reverts each iteration. The agent only writes test code.

```
node src/cli.ts --src "/abs/path/to/repos/*" --target 100
node src/cli.ts --src /abs/path/to/one-repo --target 90 --agent copilot
```

Requires Node ≥ 22.18 (TypeScript runs directly through Node's type stripping, so there is no build step), git, the .NET SDK, and whichever agent CLI you choose, already authenticated. `npm run typecheck` uses TypeScript 7 (the native compiler); `npm test` runs the unit tests.

## How it works

```
 discover repos ──► manifest.json
        │
        ▼  per repo (resumable; each phase re-detects its own state)
 ┌─────────────┐  no solution? create one (deterministic)
 │  prepare    │  require a clean tree, check out branch `coverage-harness`
 └─────┬───────┘
       ▼
 ┌─────────────┐  no test project at all?
 │ test-project│  → agent: create-test-project → verify → commit (coverage needs no package)
 └─────┬───────┘
       ▼
 ┌─────────────┐  build + test + coverage; red → fix-build / fix-tests prompts
 │  baseline   │  record baselineCoverage
 └─────┬───────┘
       ▼
 ┌─────────────┐  no WebApplicationFactory / *.ComponentTests project?
 │  scaffold   │  → agent: scaffold-component-tests (fixture, stubs, seam map) → commit
 └─────┬───────┘
       ▼
 ┌─────────────┐  loop until coverage ≥ target:
 │  coverage   │    write gap report → agent: raise-coverage → guard → measure
 │   loop      │    red → fix prompts (≤ N) → still red → git reset
 │             │    coverage up → commit; down → reset; flat → stall++
 └─────┬───────┘    stall limit / max iterations → status "stalled"
       ▼
 ┌─────────────┐  no dotnet-stryker tool + root stryker-config.json?
 │  stryker    │  → agent: setup-stryker → trial mutation run → commit
 └─────┬───────┘
       ▼
 ┌─────────────┐  loop until mutation score ≥ mutation target:
 │  mutation   │    surviving mutants → agent: kill-mutants → guard → measure
 │   loop      │    (coverage must not drop) → Stryker → score up: commit
 └─────┬───────┘
       ▼
   complete  → manifest: status, coverage %, mutation score %
```

### The deterministic shell

| Concern | Where | Notes |
|---|---|---|
| Repo discovery, manifest | `src/manifest.ts` | `--src dir/*` = every git repo directly inside `dir`. Manifest defaults to `<dir>/coverage-harness.manifest.json`; atomic writes, serialised across parallel workers. |
| Solution discovery | `src/dotnet/projects.ts` | Shallowest `.sln`/`.slnx`, preferring the repo's name, then the one with most projects. Test projects are classified from their project files. |
| Build / test | `src/dotnet/dotnet.ts` | `dotnet build`, then `dotnet test --no-build --collect "Code Coverage" --logger trx` using the collector built into Microsoft.NET.Test.Sdk (no coverlet or other package needed), with a **harness-owned runsettings** that instruments production assemblies only and emits Cobertura (agents can't weaken exclusions). |
| Coverage | `src/coverage/cobertura.ts` | Cobertura reports from every test project are merged per line (max hits). The target is statement (line/sequence-point) coverage. `Program.cs`/`Main` of executable projects is excluded from the target, as allowed; the raw figure is still computed. Gaps are grouped by method (async state machines resolved to their source method). |
| Test failures | `src/dotnet/trx.ts` | TRX parsed for failing test names, messages and stack traces. |
| Mutation testing | `src/dotnet/stryker.ts` | `dotnet tool restore` + `dotnet stryker --config-file stryker-config.json --reporter json --output …`; score = (killed + timeout) / (killed + timeout + survived + no coverage). |
| Rule enforcement | `src/guard.ts` | After every agent turn, any change outside test projects is **reverted** by the harness. Allowed exceptions: `public partial class Program { }`, `InternalsVisibleTo`, solution files, `Directory.Packages.props`, `.config/dotnet-tools.json`, root `stryker-config.*`. The agent is told what was reverted. |
| Git | `src/git.ts` | Work happens on the `coverage-harness` branch. The harness, not the agent, commits each successful iteration; failed iterations are `reset --hard` to the last good commit. Scratch files are hidden through `.git/info/exclude`, so the repo's `.gitignore` is never touched. |

Everything the agent needs is written to `.coverage-harness/` in the repo: `coverage-gaps.md`, `coverage-summary.json`, `failing-tests.md`, `build-errors.md`, `surviving-mutants.md/.json`, plus `logs/` holding every prompt sent, every agent transcript, and every dotnet/stryker log.

### Talking to the agent

Each task is one agent session (`src/repo-runner.ts` → `runTask`):

1. Render the prompt and send it to the CLI in non-interactive YOLO mode.
2. Look for the `<harness-report>{json}</harness-report>` block every prompt asks for.
3. No block → resume the same session with `continue.md`. `status: "needs-input"` → resume with `answer.md` (an unattended-mode decision policy). Up to 2 follow-ups.
4. Whatever the agent claims, the harness then measures for itself. The report is only used for notes (`unreachable` code, `equivalentMutants`, `blockers`) recorded in the manifest.

Agents are supervised with a wall-clock timeout and an **idle timeout** (no output for N minutes → kill the process group). Three consecutive agent crashes with no output mark the repo `error`, so a missing login doesn't burn hours.

### Agent adapters (`src/agents/`)

| Agent | Invocation | Output parsed | Session follow-ups |
|---|---|---|---|
| `claude` | `claude -p --dangerously-skip-permissions --output-format stream-json --verbose` (prompt on stdin) | `assistant` / `result` events | `--resume <session_id>` |
| `opencode` | `opencode run --auto --format json [-m provider/model] <prompt>` | `text` / `tool_use` events | `-s <sessionID>` |
| `copilot` | `copilot -p <prompt> --yolo --no-ask-user --autopilot --output-format json --session-id=<uuid>` | `assistant.message` / `result` events | `--resume=<uuid>` |

Adding another CLI means implementing `AgentAdapter.invoke()` (one file) and registering it in `src/agents/index.ts`.

## Prompts (`prompts/`)

| File | Sent when |
|---|---|
| `create-test-project.md` | the solution has no test project at all |
| `scaffold-component-tests.md` | no component test project exists: maps the app's outside edges, builds the `WebApplicationFactory` fixture, stubs and seam-map README |
| `raise-coverage.md` | each coverage iteration, with the top gaps inline and the history of previous iterations |
| `fix-build.md` / `fix-tests.md` | the build or tests are red after any agent turn (or at baseline) |
| `setup-stryker.md` | no Stryker tool manifest or root config |
| `kill-mutants.md` | each mutation iteration, with surviving mutants (file, line, mutator, original → replacement) |
| `continue.md` / `answer.md` | follow-ups within a session |
| `_rules.md`, `_testing-standards.md`, `_report.md` | partials included in task prompts |

`_testing-standards.md` encodes the testing approach: in-memory `WebApplicationFactory` hosts; isolation at the smallest DI seam (`HttpMessageHandler` for outbound HTTP, SQLite in-memory for relational stores, in-memory stubs for document stores and queues); stubs defined in the test project, rebound in `ConfigureTestServices` whenever a host starts, and verified in every test.

Override any prompt with `--prompts <dir>` containing files of the same name. Templates use `{{var}}` and `{{> partial}}`, and rendering fails loudly on a missing variable.

## CLI

```
coverage-harness [run] --src <path> --target <percent> [options]
coverage-harness discover --src <path>      # write/refresh the manifest only
coverage-harness measure --src <repo>       # build + test + coverage, no agent
coverage-harness status --manifest <file>
```

| Option | Default | |
|---|---|---|
| `--src` | — | `/abs/dir/*` (every git repo in dir) or `/abs/repo` |
| `--target` | — | statement coverage % |
| `--agent` | `claude` | `claude`, `opencode`, `copilot` |
| `--model` | CLI default | passed through to the agent |
| `--mutation-target` | 80 | mutation score % required to mark a repo done |
| `--skip-mutation` | off | finish once coverage is met |
| `--concurrency` | 1 | repos processed in parallel |
| `--retry` | off | re-run repos that are `blocked` / `stalled` / `error` |
| `--max-iterations` / `--max-mutation-iterations` | 40 / 20 | |
| `--stall-limit` | 3 | consecutive non-improving iterations before `stalled` |
| `--fix-attempts` | 3 | fix prompts per red build before reverting |
| `--agent-timeout` / `--agent-idle-timeout` | 90 / 20 min | |
| `--test-timeout` / `--stryker-timeout` | 30 / 240 min | |
| `--stryker-concurrency` | half the cores | parallel test runners for Stryker (overrides `concurrency` in `stryker-config.json`) |
| `--heartbeat` | 5 min | log a "still running" line during long agent/test/Stryker steps (0 = off) |
| `--verbose` | off | also stream agent activity (tool calls, messages) to the console; it is always in the log files |
| `--env-file` | `./.env` | settings file (see below) |

### Settings from the environment / `.env`

Every option can also be set as `COVERAGE_HARNESS_<OPTION>`, with hyphens becoming underscores (`COVERAGE_HARNESS_MAX_ITERATIONS=60`, `COVERAGE_HARNESS_SKIP_MUTATION=true`). `./.env` is loaded automatically when present, or pass `--env-file <path>`. Precedence: command-line flag > real environment variable > `.env` file > default. Other variables in the file (API keys, tokens) are passed through to the agent CLIs. See `.env.example`.

### Observing long runs

Everything is logged to files whether or not `--verbose` is on:

| File | Contents |
|---|---|
| `<manifest dir>/coverage-harness.log` | Run-wide human-readable log for all repos: phases, iteration start/finish with timings and outcomes, every agent turn and its tool calls, measurements, commits, resets, guard reverts, and heartbeats. `tail -f` it. |
| `<manifest dir>/coverage-harness.events.jsonl` | The same run as structured events: `run.start/end/interrupted`, `repo.start/end`, `phase`, `iteration.start/end`, `agent.start/end` (with parsed report, exit code, duration), `measure`, `fix.start`, `guard.revert`, `commit`, `reset`, `stryker`, `heartbeat`. |
| `<repo>/.coverage-harness/harness.log`, `events.jsonl` | The same, for one repo. |
| `<repo>/.coverage-harness/logs/` | Each prompt sent (`*.prompt.md`), raw agent transcript (`*.agent.log`), and dotnet/Stryker output. |

Stryker runs report live progress too: the `dots` reporter is parsed into `Stryker tested 1200/4484 mutants (27%): … ETA ~1h10m`, logged at every 10% and in each heartbeat (`stryker.progress` events).

Heartbeats name the agent's last action and how long ago it happened, so a stuck agent stands out:

```
… claude raise-coverage (coverage-7) still running (25m00s elapsed; last activity 12s ago: ⚙ Bash dotnet test)
```

Some useful queries:

```sh
tail -f repos/coverage-harness.log
jq -c 'select(.type=="iteration.end") | {repo, phase, iteration, outcome, durationMs}' repos/coverage-harness.events.jsonl
jq -c 'select(.type=="measure" and .result=="green") | {repo, label, coverage}' repos/coverage-harness.events.jsonl
```

Runs are resumable: Ctrl-C kills the agent process tree and saves the manifest, and re-running the same command picks up where it left off. Uncommitted leftovers on the harness branch are stashed (`git stash list`; never deleted), and iteration counts and history come from the manifest.

### Manifest

```json
{
  "target": 100, "mutationTarget": 80, "agent": "claude",
  "repos": [{
    "name": "OrdersApi", "path": "/repos/OrdersApi", "status": "complete", "phase": "done",
    "solution": "OrdersApi.sln", "branch": "coverage-harness",
    "baselineCoverage": 0, "coverage": 100, "branchCoverage": 100, "mutationScore": 86.2,
    "iterations": { "coverage": 3, "mutation": 2 }, "agentInvocations": 9,
    "completedAt": "…", "notes": ["…"], "history": [{ "phase": "coverage", "iteration": 1, "outcome": "committed: 0% → 71.4%", "coverage": 71.4 }]
  }]
}
```

Statuses: `pending`, `in-progress`, `complete`, `stalled` (no progress, or out of iterations), `blocked` (a precondition the agent couldn't fix: dirty tree, broken production build, test-project/scaffold/Stryker setup failed), `skipped` (no .NET projects), `error`.

## Limitations and known trade-offs

- Equivalent mutants make 100% mutation score unrealistic. Set `--mutation-target` accordingly. Mutants the agent reports as equivalent are recorded in the manifest notes but don't count towards the score; the harness doesn't trust the agent to grade itself.
- Solutions that opt into the Microsoft.Testing.Platform `dotnet test` mode (via `global.json`) use different CLI arguments and are not handled yet.
- Repos are processed on a branch in place, so don't work in those clones while the harness runs.
- OpenCode silently retries forever when its configured provider is unreachable. The idle timeout catches this, but pass `--model provider/model` if your default provider is a local server.
