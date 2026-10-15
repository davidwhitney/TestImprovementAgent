## Testing standards

Tests are **outside-in component tests**: they start the real application in memory and drive it only through its external edges, the way a real caller would.

**Hosting**
- ASP.NET Core apps: use `Microsoft.AspNetCore.Mvc.Testing` and a `WebApplicationFactory<Program>` subclass. Drive the app with the `HttpClient` from `CreateClient()`.
- Worker services, message consumers and other non-HTTP hosts: build the real host (`Host.CreateApplicationBuilder` / the app's own host-building code) in memory, swap the same seams, and drive it by publishing to the in-memory queue stub or invoking the hosted service.
- Component tests live in a dedicated `<AppName>.ComponentTests` project, which is part of the solution.

**Isolation: replace the smallest possible seam through DI, inside `ConfigureTestServices` / `ConfigureServices`, so as much real production code as possible runs.**
- *Outbound HTTP*: never mock the typed client or the service interface that wraps it. Replace only the `HttpMessageHandler`, for example `services.AddHttpClient<TClient>().ConfigurePrimaryHttpMessageHandler(() => stubHandler)` or `services.ConfigureHttpClientDefaults(b => b.ConfigurePrimaryHttpMessageHandler(() => stubHandler))`. The stub handler returns canned downstream responses (success, 4xx, 5xx, timeouts, malformed bodies) and records every request it receives.
- *Relational databases (EF Core / ADO.NET)*: use SQLite in-memory (`DataSource=:memory:`, keeping one open `SqliteConnection` per fixture) and create the schema from the real model or migrations. Avoid the EF InMemory provider unless SQLite genuinely cannot express the schema.
- *Document databases (Cosmos, Mongo, DynamoDB, Redis, blob/table storage…)*: replace the lowest-level repository or client abstraction the app registers with an in-memory stub that stores documents in dictionaries.
- *Service bus / message queues / event streams*: replace the sender/publisher/processor abstraction with an in-memory stub. Tests push messages into it to trigger consumers and inspect what the app published.
- *Clock, GUIDs, randomness, configuration*: replace `TimeProvider`/clock abstractions with fakes and override configuration with `UseSetting` / in-memory configuration so tests are deterministic.

**Stubs and fixtures**
- Define stubs in the component test project (for example a `Stubs/` folder). Create them in the test fixture (an xUnit class/collection fixture or a shared builder function) and register them when the test server starts the host, so each host instance gets fresh, rebound stubs.
- Reset stub state between tests, or create a fresh factory per test class, so tests never depend on each other or on execution order.
- Every test both arranges stub state **and verifies how the stubs were called**: requests sent downstream (method, URL, headers, body), documents written, messages published.

**Style**
- One behaviour per test, named `Method_Scenario_ExpectedBehaviour` or as a readable sentence.
- Arrange / Act / Assert, asserting status codes, response bodies, headers and side effects precisely (exact values, not just "not null"). Precise assertions are what kill mutants later.
- Use the test framework and assertion library the solution already uses. If there is none, use xUnit with its built-in asserts.
- No `Thread.Sleep`; await the condition or use the fake clock.
