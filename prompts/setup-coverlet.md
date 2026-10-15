# Task: add Coverlet coverage instrumentation

The repository at `{{repoPath}}` is a .NET solution (`{{solution}}`). An automated harness is about to raise its test coverage using Coverlet, so that `dotnet test --collect "XPlat code coverage"` produces Cobertura reports with line **and branch** data.

## Current state

{{projectSummary}}

## What to do

1. Add a `coverlet.collector` package reference to **every test project** listed above that is missing it. Use the latest stable version compatible with each project's target framework.
   - If the repo uses central package management (`Directory.Packages.props` with `ManagePackageVersionsCentrally`), add a `<PackageVersion>` entry there and a version-less `<PackageReference>` in each project.
   - Prefer `dotnet add <project> package coverlet.collector` where it works.
2. Do not create new test projects, write any tests, or change any coverage settings or exclusions.
3. Run `dotnet build {{solution}}` and `dotnet test {{solution}} --collect "XPlat code coverage"` and confirm a `coverage.cobertura.xml` file is produced.

{{previousAttempt}}

{{> rules}}

{{> report}}
