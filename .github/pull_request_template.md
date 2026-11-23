## What and why

<!-- What changes, and the problem it solves. Link the issue: "Fixes #123". -->

## Checklist

- [ ] `pnpm check` passes (typecheck, lint, file sizes, unit tests).
- [ ] Behaviour changes update the matching `docs/*.md`; new config options are in `docs/configuration.md` and `config/examples/`.
- [ ] A change to auth, permissions, secrets or the network surface has a threat note in `docs/security.md`.
- [ ] A change the plugin bundles rebuilds `plugins/agentmesh/dist/` and bumps the version.
- [ ] No secret anywhere in the diff, the tests or this description.
