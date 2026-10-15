import { randomUUID } from 'node:crypto';
import { run } from '../util/exec.ts';
import { describeToolInput, oneLine, parseJsonLine } from './jsonl.ts';
import type { AgentAdapter, AgentRequest, AgentResult, AgentUsage } from './types.ts';

/**
 * GitHub Copilot CLI: start sessions with `--session-id`; use `--resume` only for existing sessions.
 */
export class CopilotAdapter implements AgentAdapter {
  readonly name = 'copilot';
  readonly binary: string;

  constructor(binary = 'copilot') {
    this.binary = binary;
  }

  buildArgs(req: AgentRequest, sessionId: string): string[] {
    const sessionArg = req.sessionId ? `--resume=${req.sessionId}` : `--session-id=${sessionId}`;
    const args = ['-p', req.prompt, '--yolo', '--no-ask-user', '--autopilot', '--output-format', 'json', sessionArg];
    if (req.model) args.push('--model', req.model);
    return args;
  }

  async invoke(req: AgentRequest): Promise<AgentResult> {
    let sessionId = req.sessionId ?? randomUUID();
    let error: string | undefined;
    let usage: AgentUsage | undefined;
    let completion: string | undefined;
    const texts: string[] = [];

    const r = await run(this.binary, this.buildArgs(req, sessionId), {
      cwd: req.cwd,
      logFile: req.logFile,
      timeoutMs: req.timeoutMs,
      idleTimeoutMs: req.idleTimeoutMs,
      env: { COPILOT_ALLOW_ALL: 'true' },
      onStdoutLine: (line) => {
        const ev = parseJsonLine(line);
        if (!ev) return;
        if (ev.type === 'assistant.message') {
          const content: string = ev.data?.content ?? '';
          if (content) {
            texts.push(content);
            req.onEvent?.(oneLine(content));
          }
          for (const tool of ev.data?.toolRequests ?? []) {
            req.onEvent?.(`⚙ ${tool.name ?? 'tool'} ${describeToolInput(tool.arguments)}`);
            if (tool.name === 'task_complete' && typeof tool.arguments?.summary === 'string') completion = tool.arguments.summary;
          }
        } else if (ev.type === 'result') {
          sessionId = ev.sessionId ?? sessionId;
          if (typeof ev.usage?.premiumRequests === 'number') usage = { premiumRequests: ev.usage.premiumRequests };
          if (ev.exitCode && ev.exitCode !== 0) error = `copilot exited with ${ev.exitCode}`;
        } else if (ev.type === 'session.error' || ev.type === 'error') {
          error = oneLine(JSON.stringify(ev.data ?? ev), 500);
        }
      },
    });

    return {
      exitCode: r.code,
      timedOut: r.timedOut,
      idledOut: r.idledOut,
      durationMs: r.durationMs,
      finalText: withImplicitReport(texts.join('\n'), completion),
      sessionId,
      usage,
      error: error ?? (r.code !== 0 ? r.stderr.slice(-2000) || undefined : undefined),
    };
  }
}

/**
 * In autopilot Copilot usually ends by calling `task_complete` with a summary instead of writing a final
 * message, so no report block ever appears. Without this the harness would send pointless follow-up turns.
 */
export function withImplicitReport(text: string, completionSummary: string | undefined): string {
  if (!completionSummary || text.includes('<harness-report>')) return text;
  const report = JSON.stringify({ status: 'done', summary: completionSummary.slice(0, 500) });
  return `${text}\n${completionSummary}\n<harness-report>\n${report}\n</harness-report>`;
}
