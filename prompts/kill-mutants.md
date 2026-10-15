# Task: kill surviving mutants

Repository `{{repoPath}}`, solution `{{solution}}`. This is mutation iteration {{iteration}}.

- Mutation score: **{{mutationScore}}%**, target **{{mutationTarget}}%**
- Branch coverage: {{coverage}}% (must stay at or above {{target}}%)

Each surviving mutant below is a small change to production code that **no test noticed**: either no test executes that line ("NoCoverage"), or tests execute it without asserting on its effect ("Survived"). The full list is in `.coverage-harness/surviving-mutants.md` (machine-readable: `.coverage-harness/surviving-mutants.json`).

{{survivors}}

{{history}}

## What to do

For each mutant, work out what observable behaviour would change if the mutation were applied, then make a component test assert on it:

- **Boundary and comparison mutants** (`<` → `<=`, `==` → `!=`): add tests at and either side of the boundary.
- **Arithmetic, string and LINQ mutants**: assert the exact computed values in responses, persisted documents or outbound calls, not just their presence.
- **Boolean, conditional and negation mutants**: cover both outcomes of the condition through the edge.
- **Statement and block removal** (a call removed): verify the side effect, such as the stub recording the outbound request, the document written, the message published, or the header set.
- **NoCoverage**: write the missing test through the outside edge, as in the coverage phase.

Prefer strengthening existing tests' assertions where they already exercise the line; add new tests where they don't. If you are confident a mutant is behaviourally equivalent (no possible test can distinguish it), do not add Stryker disable comments; list it under `equivalentMutants` in your report.

Keep the whole suite green and do not reduce branch coverage.

{{> testing-standards}}

{{> rules}}

{{> report}}
