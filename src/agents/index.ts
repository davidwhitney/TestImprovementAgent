import { ClaudeAdapter } from './claude.ts';
import { CopilotAdapter } from './copilot.ts';
import { OpenCodeAdapter } from './opencode.ts';
import type { AgentAdapter, AgentName } from './types.ts';

export const AGENT_NAMES: AgentName[] = ['claude', 'opencode', 'copilot'];

export function createAgent(name: AgentName, binary?: string): AgentAdapter {
  switch (name) {
    case 'claude':
      return new ClaudeAdapter(binary);
    case 'opencode':
      return new OpenCodeAdapter(binary);
    case 'copilot':
      return new CopilotAdapter(binary);
  }
}

export interface HarnessReport {
  status: 'done' | 'partial' | 'blocked' | 'needs-input';
  summary: string;
  testsAdded?: number;
  question?: string;
  blockers?: string;
  unreachable?: string[];
  equivalentMutants?: string[];
}

/** Extract the last <harness-report>{json}</harness-report> block the agent emitted. */
export function parseHarnessReport(text: string): HarnessReport | undefined {
  const matches = [...text.matchAll(/<harness-report>\s*([\s\S]*?)\s*<\/harness-report>/g)];
  for (const m of matches.reverse()) {
    const body = m[1]!.replace(/^```(?:json)?\s*|\s*```$/g, '');
    try {
      const parsed = JSON.parse(body) as HarnessReport;
      if (typeof parsed.status === 'string') return { ...parsed, summary: String(parsed.summary ?? '') };
    } catch {
      /* try an earlier block */
    }
  }
  return undefined;
}
