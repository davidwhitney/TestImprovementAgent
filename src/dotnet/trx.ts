import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';

export interface TestFailure {
  name: string;
  message: string;
  stackTrace: string;
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: TestFailure[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => ['UnitTestResult', 'Results'].includes(name),
});

const text = (v: unknown): string => (typeof v === 'string' ? v : v && typeof v === 'object' && '#text' in v ? String((v as { '#text': unknown })['#text']) : '');

export function parseTrx(xml: string): TestSummary {
  const doc = parser.parse(xml);
  const runNode = doc.TestRun ?? {};
  const counters = runNode.ResultSummary?.Counters ?? {};
  const results: Record<string, unknown>[] = (runNode.Results ?? []).flatMap((r: { UnitTestResult?: unknown[] }) => r.UnitTestResult ?? []);
  const failures: TestFailure[] = results
    .filter((r) => r.outcome === 'Failed')
    .map((r) => {
      const info = (r.Output as { ErrorInfo?: { Message?: unknown; StackTrace?: unknown } } | undefined)?.ErrorInfo ?? {};
      return { name: String(r.testName), message: text(info.Message).trim(), stackTrace: text(info.StackTrace).trim() };
    });
  const num = (v: unknown) => Number(v ?? 0) || 0;
  const total = num(counters.total) || results.length;
  const failed = Math.max(num(counters.failed) + num(counters.error) + num(counters.timeout) + num(counters.aborted), failures.length);
  const passed = num(counters.passed) || results.filter((r) => r.outcome === 'Passed').length;
  return { total, passed, failed, skipped: Math.max(0, total - passed - failed), failures };
}

export function mergeTrx(files: string[]): TestSummary {
  const out: TestSummary = { total: 0, passed: 0, failed: 0, skipped: 0, failures: [] };
  for (const f of files) {
    const s = parseTrx(readFileSync(f, 'utf8'));
    out.total += s.total;
    out.passed += s.passed;
    out.failed += s.failed;
    out.skipped += s.skipped;
    out.failures.push(...s.failures);
  }
  return out;
}
