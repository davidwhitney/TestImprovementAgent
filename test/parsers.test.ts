import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeCobertura, methodLabel, ranges, renderGaps, summarise } from '../src/coverage/cobertura.ts';
import { extractBuildErrors } from '../src/dotnet/dotnet.ts';
import { parseMutationReport, StrykerProgressTracker } from '../src/dotnet/stryker.ts';
import { parseTrx } from '../src/dotnet/trx.ts';
import { parseHarnessReport } from '../src/agents/index.ts';

const cobertura = (lines: [number, number][], extra = '') => `<?xml version="1.0"?>
<coverage line-rate="0" branch-rate="0">
  <sources><source>/repo/</source></sources>
  <packages><package name="App"><classes>
    <class name="App.OrderService/&lt;Create&gt;d__2" filename="src/App/OrderService.cs">
      <methods><method name="MoveNext" signature="()"><lines>
        ${lines.map(([n, h]) => `<line number="${n}" hits="${h}" branch="false" />`).join('\n')}
      </lines></method></methods>
      <lines>${lines.map(([n, h]) => `<line number="${n}" hits="${h}" branch="false" />`).join('')}</lines>
    </class>
    ${extra}
  </classes></package></packages>
</coverage>`;

describe('cobertura', () => {
  it('unions hits across reports from several test projects', () => {
    const merged = mergeCobertura(cobertura([[10, 0], [11, 0], [12, 3]]));
    mergeCobertura(cobertura([[10, 1], [11, 0], [12, 0]]), merged);
    const r = summarise(merged, '/repo', []);
    assert.equal(r.coverable, 3);
    assert.equal(r.covered, 2);
    assert.equal(r.percent, 66.66);
    assert.deepEqual(r.files[0]!.uncoveredByMethod, { 'OrderService.Create': [11] });
  });

  it('excludes entry-point files from the target but reports the raw figure', () => {
    const program = `<class name="Program" filename="src/App/Program.cs"><methods/><lines><line number="1" hits="0"/><line number="2" hits="0"/></lines></class>`;
    const r = summarise(mergeCobertura(cobertura([[10, 1]], program)), '/repo', ['/repo/src/App/Program.cs']);
    assert.equal(r.percent, 100);
    assert.equal(r.rawPercent, 33.33);
    assert.deepEqual(r.excludedFiles, ['src/App/Program.cs']);
  });

  it('ignores generated files and parses branch coverage', () => {
    const gen = `<class name="Gen" filename="src/App/obj/Debug/Gen.g.cs"><methods/><lines><line number="1" hits="0"/></lines></class>
      <class name="App.X" filename="src/App/X.cs"><methods/><lines><line number="5" hits="1" branch="true" condition-coverage="50% (1/2)"/></lines></class>`;
    const r = summarise(mergeCobertura(cobertura([], gen)), '/repo', []);
    assert.equal(r.coverable, 1);
    assert.equal(r.branchPercent, 50);
  });

  it('labels async state machines and nested types', () => {
    assert.equal(methodLabel('App.OrderService/<Create>d__2', 'MoveNext'), 'OrderService.Create');
    assert.equal(methodLabel('App.Outer/Inner', 'Run'), 'Outer.Inner.Run');
    assert.equal(methodLabel('App.Endpoints/<>c', '<Map>b__0_0'), 'Endpoints.Map');
  });

  it('compresses line ranges and renders a gap table', () => {
    assert.equal(ranges([1, 2, 3, 7, 9, 10]), '1-3, 7, 9-10');
    const md = renderGaps(summarise(mergeCobertura(cobertura([[10, 0], [11, 0]])), '/repo', []));
    assert.match(md, /src\/App\/OrderService\.cs \| 0\/2 \| 2/);
    assert.match(md, /`OrderService.Create` — lines 10-11/);
  });
});

describe('trx', () => {
  it('extracts counts and failure details', () => {
    const s = parseTrx(`<TestRun><Results>
      <UnitTestResult testName="A.Passes" outcome="Passed" />
      <UnitTestResult testName="A.Fails" outcome="Failed"><Output><ErrorInfo><Message>Expected 200 but was 500</Message><StackTrace>at A.Fails()</StackTrace></ErrorInfo></Output></UnitTestResult>
    </Results><ResultSummary outcome="Failed"><Counters total="2" executed="2" passed="1" failed="1" /></ResultSummary></TestRun>`);
    assert.equal(s.total, 2);
    assert.equal(s.failed, 1);
    assert.deepEqual(s.failures, [{ name: 'A.Fails', message: 'Expected 200 but was 500', stackTrace: 'at A.Fails()' }]);
  });
});

describe('build errors', () => {
  it('pulls compiler and msbuild errors out of dotnet build output', () => {
    const out = `  Determining projects to restore...
/r/tests/T.cs(10,5): error CS0103: The name 'x' does not exist in the current context [/r/tests/T.csproj]
/r/tests/T.cs(10,5): error CS0103: The name 'x' does not exist in the current context [/r/tests/T.csproj]
warning CS1234: meh`;
    assert.deepEqual(extractBuildErrors(out), ["/r/tests/T.cs(10,5): error CS0103: The name 'x' does not exist in the current context"]);
  });
});

describe('stryker report', () => {
  it('scores like Stryker and lists survivors with source context', () => {
    const r = parseMutationReport(
      JSON.stringify({
        files: {
          '/repo/src/App/OrderService.cs': {
            source: 'line1\n    if (total > 1000) total *= 0.9m;\n',
            mutants: [
              { mutatorName: 'Equality mutation', replacement: 'total >= 1000', status: 'Survived', location: { start: { line: 2 } } },
              { mutatorName: 'Arithmetic mutation', replacement: 'total /= 0.9m', status: 'Killed', location: { start: { line: 2 } } },
              { mutatorName: 'Block removal', replacement: '{}', status: 'NoCoverage', location: { start: { line: 1 } } },
              { mutatorName: 'String mutation', replacement: '""', status: 'Timeout', location: { start: { line: 1 } } },
              { mutatorName: 'Linq', replacement: 'x', status: 'CompileError', location: { start: { line: 1 } } },
            ],
          },
        },
      }),
      '/repo',
    );
    assert.equal(r.score, 50);
    assert.equal(r.survivors.length, 2);
    assert.deepEqual(r.survivors[1], { file: 'src/App/OrderService.cs', line: 2, mutator: 'Equality mutation', replacement: 'total >= 1000', original: 'if (total > 1000) total *= 0.9m;', status: 'Survived' });
  });
});

describe('harness report', () => {
  it('takes the last valid block, tolerating code fences and template examples', () => {
    const text = `Here is the format:
<harness-report>
{"status": "done" | "partial", "summary": "..."}
</harness-report>
Work done.
<harness-report>
\`\`\`json
{"status": "partial", "summary": "covered OrderService", "testsAdded": 7}
\`\`\`
</harness-report>`;
    assert.deepEqual(parseHarnessReport(text), { status: 'partial', summary: 'covered OrderService', testsAdded: 7 });
  });

  it('returns undefined when there is no block', () => {
    assert.equal(parseHarnessReport('all done!'), undefined);
  });
});

describe('stryker progress', () => {
  it('counts dots reporter output across chunks, ignoring log lines', () => {
    const t = new StrykerProgressTracker();
    t.push('[10:54:04 INF] 4 mutants got status Ignored.\n[10:54:04 INF] 10 total mutants will be tes');
    t.push('ted\n..S.[10:54:09 INF] some log with S and . in it\n');
    t.push('.T.');
    t.push('.\nTime Elapsed 00:01\n');
    assert.deepEqual(t.progress, { total: 10, tested: 8, killed: 6, survived: 1, timeout: 1 });
    assert.match(t.describe()!, /tested 8\/10 mutants \(80%\): 6 killed, 1 survived, 1 timeout, ETA/);
  });
});
