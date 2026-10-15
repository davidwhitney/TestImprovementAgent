# Task: add Coverlet coverage instrumentation

The repository at `{{repoPath}}` is a .NET solution (`{{solution}}`). An automated harness is about to raise its test coverage, and first needs Coverlet so that `dotnet test --collect "XPlat Code Coverage"` produces Cobertura reports.

## Current state

{{projectSummary}}

## What to do

1. Add **both** `coverlet.collector` and `coverlet.msbuild` package references to **every test project** listed above that is missing them. Use the latest stable versions compatible with each project's target framework.
   - If the repo uses central package management (`Directory.Packages.props` with `ManagePackageVersionsCentrally`), add `<PackageVersion>` entries there and version-less `<PackageReference>` entries in the projects.
   - Prefer `dotnet add <project> package <id>` where it works.
2. {{noTestProjectInstruction}}
3. Do not write any tests yet beyond what already exists. Do not change any coverage settings or exclusions.
4. Run `dotnet build {{solution}}` and `dotnet test {{solution}} --collect "XPlat Code Coverage"` and confirm a `coverage.cobertura.xml` file is produced.

{{previousAttempt}}

{{> rules}}

{{> report}}
