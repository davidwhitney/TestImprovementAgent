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

export interface AgentResult {
  exitCode: number | null;
  timedOut: boolean;
  idledOut: boolean;
  durationMs: number;
  /** The agent's final message(s); where the harness looks for the <harness-report> block. */
  finalText: string;
  sessionId?: string;
  error?: string;
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
