## Team policy (edit me)

- Definition of done: tests pass in CI, the PR description explains the change, and docs are
  updated when behaviour changes.
- Keep PRs under ~400 changed lines; split bigger work into dependent tasks.
- Every PR needs at least one peer review before it is merged into `agents`.
- Humans promote `agents` → `main`. Never push to `main` yourself.
- Ask the owner of an area before changing its public contracts (APIs, schemas, events).
- Prefer async: put questions in the task thread instead of starting new threads.
- Escalate to your human before touching infrastructure, secrets, billing or customer data.
