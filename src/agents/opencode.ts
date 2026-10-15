import { run } from '../util/exec.ts';
import { describeToolInput, oneLine, parseJsonLine } from './jsonl.ts';
import type { AgentAdapter, AgentRequest, AgentResult } from './types.ts';

/**
 * OpenCode: `opencode run --auto --format json [-m provider/model] [-s session] <prompt>`
 * `--auto` approves every permission request. Events are JSONL with `type` text/tool_use/step_finish
 * and a `sessionID` on each line.
 *
 * Note: when the configured provider is unreachable OpenCode retries silently forever, which is why
 * the harness always runs agents with an idle timeout.
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly name = 'opencode';
  readonly binary: string;

  constructor(binary = 'opencode') {
    this.binary = binary;
  }

  buildArgs(req: AgentRequest): string[] {
    const args = ['run', '--auto', '--format', 'json'];
    if (req.model) args.push('-m', req.model);
    if (req.sessionId) args.push('-s', req.sessionId);
    args.push(req.prompt);
    return args;
  }

  async invoke(req: AgentRequest): Promise<AgentResult> {
    let sessionId: string | undefined;
    let error: string | undefined;
    const texts: string[] = [];

    const r = await run(this.binary, this.buildArgs(req), {
      cwd: req.cwd,
      logFile: req.logFile,
      timeoutMs: req.timeoutMs,
      idleTimeoutMs: req.idleTimeoutMs,
      onStdoutLine: (line) => {
        const ev = parseJsonLine(line);
        if (!ev) return;
        sessionId = ev.sessionID ?? ev.part?.sessionID ?? sessionId;
        const part = ev.part ?? {};
        if (ev.type === 'text' && part.text) {
          texts.push(part.text);
          req.onEvent?.(oneLine(part.text));
        } else if (ev.type === 'tool_use' || part.type === 'tool') {
          const status = part.state?.status;
          if (!status || status === 'completed' || status === 'running') req.onEvent?.(`⚙ ${part.tool ?? 'tool'} ${describeToolInput(part.state?.input)}`);
        } else if (ev.type === 'error') {
          error = oneLine(JSON.stringify(ev.error ?? ev), 500);
        }
      },
    });

    return {
      exitCode: r.code,
      timedOut: r.timedOut,
      idledOut: r.idledOut,
      durationMs: r.durationMs,
      finalText: texts.join('\n'),
      sessionId,
      error: error ?? (r.code !== 0 ? r.stderr.slice(-2000) || undefined : undefined),
    };
  }
}
