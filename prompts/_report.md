## How to finish

End your final message with exactly one report block. The harness parses it, so it must be valid JSON:

<harness-report>
{"status": "done", "summary": "one or two sentences on what you changed", "testsAdded": 0}
</harness-report>

- `status` is one of `done` (task complete), `partial` (made progress, more remains), `blocked` (cannot proceed; add `"blockers": "why"`) `needs-input` (add `"question": "..."`; avoid this — decide yourself whenever possible) or, for the iterative coverage and mutation tasks only, `diminishing-returns` (see the task's instructions; add `"reason": "what is left and why it is not worth chasing"`).
- Optional `"unreachable": ["File.cs:Method — reason"]` lists code you are confident cannot be reached from any external edge of the application.
- Optional `"equivalentMutants": ["File.cs:line Mutator — reason"]` lists surviving mutants you believe are behaviourally equivalent.
