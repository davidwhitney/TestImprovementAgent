import { run } from '../util/exec.ts';
import { describeToolInput, oneLine, parseJsonLine } from './jsonl.ts';
import type { AgentAdapter, AgentRequest, AgentResult } from './types.ts';

/**
 * Claude Code: `claude -p --dangerously-skip-permissions --output-format stream-json --verbose`
 * The prompt goes over stdin (no argv length limits); the session id comes from the init/result events.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude';
  readonly binary: string;

  constructor(binary = 'claude') {
    this.binary = binary;
  }

  buildArgs(req: AgentRequest): string[] {
    const args = ['-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'];
    if (req.model) args.push('--model', req.model);
    if (req.sessionId) args.push('--resume', req.sessionId);
    return args;
  }

  async invoke(req: AgentRequest): Promise<AgentResult> {
    let sessionId: string | undefined;
    let resultText: string | undefined;
    let error: string | undefined;
    const texts: string[] = [];

    const r = await run(this.binary, this.buildArgs(req), {
      cwd: req.cwd,
      input: req.prompt,
      logFile: req.logFile,
      timeoutMs: req.timeoutMs,
      idleTimeoutMs: req.idleTimeoutMs,
      onStdoutLine: (line) => {
        const ev = parseJsonLine(line);
        if (!ev) return;
        if (ev.session_id) sessionId = ev.session_id;
        if (ev.type === 'assistant') {
          for (const block of ev.message?.content ?? []) {
            if (block.type === 'text' && block.text) {
              texts.push(block.text);
              req.onEvent?.(oneLine(block.text));
            } else if (block.type === 'tool_use') {
              req.onEvent?.(`⚙ ${block.name} ${describeToolInput(block.input)}`);
            }
          }
        } else if (ev.type === 'result') {
          resultText = typeof ev.result === 'string' ? ev.result : undefined;
          if (ev.is_error) error = `claude reported an error result (${ev.subtype ?? 'unknown'})`;
        }
      },
    });

    return {
      exitCode: r.code,
      timedOut: r.timedOut,
      idledOut: r.idledOut,
      durationMs: r.durationMs,
      // The result event holds only the last message; keep all text so an earlier report block isn't lost.
      finalText: [...texts, resultText ?? ''].join('\n'),
      sessionId,
      error: error ?? (r.code !== 0 ? r.stderr.slice(-2000) || undefined : undefined),
    };
  }
}
