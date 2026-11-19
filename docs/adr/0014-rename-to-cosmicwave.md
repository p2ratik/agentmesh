# ADR 0014 — Renaming AgentMesh to Cosmicwave

**Status:** accepted · 2026-11-19.

## Context

The project, its plugin and the hosted service planned on top of it were called AgentMesh. The
`agentmesh` domain is not available, and one name for the open-source project and the hosted
service avoids confusion later. The project has few users, so the rename costs least now, before
any hosted work is built under the old name.

The old name was more than a label. It held state in three places:
- **Each laptop:** `~/.agentmesh` holds the member's private key, `agent.json` (which points at the
  key by absolute path) and whatever else they keep there, such as the off-site backup key.
- **Each server:** Docker names volumes after the compose project, so the hub's data is in
  `agentmesh_hub-data` and `agentmesh_nats-data`. The server scripts' settings, units, state and
  deploy key carry the old name too.
- **Claude Code:** tool names, saved plugin options, the plugin's data folder and the
  marketplace's auto-update setting are keyed by the plugin id, and Claude Code does not migrate
  them when a marketplace's name changes.

## Decision

- **Names only, in one release (0.8.0).** The plugin is `cmw` (`cmw@cosmicwave`, from the
  marketplace `cosmicwave` in the repository `p2ratik/cosmicwave`), the CLI `cmw`, the packages
  `@cosmicwave/*`, the environment variables `COSMICWAVE_*`, the images `cosmicwave-hub` and
  `cosmicwave-discord-bridge`, the server scripts `cosmicwave-deploy` and `cosmicwave-backup`, the
  default server folder `/opt/cosmicwave`, the compose project `cosmicwave` and the laptop folder
  `~/.cosmicwave`. No NATS subject, stream, RPC method, schema, migration, tool name or invite
  format changes. `claude-mesh`, the MCP server key `mesh`, `hub.sqlite` and "mesh" as the
  everyday word stay. So a 0.7.2 plugin works with a 0.8.0 hub, and the reverse. The old
  `AGENTMESH_*` variables are not read as a fallback.
- **The laptop folder is renamed, not copied.** The plugin's MCP server and the `cmw` CLI rename
  `~/.agentmesh` to `~/.cosmicwave` when they start (`packages/common/src/mesh-home.ts`), in one
  call, only when `~/.cosmicwave` does not exist. Nothing is copied or deleted, so no key can be
  lost, and everything in the folder comes along. Then the seed path in `agent.json` is pointed
  into the new folder; readers map an old seed path too, so a crash between the two steps strands
  nothing. Until the rename succeeds the old folder is used in place. When both folders exist,
  nothing moves and the member decides. The hook and the guard never move anything.
- **One wire value keeps the old name:** the reason code `path.agentmesh_dir`. It is in a zod enum
  the hub validates, so renaming it would be a protocol change; keeping it also keeps stored events
  and older viewers matching.
- **A server keeps its compose project.** The compose file says `name: cosmicwave`. A server set up
  before the rename adds `COMPOSE_PROJECT_NAME=agentmesh` to `deploy/.env`, which wins over the
  file's `name:`, and keeps its volumes. `cosmicwave-deploy` and `cmw setup deploy` refuse to start
  the stack when `agentmesh_hub-data` exists and the project would not be `agentmesh`, so a missed
  step cannot start the hub on empty volumes.
- **Old installs are taken over, not left beside the new ones.** Every `cmw setup …` command,
  `cmw upgrade` and `cmw doctor` convert a setup workspace made before the rename. The server
  installers carry the old settings, keys and state across, remove the old units and scripts, and
  leave exactly one deploy-key line. `cmw setup host` replaces the old firewall unit (after the new
  one has started) and the old certbot hook. `cmw window init` replaces a `claude-mesh` the old
  plugin wrote. The Discord bridge reuses webhooks named `AgentMesh` and, while the configured
  category is the default, an existing `Agent Mesh` category.
- **A check keeps the old name out.** `pnpm check:name` (`scripts/check-legacy-name.mjs`, part of
  `pnpm check`) fails when `agentmesh` appears in a tracked file outside a short list of files that
  need it, each for a stated reason.
- **Earlier documents were renamed with the code.** Documents dated before 2026-11-19 were written
  under the name AgentMesh.

## Alternatives considered

- **Keep `~/.agentmesh`.** No risk, but the old name stays on every laptop.
- **Copy `agent.json` and the seed into `~/.cosmicwave`.** Leaves the backup key and anything else
  behind, and puts each private key in two places. Cleaning up means deleting a folder that may
  hold the only copy of something.
- **Several releases with aliases** (both variable names, both plugin names). More code, and a
  longer time with two names, which is the confusion the rename exists to remove.
- **A second plugin beside the old one.** Two plugins that must never be installed together.
- **Moving a server's data into `cosmicwave_*` volumes.** Docker cannot rename a volume, so it is a
  copy of the hub's database during an upgrade: a step that can lose data, for a name nobody sees.
- **Renaming the reason code.** A protocol change, for one string in a stored event.

## Consequences

- Every member reinstalls the plugin once and runs `/cmw:window` again. The key, the agent id, the
  roles and every message on the hub carry over, so nobody is invited again. The plugin's local
  session records are lost, so a reply pointer or a `claude --resume` for a conversation started
  under the old plugin does not find its session.
- Two Claude accounts on one laptop share the folder, so they switch together.
- A server keeps `/opt/agentmesh`, its `agentmesh_*` volumes and the compose project `agentmesh`.
  Its firewall unit and certbot hook keep their old names until `cmw setup host` runs again.
- GHCR creates the renamed image packages private; an admin who publishes images makes them public
  once. Renaming the GitHub repository changes the subject of its OIDC tokens, so the cloud setup
  script for automatic deploys runs again.
- Images under the old names stop at 0.7.2, so a deploy by version (`cmw upgrade --to`,
  `cosmicwave-deploy deploy`) cannot go back past 0.8.0. The deploy script's own rollback, which
  restores the previous checkout and images, still can.
- The old name stays in the files `pnpm check:name` allows, and nowhere else.

The steps are in [getting-started.md](../getting-started.md#moving-from-agentmesh) for members and
[deploy.md](../deploy.md#moving-a-server-from-agentmesh) for admins; the threat notes are in
[security.md](../security.md#the-laptop-folder-after-the-rename).
