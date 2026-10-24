# ADR 0007 — A Claude-run setup over a deterministic CLI

**Status:** accepted · 2026-10-24. Design: [setup design](../specs/2026-10-23-setup-design.md).
Plan: [setup plan](../specs/2026-10-23-setup-plan.md).

## Context

AgentMesh goes public soon. Its users are self-hosted startup teams of 5–15 people who already use
Claude Code, plugins and MCP. Until now one admin needed about an hour of manual work to stand up a
mesh:

- clone the repo, `pnpm install && pnpm build`, `pnpm mesh init`;
- write `mesh.yaml` and `deploy/.env` by hand;
- create the Discord bot, then dig out the application id, server id and Discord user ids through
  Developer Mode;
- run `keys add` six times and `nats-config` with the right flags;
- create a VM, get a certificate, copy four kinds of files to it, and build the images on the VM.

Opzami's own deploy went this way, and the Discord bot token ended up pasted into a chat on
2026-10-17. Another company should be able to get the same result by answering Claude's questions.

## Decision

- **Claude conducts, a CLI does the work.**
  - `/agentmesh:setup` is a plugin skill (`plugins/agentmesh/skills/setup/SKILL.md`, user-only
    through `disable-model-invocation: true`). Claude asks the questions, explains each step and
    what went wrong, and runs the CLI one step at a time.
  - Every change is made by `agentmesh` CLI steps that are deterministic and safe to re-run:
    `setup render`, `setup discord`, `setup host`, `setup deploy`, `setup admin` and
    `setup invites`, plus `setup status`, `doctor` and `upgrade`.
  - **Answers are structured data.** Claude writes one file, `setup-answers.json`, which a zod
    schema checks (`apps/cli/src/setup/answers.ts`). Pure renderers turn it into `mesh.yaml`, the
    team policy, `.env`, the compose file and `nats.conf`. Claude never writes YAML.
  - **Progress is saved** in `.agentmesh-setup.json` in the workspace, which holds no secrets. A
    re-run skips finished steps, and no step overwrites a seed.
  - **The CLI ships inside the plugin** as a second bundle, `dist/cli.js`, which the skill runs as
    `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <step> --dir "<workspace>"`. The admin installs
    nothing else, and the CLI's version is the plugin's. `keys add`, `nats-config` and `validate`
    are reused, not rewritten.
- **Published images and one version.**
  - A version bump merged to `main` is a release. CI (`.github/workflows/release.yml`) builds the
    hub and Discord bridge images for amd64 and arm64, pushes them to GHCR and tags the commit
    `vX.Y.Z`. A version that is already tagged is skipped.
  - The compose file setup writes pulls
    `${AGENTMESH_IMAGE_REGISTRY}/agentmesh-hub:${AGENTMESH_VERSION}` (and the bridge image), so a
    server needs only Docker: no clone and no build.
  - The registry is configuration. The default is `ghcr.io/p2ratik` (`DEFAULT_IMAGE_REGISTRY` in
    `apps/cli/src/setup/defaults.ts`); `setup render --registry` sets another.
  - One version for everything: `VERSION` in `packages/common/src/version.ts`, every
    `package.json` and `plugin.json`. A unit test fails when any of them differs.
  - **The workspace pins the hub version.** Setup writes the plugin's version into `.env` as
    `AGENTMESH_VERSION`. `setup deploy` always uses that pin, so updating the plugin never
    upgrades the hub silently; only `agentmesh upgrade` moves it.
- **Agents never act as admins.**
  - Setup writes the first admin into `mesh.yaml`: a human with `roles: [admin]` and a
    `discordUserId`, plus their agent with its public key. `mesh.yaml` wins over the registry, so
    a registry change cannot lock the first admin out.
  - Admin RPCs accept only human callers with the `admin` role, and humans reach the hub only
    through the Discord bridge. Setup prints the `/mesh invite` lines; the admin runs them.
  - Operator commands (`setup deploy`, config edits, `ssh`) run from the workspace with the admin's
    own SSH key. They are not mesh RPCs. Setup never adds allow rules for the CLI, `ssh` or `scp`,
    so each one needs the admin's approval in the terminal, even when a mesh message asks for it.

## Consequences

- **Releases couple the plugin to its images.**
  - Every bundled change already bumps the version (Claude Code caches plugins by version), so
    every plugin change is now a release with new images, even when the hub did not change.
  - Between a merge and the end of the release workflow, a new workspace pins a version whose
    images are not pushed yet. Its deploy fails at the pull with a line naming the image, and a
    re-run after the workflow finishes continues.
  - The tag is pushed last, so if the workflow fails before it, the next push to `main` tries the
    release again.
  - Images can be pulled only once the repo and both GHCR packages are public.
  - Hub-only releases don't force teammates to update. The hub's minimum plugin version moves only
    when the protocol needs it, as it did for 0.3.0.
- **The workspace is the source of truth.**
  - The answers file feeds only the first render and the invite lines. Teammates appear only in
    those lines, never in `mesh.yaml`.
  - After the first render the admin changes the files in `config/`, runs `validate`, then
    `setup deploy`. Render never replaces a file that differs without `--force`, never replaces
    `.env` (it holds the token) and never overwrites a seed.
  - The answers and the files can drift apart after a hand edit. That is accepted: the files win.
  - The workspace holds the hub's seeds, so a stolen laptop means a stolen hub identity
    ([security.md](../security.md#setup-and-the-admin-workspace)).
- **Existing deploys are not migrated.** The repo's `deploy/docker-compose.yml` still builds from
  source, for contributors and for deploys set up by hand, such as Opzami's.

### Where the build departs from the design

The plan's controller recorded each departure as a ruling (R1–R17) while building. The ones that
change behaviour:

- **The setup command is a skill**, `skills/setup/SKILL.md`, not a file in `commands/`.
- **No compose override file.** Setup renders its own compose file that pulls images; the repo's
  compose file keeps building. Tests never build images: the end-to-end test starts the hub in
  process from a rendered trial workspace.
- **Trial keys (R2).** `setup render` makes the `hub` and `discord-bridge` seeds in both modes, and
  the three callout keys only for a server.
- **`--force` keeps what the old `mesh.yaml` learned (R1):** the public keys of holders that still
  exist and the admin's Discord id.
- **Branch names in the policy (R8)** come from the answers' `git` settings.
- **SSH targets cannot be options (R7).** `hosting.ssh` must be `user@host` with no leading `-`,
  and `publicHost` a DNS name whose labels start and end with a letter or digit. Every `ssh` and
  `scp` call also puts `--` before the destination. A value starting with `-` would otherwise be
  read as an ssh option such as `ProxyCommand`, which runs a local command.
- **The bridge mounts only its own seed (R9).** The rendered compose file gives the bridge
  `discord-bridge.nk` alone; the hub keeps the whole `secrets/` folder. The repo's own
  `deploy/docker-compose.yml` is unchanged and still mounts every seed into the bridge, which is a
  follow-up for the next redeploy of a hand-built hub.
- **A workspace `CLAUDE.md` (R10, R16).** The workspace's `.claude/settings.json` deny rules cover
  only the Read tool (and Grep and Glob), not Bash. So `setup render` also writes a `CLAUDE.md`
  telling every later Claude session in the workspace never to read `.env` or the seeds, never to
  run `docker compose config`, and never to ask for a secret in the chat. The workspace's
  `.gitignore` also ignores `deploy/.env.*`, where a crash can leave the temp file of an atomic
  write.
- **`.env` is written atomically (R11):** a temp file with mode 600 in the same folder, then a
  rename, so a crash never loses the only copy of the token.
- **`--registry` is validated (R12)** before anything is written, so it cannot add lines to `.env`.
- **The remote `deploy/` folder is closed first (R13).** Before copying, `setup deploy` runs
  `chmod 700` on it, because scp may create `.env` and the seeds readable by everyone; afterwards
  `.env` and the seeds get mode 600 and the seeds uid 1000.
- **Discord 401 and 403 differ (R14).** A 401 is a bad token, to reset. A 403 means the token
  works but the bot has no access there; resetting it would break the running bridge.
- **`setup deploy` checks the seeds before copying (R15).** A missing `discord-bridge.nk` would
  otherwise make Docker create a root-owned folder in its place on the server.
- **One version includes `tests/package.json` (R17).**
- **`doctor`'s TLS probe** connects with `rejectUnauthorized: false` only so it can report Node's
  reason; a certificate that fails verification fails the check, and nothing is sent over that
  connection.
- **SSH trusts on first use.** `ssh` and `scp` run with `BatchMode=yes` and
  `StrictHostKeyChecking=accept-new`.
- **The builder's choices** (design §11): the skill finds the CLI through `${CLAUDE_PLUGIN_ROOT}`;
  step 5 uses a new `connect` tool in the plugin's unenrolled mode, the same in-session switch
  `join` makes, so no restart is needed; and the hello in `#mesh-council` is confirmed by asking
  the admin.

## Alternatives considered

- **`npx agentmesh up`** (the earlier Phase 2 roadmap): a wizard over compose. Replaced by this:
  Claude proposes areas, skills and a policy from a conversation, the CLI stays deterministic, and
  nothing is published to npm.
- **Claude writes the config itself.** Rejected: each company would end up with a different,
  unvalidated install that nobody can debug.
- **Building the images on the server.** Rejected: it needs a clone, and a 1 GB VM cannot build
  the monorepo reliably.
- **A provisioning script per cloud.** Rejected: one generic server spec, plus provider commands
  Claude writes from it. `deploy/azure/provision.sh` stays as the tested Azure reference.
- **The token in the chat.** Rejected: the admin types it into `deploy/.env`, which the CLI reads
  and Claude never does.
