import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ClaudeAdapter } from '../src/agents/claude.ts';
import { CopilotAdapter } from '../src/agents/copilot.ts';
import { OpenCodeAdapter } from '../src/agents/opencode.ts';
import type { AgentRequest } from '../src/agents/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'harness-agents-'));
const req = (extra: Partial<AgentRequest> = {}): AgentRequest => ({ cwd: dir, prompt: 'do the thing', logFile: join(dir, 'agent.log'), timeoutMs: 30_000, idleTimeoutMs: 30_000, ...extra });

/** A fake CLI that prints canned JSONL, so adapters are tested against each tool's real event shapes. */
function fakeCli(name: string, lines: object[], code = 0): string {
  const path = join(dir, name);
  const body = lines.map((l) => `echo '${JSON.stringify(l).replaceAll("'", "'\\''")}'`).join('\n');
  writeFileSync(path, `#!/bin/sh\ncat > ${join(dir, `${name}.stdin`)}\necho "$@" > ${join(dir, `${name}.args`)}\n${body}\nexit ${code}\n`);
  chmodSync(path, 0o755);
  return path;
}

const REPORT = '<harness-report>{"status":"done","summary":"ok"}</harness-report>';

describe('claude adapter', () => {
  it('runs headless in YOLO mode and resumes sessions', () => {
    assert.deepEqual(new ClaudeAdapter().buildArgs(req({ model: 'opus', sessionId: 's1' })), [
      '-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose', '--model', 'opus', '--resume', 's1',
    ]);
  });

  it('parses stream-json events', async () => {
    const bin = fakeCli('claude', [
      { type: 'system', subtype: 'init', session_id: 'abc' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'dotnet test' } }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: `Done. ${REPORT}` }] } },
      { type: 'result', subtype: 'success', result: `Done. ${REPORT}`, session_id: 'abc', is_error: false },
    ]);
    const events: string[] = [];
    const r = await new ClaudeAdapter(bin).invoke(req({ onEvent: (e) => events.push(e) }));
    assert.equal(r.sessionId, 'abc');
    assert.match(r.finalText, /harness-report/);
    assert.ok(events.includes('⚙ Bash dotnet test'));
  });
});

describe('opencode adapter', () => {
  it('auto-approves and passes the prompt as the message', () => {
    assert.deepEqual(new OpenCodeAdapter().buildArgs(req({ model: 'openrouter/x', sessionId: 'ses_1' })), ['run', '--auto', '--format', 'json', '-m', 'openrouter/x', '-s', 'ses_1', 'do the thing']);
  });

  it('parses json events', async () => {
    const bin = fakeCli('opencode', [
      { type: 'step_start', sessionID: 'ses_9', part: { type: 'step-start' } },
      { type: 'tool_use', sessionID: 'ses_9', part: { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'dotnet build' } } } },
      { type: 'text', sessionID: 'ses_9', part: { type: 'text', text: REPORT } },
    ]);
    const r = await new OpenCodeAdapter(bin).invoke(req());
    assert.equal(r.sessionId, 'ses_9');
    assert.equal(r.finalText, REPORT);
  });
});

describe('copilot adapter', () => {
  it('runs with --yolo under a session id we choose', () => {
    const args = new CopilotAdapter().buildArgs(req(), 'uuid-1');
    assert.deepEqual(args, ['-p', 'do the thing', '--yolo', '--no-ask-user', '--autopilot', '--output-format', 'json', '--resume=uuid-1']);
  });

  it('parses json events and keeps the session id for follow-ups', async () => {
    const bin = fakeCli('copilot', [
      { type: 'assistant.message', data: { content: 'Working…', toolRequests: [{ name: 'bash', arguments: { command: 'ls' } }] } },
      { type: 'assistant.message', data: { content: REPORT, toolRequests: [] } },
      { type: 'result', sessionId: 'uuid-2', exitCode: 0 },
    ]);
    const r = await new CopilotAdapter(bin).invoke(req({ sessionId: 'uuid-2' }));
    assert.equal(r.sessionId, 'uuid-2');
    assert.match(r.finalText, /Working…\n<harness-report>/);
  });
});

describe('process supervision', () => {
  it('kills an agent that goes silent', async () => {
    const path = join(dir, 'hang');
    writeFileSync(path, '#!/bin/sh\nsleep 30\n');
    chmodSync(path, 0o755);
    const r = await new ClaudeAdapter(path).invoke(req({ idleTimeoutMs: 300 }));
    assert.equal(r.idledOut, true);
    assert.ok(r.durationMs < 5000);
  });
});
