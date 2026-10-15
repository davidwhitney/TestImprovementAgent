# Task: set up Stryker.NET mutation testing

Repository `{{repoPath}}`, solution `{{solution}}`. Statement coverage has reached **{{coverage}}%**. Next, the harness will use mutation testing to find tests that execute code without really checking it. Set up Stryker.NET so the harness can run it.

## What to do

1. Create a local tool manifest if there is none (`dotnet new tool-manifest` at the repo root, giving `.config/dotnet-tools.json`) and install Stryker into it: `dotnet tool install dotnet-stryker`.
2. Create `stryker-config.json` **at the repository root** so that, from the repo root, the harness can run:

   ```
   dotnet stryker --config-file stryker-config.json --reporter json --reporter progress --output <dir>
   ```

   The config must:
   - point at `{{solution}}` (`"solution"`) and list the test project(s) (`"test-projects"`): {{testProjects}};
   - mutate production code only, excluding the entry point and generated code (for example `"mutate": ["**/*.cs", "!**/Program.cs", "!**/Migrations/**", "!**/obj/**"]`);
   - use `"mutation-level": "Standard"` and the `json`, `html` and `progress` reporters;
   - set `"thresholds": {"high": {{mutationTarget}}, "low": 60, "break": 0}`;
   - set a sensible `"concurrency"` and `"additional-timeout"` so in-memory hosts have time to start.
3. Run Stryker once yourself, if time allows, to prove the configuration works. It can be slow; it is enough to confirm it starts mutating and testing without configuration errors.
4. Do not change tests or production code in this step.

{{previousAttempt}}

{{> rules}}

{{> report}}
