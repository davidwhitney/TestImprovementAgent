# Task: raise branch coverage by documenting existing behaviour

Repository `{{repoPath}}`, solution `{{solution}}`. This is iteration {{iteration}} of an automated loop.

- Current branch coverage: **{{coverage}}%** (statement coverage {{statementCoverage}}%)
- Target: **{{target}}%**
- Component test project(s): {{componentProjects}} (see the README in that project for the map of stubbed dependencies)

The entry point itself (`Program.cs` / `Main`) is excluded from the target, but everything it calls must be covered.

## Where the gaps are

The target is **branch coverage**: every outcome of every decision (`if`/`else`, `switch` arms, `?:`, `??`, `?.`, `&&`/`||`, loops, pattern matches, null/empty checks) has to be exercised, so executing a line is not enough. The full, current gap report is in `.coverage-harness/coverage-gaps.md` (machine-readable: `.coverage-harness/coverage-summary.json`). The files with the most unexercised branches:

{{gaps}}

{{history}}

{{plan}}

## What to do

1. Pick the next areas to cover: if a coverage plan is given above, work through it **in order**, finishing the earliest unfinished wave before touching a later one (the gap report is authoritative about what is still uncovered, so skip plan items that are already covered). If an item turns out much harder than its estimate, skip it, note it in your report and move on rather than getting stuck. Without a plan, pick the largest uncovered areas above. For each, read the production code, work out **which external input reaches it** (an HTTP request, a message on a queue, a downstream response, a configuration value, a stored record), and write component tests that drive that input through the application's outside edge.
2. Cover the unhappy paths as well as the happy ones: validation failures, not-found, downstream 4xx/5xx/timeouts (via the stub `HttpMessageHandler`), empty and malformed data, and conflicting state in the stub stores. Error-handling and the *other* side of each condition (the `else`, the null case, the empty list, the false guard) are usually where the gaps are: for each listed line, work out which input makes the decision go the way no test has yet.
3. Extend the existing fixture and stubs rather than creating parallel ones. Add new stubs only for dependencies that are not stubbed yet, at the smallest seam.
4. Assert precisely: exact status codes, bodies, headers, persisted documents and outbound calls recorded by the stubs.
5. If a branch genuinely cannot be triggered through any external edge (for example defensive code behind a race condition), you may write a focused test at the lowest public seam inside the component test project. If code is truly unreachable dead code, do not test it; list it under `unreachable` in your report.
6. Work in small increments, running `dotnet test` frequently. Leave everything green.

Aim to close as many of the listed gaps as you can in this session; the harness will measure the result and come back with the next batch.

{{> testing-standards}}

{{> rules}}

{{> report}}
