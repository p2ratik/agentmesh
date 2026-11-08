# ADR 0012 — The mesh window starts in auto mode; secrets are blocked in every mode

**Status:** accepted · 2026-11-08.

## Context

The mesh window ([ADR 0009](0009-mesh-window.md)) ran in Claude Code's `default` (manual) mode, and
its worktree guard asked before every Bash command that wasn't one of its exact forms. In use, that
ask was the bottleneck: a `cat`, a `grep`, a test command spelled slightly differently or a `gh pr
diff` all waited on a human click, so team work stalled whenever the human looked away.

Pratik decided on 2026-11-08:
- the window starts in Claude Code's **auto mode** by default, still opened with `claude-mesh`;
- a teammate can opt out with `agentmesh window init --mode manual`;
- **secrets and personal data are never exposed, in any mode**, as a hard rule in the skill and in
  the guard.

### Claude Code facts this builds on (checked against the docs, 2026-11-08)

1. The hook input carries `permission_mode`: `"auto"` in auto mode and `"default"` in manual mode
   (never `"manual"`); the others are `plan`, `acceptEdits`, `dontAsk` and `bypassPermissions`.
2. A PreToolUse `"deny"` blocks in every mode. An `"ask"` still prompts in auto mode; the classifier
   doesn't decide it. Silence sends the call through the normal flow, which in auto mode is the
   classifier.
3. `--permission-mode auto` is valid. Where auto mode isn't available (plan, model or admin), the
   session starts in manual mode, with no error. `--permission-mode` overrides `defaultMode`.
4. `permissions.deny` rules block in every mode. A `Read(path)` deny also applies to Grep and Glob
   (best effort) and blocks Edit and Write on that path. `Write(...)`, `Grep(...)` and `Glob(...)`
   rules match nothing.
5. `~/x` is under home, `//x` is absolute from the root, `//**/.env` matches anywhere. Windows paths
   are normalised to POSIX form first (`C:\Users\a` is `/c/Users/a`). Symlinks are checked against
   their real target.
6. In auto mode, narrow allow rules still resolve at once; blanket ones like `Bash(*)` are dropped.
7. `disableAutoMode: "disable"` removes auto from the Shift+Tab cycle (a session that would start in
   auto starts in default); `disableBypassPermissionsMode: "disable"` refuses bypass.
8. Auto mode's classifier allows reading `.env` by default, and pushing to any branch, including the
   default branch. It blocks force pushes. So the guard must keep both rules itself.

## Decision

- **`agentmesh window init --mode auto|manual`, default `auto`.** The policy file gains
  `mode` (still `version: 1`; a missing `mode` is a policy from before this change, and an invalid
  one makes the policy invalid). The launcher passes `--permission-mode auto` or `default`, and the
  settings file sets `defaultMode` to match. `disableBypassPermissionsMode: "disable"` always;
  `disableAutoMode: "disable"` only in manual mode, so a teammate who chose manual stays there,
  while one in auto mode can still Shift+Tab to manual.
- **Secrets are denied in every mode, twice.**
  - The settings file's `permissions.deny` holds a `Read(...)` rule for every secret path: `.env`,
    `.env.*`, key files and SSH keys anywhere; credential stores under home (`~/.ssh`, `~/.aws`,
    `~/.azure`, `~/.config/gcloud`, `~/.config/gh`, `~/.kube`, `~/.docker/config.json`, `~/.gnupg`,
    `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, `~/.agentmesh`, Claude's
    credentials); browser profiles; and the window account's own `.credentials.json`.
  - The guard denies a Bash, PowerShell or Monitor command that names one of those paths
    (`secret.path`) or dumps the environment (`secret.env_dump`), before the command list.
  - The list is defined once, in `packages/common/src/secret-paths.ts` (no imports), which the CLI
    and the guard share.
- **The guard follows the live mode.** It reads `permission_mode` from each call, not the policy's
  `mode`, so Shift+Tab changes the rules with the mode. The policy's `mode` drives only the launcher,
  the settings and the session-start line.
- **In auto mode the guard hands unlisted commands to auto mode, past a floor.** A Bash command that
  would ask only for being off the list (`command.not_listed`), and every PowerShell and Monitor
  command, passes with no decision, unless:
  - it matches the risky floor (`command.risky`): any push but the listed own-branch form, merges,
    rebases other than onto the integration branch, branch deletes, hard resets, forced git
    commands, `git checkout --`, `git restore`, and infra commands (`terraform`, `pulumi`, `kubectl`,
    `helm`, `az`, `aws`, `gcloud`, `docker push`, `ssh`, `scp`), matched in any piece of the command;
  - or it runs in a mesh worktree whose branch isn't the window's own (`command.needs_approval`),
    which keeps decision 5 of ADR 0009: a teammate's code runs only with the human's approval.
- **Everything else is unchanged in every mode:** edits stay in registered mesh worktrees; tests on
  a branch the window didn't write, `marker.unverified`, `guard.error` and `Workflow` ask; and the
  rules for SendMessage, isolated agents, EnterWorktree and ListAgents stay as they were. Manual
  mode and every other mode behave as before, apart from the secret deny.
- **What the window and the agent are told.** The window's rules follow `policy.mode` (a missing
  mode reads as manual), and every mode gets the hard rule on secrets. The SessionStart hook tells a
  window whose policy has no `mode` that it starts in manual mode and how to switch. The
  `mesh-collaboration` skill carries the same hard rule for every session.

## Alternatives considered

- **Lighter skill rules instead, still in manual mode.** Telling the window to prefer listed forms
  doesn't remove the ask: the guard's ask outranks every allow rule, and it was the bottleneck.
- **Widen the guard's own list.** Each new exact form is more parsing to get right, and the long
  tail (`cat`, `grep`, `node scripts/x`) never ends. Auto mode's classifier already judges that tail.
- **Rely on auto mode alone.** It allows reading `.env` and pushing to the default branch (fact 8),
  so the guard keeps a floor of its own.
- **Follow the policy's `mode` in the guard.** A human who switched to manual with Shift+Tab would
  still get auto mode's hand-off. The live `permission_mode` is what Claude Code actually does.

## Consequences

- Routine work in the window runs without clicks; the human is asked for pushes beyond the window's
  own branch, merges, history rewrites, deletes, infra and a teammate's code.
- The floor is pattern-based, so it has limits ([security.md](../security.md#auto-mode-in-the-window)):
  an obfuscated command can reach the classifier alone; Bash writes outside worktrees no longer ask
  in auto mode; a secret path built at run time isn't seen by the guard; `.env.example` is blocked
  too (the human pastes it); and where auto mode isn't available the window starts in manual mode.
- A window set up before this change starts in manual mode until `/agentmesh:window` runs again.
- Auto mode in a live window is not yet verified.
