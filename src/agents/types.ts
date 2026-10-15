export interface AgentRequest {
  cwd: string;
  prompt: string;
  logFile: string;
  timeoutMs: number;
  idleTimeoutMs: number;
  model?: string;
  /** Continue an earlier conversation (follow-ups such as "you stopped without a report"). */
  sessionId?: string;
  /** Called for each human-readable progress event (assistant text, tool calls) while the agent runs. */
  onEvent?: (event: string) => void;
}

/** What a CLI reports about the cost of an invocation. Every field is optional: CLIs report different things. */
export interface AgentUsage {
  costUsd?: number;
  /** GitHub Copilot bills in premium requests rather than tokens or dollars. */
  premiumRequests?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

const USAGE_KEYS: (keyof AgentUsage)[] = ['costUsd', 'premiumRequests', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

/** Sums usage, keeping a field absent until some invocation reports it. */
export function addUsage(total: AgentUsage | undefined, add: AgentUsage | undefined): AgentUsage | undefined {
  if (!add) return total;
  const out: AgentUsage = { ...total };
  for (const k of USAGE_KEYS) if (typeof add[k] === 'number') out[k] = (out[k] ?? 0) + add[k];
  return out;
}

const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** One-line summary such as `$1.23, 45k in / 6.1k out tokens`; undefined when nothing was reported. */
export function formatUsage(u: AgentUsage | undefined): string | undefined {
  if (!u) return undefined;
  const parts: string[] = [];
  if (u.costUsd !== undefined) parts.push(`$${u.costUsd.toFixed(2)}`);
  if (u.premiumRequests !== undefined) parts.push(`${Math.round(u.premiumRequests * 100) / 100} premium request${u.premiumRequests === 1 ? '' : 's'}`);
  if (u.inputTokens !== undefined || u.outputTokens !== undefined) parts.push(`${compact(u.inputTokens ?? 0)} in / ${compact(u.outputTokens ?? 0)} out tokens`);
  const cached = (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  if (cached > 0) parts.push(`${compact(cached)} cached`);
  return parts.length ? parts.join(', ') : undefined;
}

export interface AgentResult {
  exitCode: number | null;
  timedOut: boolean;
  idledOut: boolean;
  durationMs: number;
  /** The agent's final message(s); where the harness looks for the <harness-report> block. */
  finalText: string;
  sessionId?: string;
  error?: string;
  usage?: AgentUsage;
}

/**
 * One CLI coding agent. Adapters only translate a prompt into a non-interactive, fully
 * auto-approved ("YOLO") process invocation and translate its output stream back.
 */
export interface AgentAdapter {
  readonly name: string;
  readonly binary: string;
  invoke(req: AgentRequest): Promise<AgentResult>;
}

export type AgentName = 'claude' | 'opencode' | 'copilot';
