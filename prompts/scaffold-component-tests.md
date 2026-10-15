# Task: scaffold outside-in component tests

The repository at `{{repoPath}}` (solution `{{solution}}`) currently has **{{coverage}}%** branch coverage. An automated harness will spend many iterations raising that to **{{target}}%**. Before it can, the solution needs a component-test harness that boots the application in memory with its external dependencies stubbed out. Your job in this session is to build that foundation well; later sessions will add the bulk of the tests on top of it.

## The application

{{projectSummary}}

## What to do

1. **Map the outside edges.** Read the composition root (`Program.cs` / `Startup.cs` / DI extension methods) and list every way the application talks to the outside world: inbound HTTP endpoints, message consumers and hosted/background services; and outbound HTTP clients, databases, document stores, caches, queues/buses, file/blob storage, clocks. For each outbound dependency, identify the **smallest DI seam** that can be swapped (see the standards below).
2. **Create the component test project** `{{componentProjectName}}` (unless an equivalent already exists), add it to `{{solution}}`, reference the application project, and include `Microsoft.AspNetCore.Mvc.Testing` (for web apps), `coverlet.collector` and `coverlet.msbuild`. Add `Microsoft.Data.Sqlite` / `Microsoft.EntityFrameworkCore.Sqlite` if a relational database is involved.
3. **Write the fixture**: a `WebApplicationFactory<Program>` subclass (or in-memory host builder for non-web apps) plus a `Stubs/` folder containing a recording `HttpMessageHandler` stub, and in-memory stubs for each database/queue/document store you found. The fixture creates fresh stubs and binds them in `ConfigureTestServices` every time it starts a host, and exposes them to tests so tests can arrange responses and verify calls.
4. **Write a few smoke tests** (two to five) proving the harness works end to end: the host starts, one representative endpoint or consumer runs through real production code, and the test verifies both the response and the calls recorded by at least one stub.
5. Write `{{componentProjectDir}}/README.md` documenting the seam map from step 1: each external dependency, the seam replaced, and the stub that replaces it. Later sessions rely on this file.

{{previousAttempt}}

{{> testing-standards}}

{{> rules}}

{{> report}}
