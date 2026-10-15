# Task: plan the order of attack for raising branch coverage

Repository `{{repoPath}}`, solution `{{solution}}`. This is a **planning step only**: do not write or change any code or tests.

- Current branch coverage: **{{coverage}}%** (statement coverage {{statementCoverage}}%)
- Target: **{{target}}%**
- Component test project(s): {{componentProjects}}

An automated loop will next raise coverage with component tests, one batch per iteration. The goal is **rapid acceleration first, then the long tail**: the early iterations should gain as many percentage points as possible for the least effort, and the fiddly, expensive branches should be left until last. Your job is to decide that order.

## The data

The largest current gaps (files with the most unexercised branches, with the lines and `covered/total` branch counts per method):

{{gaps}}

The full report is in `.coverage-harness/coverage-gaps.md` (machine-readable: `.coverage-harness/coverage-summary.json`).

## What to do

1. Read the production code behind the biggest gaps, and the existing component test fixture and stubs, enough to judge for each gap **how many branches it is worth and how hard it is to reach**.
2. Rank gaps by **branches gained per unit of effort**. Quick wins look like:
   - whole endpoints, handlers, controllers or services with no tests at all, where one or two requests through the existing fixture exercise many branches;
   - a single new request or stub setup that unlocks several methods at once;
   - simple validation, not-found and empty-input paths that only need a different request body or stub response.
3. Push to the long tail anything that is expensive per branch: new stubs or infrastructure for a dependency that is not stubbed yet, timing, races and retries, deep downstream failure combinations, obscure defensive code, and branches the compiler generates (async state machines, `?.` chains, pattern-matching lowering) that are hard to hit individually. Note any code that looks truly unreachable from an external edge.
4. Group the work into waves and write the plan to **`.coverage-harness/coverage-plan.md`** (this is the one file you may create or edit under `.coverage-harness/`), in this shape:

```
# Coverage plan

## Wave 1: quick wins (est. +X pts, to ~Y%)
1. `path/File.cs` `Method` (N branches, effort S): which external input reaches it and what to assert
...
## Wave 2: ...
## Wave 3: the long tail (do last)
...
## Likely unreachable / not worth testing
```

   Keep each item to one or two lines, name the real files and methods, and give an effort size (S, M or L). Put estimated branch counts and a rough cumulative coverage estimate on each wave heading. Wave 1 should be sized to be one or two sessions of work, and every item in it should be S effort or a high-value M.

Do not run the test suite or change anything else.

{{> rules}}

{{> report}}
