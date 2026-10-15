# Task: fix failing tests

Repository `{{repoPath}}`, solution `{{solution}}`. After the last change (`{{context}}`), `dotnet test` is red. The full details are in `.coverage-harness/failing-tests.md`.

## Failures

{{failures}}

{{notes}}

## What to do

For each failing test, work out why it fails and fix the **test**:

- **Wrong expectation.** These tests document existing behaviour, so if the assertion disagrees with what the production code actually does, change the assertion to match reality. Name the test after the real behaviour and add `// NOTE: documents current behaviour` if that behaviour looks like a bug.
- **Isolation problem** (shared stub state, test order dependence, port/file clashes, static state, parallelism): fix the fixture so each test gets fresh, rebound stubs.
- **Missing stub or wrong seam** (the test escaped to a real network, database or queue): stub the dependency at the smallest DI seam.
- **Flaky timing**: remove sleeps, await conditions, use a fake clock.
- **Infrastructure failure** (test host crash, hang, missing SDK/runtime): fix the test project configuration.

Do not delete, skip or weaken tests to get to green. If a test is fundamentally invalid, replace it with a correct test of the same behaviour. Do not change production code.

Run `dotnet test {{solution}}` until it is fully green.

{{> testing-standards}}

{{> rules}}

{{> report}}
