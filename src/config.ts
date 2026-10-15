import type { AgentName } from './agents/types.ts';

export interface HarnessConfig {
  src: string;
  /** Statement coverage % to reach. */
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
  /** How often long-running steps (agent turns, dotnet test, Stryker) log a "still running" line. 0 disables. */
  heartbeatMs: number;
  skipMutation: boolean;
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
  heartbeatMinutes: 5,
};
