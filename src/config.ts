import { availableParallelism } from 'node:os';
import type { AgentName } from './agents/types.ts';

export interface HarnessConfig {
  src: string;
  /** Branch coverage % to reach. */
  target: number;
  /** Mutation score % to reach once coverage is met. */
  mutationTarget: number;
  agent: AgentName;
  agentBinary?: string;
  model?: string;
  manifestPath: string;
  promptsDir?: string;
  branch: string;
  concurrency: number;
  maxCoverageIterations: number;
  maxMutationIterations: number;
  /** Consecutive iterations without improvement before a repo is marked stalled. */
  stallLimit: number;
  /** Fix prompts per breakage before the harness reverts the iteration. */
  fixAttempts: number;
  /** Follow-up prompts (missing report / agent question) per agent task. */
  followUps: number;
  agentTimeoutMs: number;
  agentIdleTimeoutMs: number;
  buildTimeoutMs: number;
  testTimeoutMs: number;
  strykerTimeoutMs: number;
  /** Parallel test runners Stryker uses (`--concurrency`); overrides the value in stryker-config.json. */
  strykerConcurrency: number;
  /** Stryker runs over this many separately saved shards, so an interruption only loses the shard in flight. 1 = one run. */
  strykerShards: number;
  /** Extra directory or file names to leave out of mutation testing, on top of the built-in noise list. */
  strykerExclude: string[];
  /** How often long-running steps (agent turns, dotnet test, Stryker) log a "still running" line. 0 disables. */
  heartbeatMs: number;
  /** Skip the planning step that orders coverage gaps quick-wins-first before the coverage loop. */
  skipTriage: boolean;
  /** Run mutation testing (Stryker) once coverage is met. Off by default: it can take many hours on large codebases. */
  mutation: boolean;
  verbose: boolean;
}

export const DEFAULTS = {
  mutationTarget: 80,
  agent: 'claude' as AgentName,
  branch: 'coverage-harness',
  concurrency: 1,
  maxCoverageIterations: 40,
  maxMutationIterations: 20,
  stallLimit: 3,
  fixAttempts: 3,
  followUps: 2,
  agentTimeoutMinutes: 90,
  agentIdleTimeoutMinutes: 20,
  buildTimeoutMinutes: 15,
  testTimeoutMinutes: 30,
  strykerTimeoutMinutes: 240,
  strykerConcurrency: Math.max(1, Math.floor(availableParallelism() / 2)),
  strykerShards: 1,
  heartbeatMinutes: 5,
};
