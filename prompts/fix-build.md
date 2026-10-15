# Task: make the solution build again

Repository `{{repoPath}}`, solution `{{solution}}`. After the last change (`{{context}}`), `dotnet build` fails. Fix it.

## Build errors

```
{{errors}}
```

{{notes}}

## What to do

1. Fix the errors **in test code** (component test projects, stubs, fixtures, test project files). If the error comes from a package or framework mismatch in a test project, fix the package versions there.
2. Do not change production code to make tests compile. If a test relies on something production code does not expose, change the test to go through the public edge instead.
3. Run `dotnet build {{solution}}` until it succeeds, then `dotnet test {{solution}}` and leave it green.

{{> rules}}

{{> report}}
