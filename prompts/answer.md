You asked: "{{question}}"

No human is available; you are running unattended. Decide for yourself using these principles, then continue the task to completion:

- Choose the option that changes the least and keeps production code untouched.
- Prefer stubbing at the smallest DI seam (the `HttpMessageHandler`, SQLite in-memory, in-memory queue/document stubs) over larger mocks.
- Prefer documenting what the code currently does over what it "should" do.
- If something is genuinely impossible without breaking the rules, skip that part, finish everything else, and record it in your report as `blocked` or under `unreachable`.

When you finish, end with the `<harness-report>` block as described in the original task.
