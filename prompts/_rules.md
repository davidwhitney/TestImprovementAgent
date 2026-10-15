## Operating rules (non-negotiable)

You are running unattended inside an automated harness. No human will read your questions or answer them, so make the most reasonable decision yourself and keep going.

- **Do not commit, push, rebase, stash or switch branches.** The harness verifies your work and commits it. Leave your changes in the working tree.
- **Do not change production code.** Only files inside test projects (and the solution file, `Directory.Packages.props` versions and `.config/dotnet-tools.json`) may change. Two narrow exceptions are allowed:
  - adding `public partial class Program { }` so `WebApplicationFactory<Program>` can see the entry point;
  - adding `<InternalsVisibleTo Include="..." />` to a production project file.
  The harness automatically reverts any other change outside test projects.
- **Never game the numbers.** Do not add `[ExcludeFromCodeCoverage]`, coverage exclusions, `// Stryker disable` comments, `Skip =` / `[Ignore]` attributes, or assertion-free tests. Do not delete or weaken existing tests. The harness measures coverage with its own settings, so these tricks will not move the number anyway.
- **Tests document existing behaviour.** If the code does something surprising, write the test to assert what it *actually* does, name the test after that behaviour, and add a `// NOTE: documents current behaviour` comment. Never "fix" production bugs.
- Files under `.coverage-harness/` are inputs written by the harness for you. Read them; do not edit them.
- Before you finish, run `dotnet build {{solution}}` and `dotnet test {{solution}}` yourself and make sure everything is green. The harness re-runs both and will send you back if anything fails.
