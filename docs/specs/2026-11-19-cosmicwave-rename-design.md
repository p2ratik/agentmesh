# Renaming AgentMesh to Cosmicwave: design

**Status:** draft for Pratik's approval · 2026-11-19. Nothing is renamed yet.

## Intent

AgentMesh becomes **Cosmicwave** everywhere: the open-source project, the plugin, and the hosted
service that will be built on it. `agentmesh` is not available as a domain, and one name avoids
confusion later. The project has few users, so the rename is cheapest now, before any SaaS work is
built under the old name.

## Goals

- One release (0.8.0) after which a new user sees only Cosmicwave, with the same steps as today
  and `cmw` in place of `agentmesh` (`/cmw:join`, `/cmw:activate`, `/cmw:window`).
- An existing teammate switches by uninstalling the old plugin and installing the new one. Their
  key, agent id and roles carry over. **Nobody is re-invited.**
- An existing server keeps its data through the upgrade.

## Non-goals

- Any change to how the system works. See "What does not change".
- The SaaS repository (`Agentmesh-SAAS`), the domain, and the local folder
  `G:\Projects\AgentMesh` (Claude Code keys its memory and sessions by that path).
- Renaming files the host scripts already installed on an existing server (the firewall chain
  `AGENTMESH-NATS`, `agentmesh-firewall.service`, the certbot hook, `/opt/agentmesh`). They are
  names on one private machine and keep working.
- Reading the old `AGENTMESH_*` environment variables as a fallback.
- A `cmw migrate` command that edits the user's Claude Code permission rules for them.

## Anti-goals (a failure even if everything is renamed)

- A laptop where the private key exists in no folder the new plugin reads, so the member must be
  re-invited.
- A hub that starts on empty Docker volumes, with its real data left behind in the old ones.
- A wire or database change that stops an old plugin and a new hub (or the reverse) from talking.

## What does not change

Confirmed by reading the code: none of these contain the product name.

- NATS subjects, streams and consumers (`{p}.…`, `{P}_EVENTS`, `feed-*`, `hub-ingest`), the inbox
  prefix, every RPC method and its zod contract, and the invite code format.
- `hub.sqlite`, its schema and migrations, the hub's registry of members, roles and public keys.
- nkeys, the auth callout, NATS permissions, `mesh.yaml` and its schema.
- `claude-mesh`, the MCP server key `mesh`, the 26 tool names, the Discord slash commands and the
  `#mesh-*` channels, and "mesh" as the everyday word (mesh window, mesh.yaml).
- **One wire value keeps the old name on purpose:** the telemetry reason code
  `path.agentmesh_dir` (`packages/protocol/src/observe-codes.ts`). It is in a zod enum the hub
  validates, so renaming it would be a protocol change.

Because of this, an old 0.7.2 plugin works against a 0.8.0 hub and a 0.8.0 plugin against a 0.7.2
hub. This comes from reading the code and must be proved on staging before the release.

## The names

Decided by Pratik: the name Cosmicwave, the plugin `cmw`, the folder `~/.cosmicwave`, and that
`claude-mesh` stays. The rest are Claude's calls, to be approved with this document.

| Thing | Today | After |
| --- | --- | --- |
| Display name | AgentMesh | Cosmicwave |
| Plugin and its commands | `agentmesh`, `/agentmesh:activate` | `cmw`, `/cmw:activate` |
| Plugin folder in the repo | `plugins/agentmesh` | `plugins/cmw` |
| Marketplace name | `agentmesh` | `cosmicwave` |
| GitHub repository | `p2ratik/agentmesh` | `p2ratik/cosmicwave` |
| Install | `agentmesh@agentmesh` | `cmw@cosmicwave` |
| Tool prefix (allow rule) | `mcp__plugin_agentmesh_mesh__*` | `mcp__plugin_cmw_mesh__*` |
| Channel flag | `plugin:agentmesh@agentmesh` | `plugin:cmw@cosmicwave` |
| Laptop folder | `~/.agentmesh` | `~/.cosmicwave` |
| CLI | `agentmesh` | `cmw` |
| Server binaries | `agentmesh-hub`, `agentmesh-discord` | `cosmicwave-hub`, `cosmicwave-discord` |
| Images | `ghcr.io/p2ratik/agentmesh-hub`, `…-discord-bridge` | `ghcr.io/p2ratik/cosmicwave-hub`, `…-discord-bridge` |
| Workspace packages | `@agentmesh/*` | `@cosmicwave/*` |
| Environment variables | `AGENTMESH_*` | `COSMICWAVE_*` |
| Server scripts | `agentmesh-deploy`, `agentmesh-backup` | `cosmicwave-deploy`, `cosmicwave-backup` |
| Default server folder | `/opt/agentmesh` | `/opt/cosmicwave` |
| Compose project | `agentmesh` | `cosmicwave` |
| Setup state file | `.agentmesh-setup.json` | `.cosmicwave-setup.json` |
| Version | 0.7.2 | 0.8.0 |

The manifest `name` and the marketplace entry `name` are both `cmw`: Claude Code's docs say they
must match.

## Approaches

**Carrying a laptop's identity to the new folder.** A teammate's identity is two files in
`~/.agentmesh`: `agent.json` and `<agent>.nk`. `agent.json` stores the seed as an absolute path
into that folder. The folder also holds things the plugin did not write, such as the key that
decrypts the off-site backups (`backup-age-key.txt`).

1. *Keep `~/.agentmesh`.* No risk, but the old name stays on every laptop. Pratik wants the new
   folder.
2. *Copy `agent.json` and the seed into `~/.cosmicwave`.* Leaves the backup key and everything
   else behind, and puts each private key in two places. Cleaning up means deleting a folder that
   may hold the only copy of something.
3. **Rename the folder (picked).** One `rename` call moves `~/.agentmesh` to `~/.cosmicwave`. On
   one volume it either happens completely or not at all, and nothing is ever deleted, so no key
   can be lost. Everything in the folder comes along.

**Doing the rename.**

1. **One release, one pull request (picked).** A scripted replace in a fixed order, `git mv` for
   the paths, then hand edits for the places below. The project has few users and two names in
   flight is the confusion this rename exists to avoid.
2. *Staged over several releases with aliases.* More code, more time with two names.
3. *A second plugin beside the old one.* Two plugins that must never be installed together.

## Design

### 1. The laptop folder

- **One function decides the folder,** in `packages/common/src/agent-files.ts` (built-ins only):
  - `~/.cosmicwave` when it exists;
  - else `~/.agentmesh` when that exists (a laptop not moved yet);
  - else `~/.cosmicwave`.
  Every reader goes through it. Today the path is spelled out in about ten files (`agent-id.ts`,
  `config.ts`, `hook.ts`, `pull/state.ts`, `guard/paths.ts`, `window.ts`, `agent-setup.ts`); they
  all change to call it.
- **The move** happens at two entry points only: when the plugin's MCP server starts and when the
  CLI starts. If `~/.cosmicwave` is missing and `~/.agentmesh` exists, rename it. (Changed in the
  final review: on the CLI side only `cmw window init` moves it, since any other command run from
  a newer checkout would take the folder from under a 0.7.2 plugin; see ADR 0014.)
  - If the rename fails (Windows refuses while a file in the folder is open), nothing changed:
    the session uses `~/.agentmesh` and the next start tries again.
  - If two processes race, one wins and the other finds the new folder.
  - The hook and the guard never move anything. They only read.
- **The seed path.** After the move, `agent.json` is rewritten so a seed path under
  `~/.agentmesh` points under `~/.cosmicwave`. The reader also maps such a path when the old one
  does not exist, so a crash between the two steps cannot strand the key.
- **Secrets stay refused in both places.** The deny list (`secret-paths.ts`) and the guard's
  edit refusal cover `~/.cosmicwave` and `~/.agentmesh`, because an unmoved or leftover folder
  still holds keys. This needs the threat note in `docs/security.md`.
- **A second Claude account on the same laptop** (`CLAUDE_CONFIG_DIR`) shares the folder. Once one
  account moves it, the old plugin in the other account finds nothing and shows as not joined
  until it is switched too. Both accounts switch together.

### 2. The mesh window on a moved laptop

The launcher, its settings file and `claude-mesh` hold old paths, the old channel flag and the old
activate command, so they are stale after the switch. Running `/cmw:window` once rewrites them.

- `window init` recognises a `claude-mesh` file with the old marker line (`agentmesh claude-mesh`)
  as its own and overwrites it. New files carry `cosmicwave claude-mesh`.
- The session-start line tells a laptop with a stale window to run `/cmw:window`, as it already
  does for a window set up before auto mode.
- The window's marker variable becomes `COSMICWAVE_MESH_WINDOW`.

### 3. What Claude Code resets, and what the member does

From Claude Code's docs: the plugin id changes, so the tool names, the saved plugin options, the
plugin's data folder and the marketplace's auto-update setting all start fresh. There is no
automatic migration when a marketplace's name changes.

A teammate's steps:

1. Close every Claude Code session.
2. `claude plugin marketplace remove agentmesh` (this also uninstalls the plugin).
3. `claude plugin marketplace add p2ratik/cosmicwave`, then `claude plugin install cmw@cosmicwave`.
4. In `~/.claude/settings.json`, replace the allow rule with `mcp__plugin_cmw_mesh__*`.
5. Start Claude Code, run `/cmw:window` once, then `claude-mesh` as before.

Before step 2, each member checks that `~/.agentmesh/agent.json` exists and has an `nkeySeed`
line. A seed typed into the plugin's options instead is deleted by the uninstall. Members who
joined with an invite have the file.

Lost on the switch, and acceptable: the plugin's local session records. A reply pointer or a
`claude --resume` for a conversation started under the old plugin will not find its session. The
hub's inbox still holds every message.

### 4. The repository and the plugin

- `git mv plugins/agentmesh plugins/cmw`; rename the deploy and backup scripts and their tests.
- Scripted replace, longest names first, then rebuild `plugins/cmw/dist` and the lockfile.
- Messages people and agents read change with it: the hub's "update your plugin" text names
  `cmw@cosmicwave`, the pointer text starts `Cosmicwave:`, the invite DM names `~/.cosmicwave`.
- NATS connection names (`agentmesh-plugin:<id>`, `agentmesh-hub`) are labels only and become
  `cosmicwave-*`.
- **A check keeps it clean.** `pnpm check` gains a script that fails when `agentmesh` appears in
  a tracked file outside a short allowlist: the folder fallback, the secret deny list, the shim
  marker, the webhook lookup, the reason code, the upgrade notes, ADR 0014 and this document.
- Earlier ADRs and specs are renamed too. ADR 0014 records the rename and says that documents
  dated before 2026-11-19 were written under the name AgentMesh.

### 5. The Discord bridge

- The bridge finds its webhooks by name. It will accept a webhook named `Cosmicwave` or
  `AgentMesh` and create new ones as `Cosmicwave`, so no channel gets a duplicate.
- Channel names come from each team's config and do not change.
- **The category.** Its default name is a config default, `Agent Mesh`, and the bridge finds the
  category by name. The default becomes `Cosmicwave`. A team that never set the name would get a
  second category, so when the configured name is the new default and no such category exists,
  the bridge uses an existing `Agent Mesh` category as it is. (Opzami's config sets the name, so
  it is unaffected.)
- **The hub's "plugin too old" message** no longer says `claude plugin update`: every plugin
  older than 0.8.0 has the old name, so the message says to install `cmw@cosmicwave` instead.
- The bot's display name is changed by hand in Discord's developer portal.

### 6. Servers

- **Volumes.** The compose file's `name:` becomes `cosmicwave`. An existing server adds
  `COMPOSE_PROJECT_NAME=agentmesh` to `deploy/.env` first, and its volumes
  (`agentmesh_hub-data`, `agentmesh_nats-data`) stay in use. Checked on a scratch compose file
  with Docker Compose 5.0.2: the `.env` value overrides the file's `name:`.
- **A guard against the mistake.** `cosmicwave-deploy` and `cmw setup deploy` refuse to start the
  stack when a volume named `agentmesh_hub-data` exists and the project name is not `agentmesh`,
  and say which line to add.
- **`.env` keys.** `AGENTMESH_CONFIG_DIR`, `_LOG_LEVEL`, `_IMAGE_REGISTRY` and `_VERSION` become
  `COSMICWAVE_*`. Variables set inside the compose file change with the image, in the same
  release.
  An existing server **adds** the new keys and keeps the old ones until 0.8.0 is confirmed, so a
  rollback to the 0.7.2 compose file still finds its settings.
- **A setup workspace made before the rename.** `cmw upgrade` and `cmw setup deploy` detect it
  (`.agentmesh-setup.json`, or `AGENTMESH_VERSION` in `.env`), then:
  - rename the state file and add the new `.env` keys;
  - set `COMPOSE_PROJECT_NAME=agentmesh`;
  - write `remoteDir: /opt/agentmesh` into `setup-answers.json` when it is absent, because the
    default changes to `/opt/cosmicwave` and the server's files are in the old folder;
  - render the compose file again.
- **`cmw setup host` on a server prepared before the rename** removes the old-named firewall
  unit, its `AGENTMESH-NATS` chain and the old certbot hook before it installs the new ones, so
  the server never has two of each. (A server nobody re-prepares keeps the old ones; see
  Non-goals.)
- **Images.** The release workflow publishes only the new names. GHCR creates new packages
  private, so they must be made public once by hand or servers cannot pull them.
- **Automatic deploys (ADR 0010) are live on Opzami's server** (the AWS variables were set on
  2026-11-13). The installers learn about an old install:
  - `deploy/auto-deploy/install.sh` moves `/etc/default/agentmesh-deploy` to the new name and
    keeps its values, so the checkout folder stays `/opt/agentmesh`. It moves the state folder
    and removes the old script.
  - It replaces the `authorized_keys` line that carries **either** marker. Leaving the old line
    would keep a second valid deploy key on the server, so this goes in the threat note.
  - `deploy/backup/install.sh` does the same for an old backup install.
  - Until the installer is re-run, the old script asks for `agentmesh-hub:0.8.0`, which does not
    exist, and fails before changing anything.
- **The cloud trust names the repository.** GitHub's token subject for this repository is
  `repo:p2ratik@…/agentmesh@…`, so after the GitHub rename AWS refuses the deploy job's sign-in
  until `deploy/aws/github-deploy-setup.sh` is run again. It updates the existing role's trust
  when given the existing `IAM_NAME` and `SG_NAME`; the defaults change to
  `cosmicwave-github-deploy` for new setups. A refused sign-in changes nothing on the server.
- **Rollback of the first renamed release** works as today: the deploy script restores the saved
  override file, which names the 0.7.2 images, and the previous checkout.
- `docs/deploy.md` gets a section, "Moving a server from AgentMesh", with these steps in order.

### 7. Opzami's own rollout, in order

Every step on the server is Pratik's: nothing else may write there.

1. Tell the team. Each member checks their `agent.json` and turns plugin auto-update off
   (`agentmesh autoupdate --off`), so their 0.7.2 install stays as it is until they switch.
2. Pratik adds `COMPOSE_PROJECT_NAME=agentmesh` and the new `COSMICWAVE_*` keys to the server's
   `deploy/.env`. Neither has an effect on the running 0.7.2 stack.
3. **Gate, before anything merges.** Prove on staging and on a scratch copy of the marketplace:
   - a 0.7.2 plugin against the 0.8.0 hub, and a 0.8.0 plugin against a 0.7.2 hub;
   - the folder move on Windows;
   - what an old install does when its marketplace turns into the renamed one, with auto-update
     on and off. If an old install stops working or its guard starts blocking, stop and decide
     with Pratik before merging.
4. Pratik renames the GitHub repository. GitHub redirects the old address for git and the web.
   He runs `deploy/aws/github-deploy-setup.sh` again so AWS trusts the renamed repository.
5. Merge to `agents`, then `main`. The release workflow publishes the 0.8.0 images; its deploy
   job fails safely, because the server still has the old script. Pratik makes the two new
   packages public.
6. Pratik runs the new `deploy/auto-deploy/install.sh` on the server, then re-runs the deploy
   job. The script backs up, starts 0.8.0 on the same volumes, and rolls back by itself if the
   hub is not ready.
7. Each teammate switches, at their own pace.
8. Off-site backups are installed on the server after this, under the new names.

## Tests

- The folder function: the three cases, the move, a failed rename, two racing callers, and the
  seed path mapping.
- The guard refuses both folders; the deny list has both.
- `window init` overwrites a shim with the old marker and refuses a foreign one.
- The bridge reuses a webhook with either name.
- The deploy guard refuses a wrong project name over existing volumes.
- A pre-rename workspace is converted by `upgrade`, including the pinned server folder.
- Both installers on a server with an old install: the settings carry over and exactly one
  deploy-key line remains.
- The name check, with a file that breaks it.
- Everything that passes today: about 1,660 unit tests and the integration suite.

Not provable in CI, so done by hand before the release: the cross-version pairs on staging, and a
real uninstall and reinstall on Pratik's laptop.

## Left to the builder

- The exact order and form of the replace script (it is thrown away afterwards).
- Where the stale-window check lives and its wording.
- How the deploy guard reads the project name.
- File splits needed to stay under 300 lines.

## Open

- **What an old install does when its marketplace is renamed under it** is not documented by
  Claude Code. Its docs cover a plugin removed from a marketplace (it stays installed and reports
  "not found"), not a marketplace whose own name changes. The plugin's guard blocks edits and
  shell calls when it cannot run, so a half-updated install would be serious. Rollout step 3
  tests this before anything merges, and step 1 keeps the team's installs from updating.
- **Whether another company trades as Cosmicwave,** and the domain, are outside this document.
