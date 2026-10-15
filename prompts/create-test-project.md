# Task: create a test project

The repository at `{{repoPath}}` is a .NET solution (`{{solution}}`) that has **no test project**. An automated harness is about to raise its test coverage and needs a test project to run. Coverage collection is set up by the harness separately, so **do not add coverlet or any other coverage package**.

## Current state

{{projectSummary}}

## What to do

1. Create `{{componentProjectDir}}` as an xUnit test project (`{{componentProjectName}}`) targeting the same framework as the application. It must reference `Microsoft.NET.Test.Sdk` (17.x or later; it carries the coverage collector), `xunit` and `xunit.runner.visualstudio`.
2. Reference the application project(s), add `Microsoft.AspNetCore.Mvc.Testing` if the app is an ASP.NET Core app, and add the new project to `{{solution}}`.
   - If the repo uses central package management (`Directory.Packages.props` with `ManagePackageVersionsCentrally`), add `<PackageVersion>` entries there and version-less `<PackageReference>` entries in the project.
3. Add one trivial passing test so the project is discovered. Do not write any other tests yet. Do not change any coverage settings or exclusions.
4. Run `dotnet build {{solution}}` and `dotnet test {{solution}}` and confirm the test passes.

{{previousAttempt}}

{{> rules}}

{{> report}}
