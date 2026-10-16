# Task: simplify the test suite, keeping outside-in coverage

Repository `{{repoPath}}`, solution `{{solution}}`. This is simplification pass {{iteration}} of an automated loop. Coverage has already been raised; the suite now needs to get **smaller and more meaningful without losing coverage**.

- Branch coverage right now: **{{coverage}}%** ({{branchesCovered}} branches covered; statement coverage {{statementCoverage}}%)
- Tests in the suite: **{{testCount}}**
- Component test project(s): {{componentProjects}}

## The rule that judges your work

The harness re-measures after your changes. If the number of covered branches goes **down**, everything you did in this pass is thrown away. Equal or higher is accepted. Deleting tests that add no coverage is exactly what is wanted, but you can only know that by checking.

## Philosophy

Outside-in tests are the primary suite: they start the real application and drive it through its external edges (HTTP, messages, configuration, downstream responses), which is how the system is actually used and how its accessible behaviour is explored. Where an outside-in test already exercises a code path, a unit test of the same path is redundant duplication that slows the suite and pins internal structure.

Keep a unit test only when it is one of:
1. **Significant algorithmic complexity**: calculations, parsers, state machines, date/interest/fee/rounding logic, validation rules with many combinations, where exhaustive input tables are far cheaper at the unit level than through the outside edge.
2. **Code that cannot be reached from the outside-in tests** (defensive or error-handling code with no external trigger). This should be rare; if you think a branch needs this, first try to reach it through the external edge.

Everything else should be removed, or folded into an outside-in test.

## What to do

1. Survey the suite: list the test projects, which are outside-in (`WebApplicationFactory`/host-based component tests) and which are unit-level (constructing classes directly, mocking collaborators, testing one class in isolation). Look for tests that mock the things the component tests stub for real.
2. For each unit-level test class, decide: is the code it covers reached by the outside-in tests (check `.coverage-harness/coverage-gaps.md` and reason from the production code and the component tests), and does it fall under keep rule 1 or 2? If not, it is a candidate for removal.
3. If removing a candidate would lose branches, first write the **outside-in test** that reaches them through an external edge (extend the existing fixture and stubs), then delete the unit test. Do not keep both.
4. Also remove tests that are clearly redundant even among the outside-in ones: exact duplicates, tests of the same scenario with trivially different data that do not change which branches run (merge them into a `[Theory]` if the variation is meaningful), and tests of trivial members (DTO getters, constructors, auto-properties).
5. Do not weaken assertions of the tests you keep, and never delete a test just because it is failing: fix it or tell the harness it is blocked.
6. Delete in coherent chunks and run `dotnet test` with coverage as you go. If you cannot tell whether a deletion is safe, check by running the suite without that test and comparing the covered branches against {{branchesCovered}}.
7. Delete empty test classes, unused helpers/builders/mocks and unused package references in the test projects when the removal leaves them dead.

Only change test projects. Production code is off limits (the harness reverts such changes).

{{history}}

## Knowing when to stop

If what remains is only unit tests that satisfy the keep rules (or tests you cannot remove without losing branches), the suite is done: make no changes and end with `"status": "done"` and a summary of what you kept and why. The harness stops the loop when a pass removes no tests.

{{> testing-standards}}

{{> rules}}

**Exception to the rules above, for this task only:** you are explicitly allowed (and expected) to delete tests that the criteria above identify as redundant. Everything else in the rules still applies, in particular: no skipping or ignoring tests, no coverage exclusions, no weakening of the assertions in tests you keep.

{{> report}}
