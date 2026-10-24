# `/agentmesh:setup` — design

Date: 2026-10-23 · Status: built; see [ADR 0007](../adr/0007-claude-run-setup.md) for the
implementation rulings. Agreed with Pratik in conversation.
- An independent builder check raised four questions. Their answers are in §5.1 (source of truth),
  §5.4 (versions and images) and §4 step 1 (avatars).
- Choices marked "my call" are mine; he can overturn any of them.
- Runtime team-admin commands (changing roles, skills and area owners) are a separate design that
  comes next (§2).

## 1. Why

AgentMesh goes public soon. Its users are self-hosted startup teams of 5–15 people who already
use Claude Code, plugins and MCP. Today one admin needs about an hour of manual work to stand up
a mesh (`docs/getting-started.md` steps 1–5, `docs/deploy.md`):

- clone the repo, `pnpm install && pnpm build`, `pnpm mesh init`;
- write `mesh.yaml` and `deploy/.env` by hand;
- create the Discord bot, then dig out the application id, server id and Discord user ids
  through Developer Mode;
- run `keys add` six times and `nats-config` with the right flags;
- create a VM, get a certificate, copy four kinds of files to it, and build the images on the VM.

Opzami's own deploy went this way, and the Discord bot token ended up pasted into a chat on
2026-10-17. Another company should be able to get the same result by answering Claude's
questions.

## 2. Goals, non-goals, anti-goals

**Goals**
1. **One command.** `/agentmesh:setup` takes an admin from "plugin installed" to a live mesh:
   their own agent is active and their team's invite commands are ready.
2. **Claude asks only for what it needs**, one topic at a time. It proposes the rest (areas,
   skills, team policy) for the admin to correct.
3. **The admin chooses where the hub runs:**
   - a new cloud server, created with the admin's own cloud CLI;
   - an existing server they can reach over SSH;
   - this machine, as a trial.
4. **Setup ends with proof** that the whole path works (§7).
5. **Setup is safe to re-run.** After a failure the admin fixes the cause, and setup continues
   from the step that failed.

**Non-goals**
- Changing a member's roles, skills or area ownership at runtime. That is the next design.
- Any admin action taken by an agent (§5.7).
- Moving an existing deploy, such as Opzami's, onto the new layout.
- Moving a trial from this machine to a server. The admin runs setup again for the server, and
  trial data is not carried over.
- Installing or logging in to cloud CLIs. That is the admin's job.
- Per-provider provisioning scripts beyond the existing Azure reference.
- Publishing the CLI to npm, listing in the official plugin directory, Slack, a hosted option,
  and Hermes.

**Anti-goals** (these count as failure even if setup technically works)
- A secret (bot token, nkey seed, ingest token, invite code) appears in the chat, a session
  transcript, a log or any tool output.
- Claude writes the first config by hand or improvises deploy steps, so each company ends up with a
  different, unvalidated install that nobody can debug. Later edits are fine, as long as they pass
  `validate` before `deploy` (§6).
- Setup creates paid cloud resources without the admin's explicit yes.
- Setup works only on one cloud, or only from macOS/Linux. Pratik's machine runs Windows.
- An agent gains any path to admin actions.

## 3. The admin and what they start with

The admin is the founder or tech lead. Before running setup they need:
- **Claude Code.** On Team/Enterprise plans an Owner must have enabled Channels.
- **Node.** The plugin already needs it.
- **A Discord server** they can add a bot to.
- **For a new cloud server:** their provider's CLI, installed and logged in. Ideally also a domain
  they control.
- **For an existing server:** SSH access to it.
- **For a trial:** Docker on this machine.

They start Claude Code with the channel flag, then run:
```
claude plugin marketplace add <public AgentMesh repo>
claude plugin install agentmesh@agentmesh
/agentmesh:setup
```

## 4. The flow (what the admin sees)

```
/agentmesh:setup
 1. About you   team name, what you build, people (name, role, Discord and GitHub usernames)
                → Claude proposes areas, skills and a short team policy; you correct them
 2. Where       new cloud server · existing server · this machine (trial)
 3. Discord     Claude walks you through creating the bot; you paste the token into a file
 4. Launch      keys generated, config written and validated, hub started with TLS
 5. You join    your own agent is enrolled on this machine
 6. Proof       the live checklist (§7), ending with a round trip to Discord
 7. Your team   the exact /mesh invite lines to run, plus a "how to join" note to send
```

**1. About you.** Claude asks for:
- **The team name**, which becomes `mesh.name`.
- **What the company builds**, in a few sentences, and optionally its main repos.
- **The people.** For each: name, what they do and Discord username.
- *(My call.)* **The admin's GitHub username** is optional and gives their agent an avatar.
  Teammates are not asked for one, because `/mesh invite` has no avatar field. Avatars for invited
  members belong in the next design, which changes the enrollment surface anyway.
- **Who else is an admin**, who has the final say on crucial decisions, and whether plans need a
  human's approval.

Claude then proposes:
- an id for each person (lowercase first name);
- skills for each person, drawn from their role;
- areas and their owners;
- a short team policy.

Everything else takes the defaults from `config/examples`. Claude shows a one-screen summary, and
nothing is written until the admin confirms it.

**2. Where.**
- **New cloud server.** Claude asks which provider's CLI the admin uses and checks that it is
  installed and logged in. If it isn't, Claude says so, links the CLI's install page and offers
  the other options. Claude proposes the server described in §5.5, says plainly that it costs
  money, and creates nothing until the admin says yes. Each provider command is shown before it
  runs.
- **Existing server.** Claude asks for `user@host` and the server's DNS name.
- **This machine.** Claude checks for Docker and says up front that teammates cannot join a trial
  (§5.6).

**3. Discord.**
1. Claude walks the admin through the developer portal: create a new application, reset the bot
   token under Bot, and turn on the Message Content intent.
2. The admin pastes the token into the empty `DISCORD_BOT_TOKEN=` line of the `.env` file that
   setup created (§5.3). The token never goes into the chat.
3. The CLI checks the token with Discord and prints only the bot's name. It looks up the
   application id itself and prints the link that adds the bot to a server, with scopes `bot` and
   `applications.commands` and permissions `326954470480` (as in `docs/discord.md`).
4. The admin opens the link and adds the bot. The CLI waits until the bot can see the server and
   records its id. If the bot is in more than one server, it asks which one.
5. *(My call.)* The admin's own Discord user id defaults to the server owner's id, confirmed by
   username. If the admin is not the owner, they copy their id with Developer Mode.

**4. Launch.** The CLI does everything in §5.1–§5.5. `agentmesh validate` must pass before
anything leaves this machine.

**5. You join.**
- Setup writes the same files `/agentmesh:join` writes (`~/.agentmesh/agent.json` and the key),
  so the plugin connects as `<admin>-agent`.
- If the plugin needs a restart to pick them up, Claude says so and setup continues at step 6
  when run again.

**6. Proof.** See §7.

**7. Your team.** Claude cannot send invites (§5.7). Instead it prints:
- **One `/mesh invite` line per person** from step 1, with their roles and skills, for the admin
  to run in Discord.
- **A short note for the admin to send teammates.** It tells them to join the Discord server and
  allow DMs from its members. Then they install the plugin and add the allow rule. When the code
  arrives by DM, they save it to `~/.agentmesh/invite.txt`, start Claude with the channel flag,
  and run `/agentmesh:join` and then `/agentmesh:activate`.
- **The order to follow:** teammates install the plugin before the invite is sent, because
  codes expire after 24 hours.

## 5. How it works underneath

### 5.1 Claude conducts, a CLI does the work (my call)

- **Claude's role.** `/agentmesh:setup` is a plugin command (`plugins/agentmesh/commands/`, like
  `join.md`). Claude asks the questions, explains each step and what went wrong, and runs the CLI.
- **The CLI's role.** Every change is made by `agentmesh` CLI steps that are deterministic and
  safe to re-run:
  - **render:** answers → config;
  - **discord:** check the token, then wait for the bot to join a server;
  - **keys:** generate the seeds;
  - **host:** prepare the server;
  - **deploy:** copy the files and start the stack;
  - **doctor:** run the checks.
- **Answers are structured data.** Claude records them in a file checked by a zod schema
  (`packages/config` or the CLI). The CLI renders `mesh.yaml`, the policy, `.env`, `nats.conf`
  and the compose file from it. Claude never writes YAML by hand.
- **Progress is saved.** Setup records completed steps in a state file in the workspace (§5.2),
  which holds no secrets. A re-run skips finished steps, and a re-run step leaves existing keys
  alone.
- *(My call.)* **Source of truth.**
  - The answers file feeds only two things: the first render, and step 7's invite lines.
    Teammates appear only in those lines, never in `mesh.yaml`.
  - After the first render, the files in the workspace are the truth. `keys add` already writes
    public keys into `mesh.yaml`, and §6 edits those files directly.
  - Render never overwrites a rendered file on a re-run. It reports any difference and replaces
    the file only with `--force`.
  - "A second run changes nothing" (§9) means that re-running a completed setup leaves every file
    and key as it was.
- **The CLI ships inside the plugin**, so the admin installs nothing else. Its version is the
  plugin's version. The existing `apps/cli` commands (`init`, `keys`, `nats-config`, `validate`)
  are reused, not rewritten.

### 5.2 The workspace folder (my call)

- **What it holds.** One folder on the admin's machine (default `~/agentmesh/<team>`; the admin
  may choose another) holds `config/`, `deploy/` (compose file, `.env`, `nats.conf`, `secrets/`)
  and the setup state.
- **It is the source of truth.** Later changes are made here and pushed with `deploy`.
- **Version control.** It gets a `.gitignore` that excludes `.env`, `deploy/.env.*` (the temp
  file of an atomic `.env` write), `secrets/` and `nats.conf`, so the admin can keep the config in
  a private repo.
- **Defence in depth.** It also gets a `.claude/settings.json` that denies reading `.env` and
  `secrets/**`, so Claude does not open them by accident.

### 5.3 Secrets

- **Generated secrets** (the hub, bridge and callout seeds, any ingest tokens) are created by the
  CLI directly into files with mode 600 and are never printed.
- **The one secret a human supplies, the Discord token,** is typed by the admin into `.env`. The
  CLI reads it there and Claude never does.
- **No CLI step prints a secret value**, in normal output or in errors. A test enforces this
  (§9).
- **Files reach the server only over SSH.** Seeds there are owned by uid 1000, as today.
- **Invite codes still travel only by Discord DM.** Nothing about them changes.
- **The workspace holds the hub's seeds**, so a stolen laptop means a stolen hub identity. The
  threat note says this and recommends disk encryption.

### 5.4 Published images (my call)

- **CI publishes the images.** On each release tag, CI builds the hub and Discord bridge images
  for amd64 and arm64 and pushes them to GHCR as public packages.
- **The compose file pulls instead of building.** It uses `image:` with `AGENTMESH_VERSION` from
  `.env`, so a server needs only Docker: no clone, no build. A 1 GB VM cannot build the monorepo
  reliably anyway.
- **Contributors still build from source** through a compose override file.
- **The registry and namespace are configuration.** CI publishes under the repo owner
  (`ghcr.io/<owner>/…`). The plugin's default comes from one constant, which changes if the repo
  moves.
- **Images become public when the repo does.** Until then, tests build the images locally through
  the override, so there is no registry-login path to design.
- **One version for everything** *(my call)*. The plugin, CLI, hub and bridge share one version,
  starting at the next release, presumably 0.4.0. Today the plugin is 0.3.1 and the rest are
  0.1.0.
- **A version bump merged to `main` is a release.** CI tags it `vX.Y.Z` and publishes its images,
  so `main` never offers a plugin whose images don't exist. This keeps the CLAUDE.md rule that
  every bundled change bumps the plugin version.
- **The workspace pins the hub version.**
  - Setup writes the running plugin's version into the workspace's `.env`
    (`AGENTMESH_VERSION`).
  - `deploy` always uses that pin, so updating the plugin never upgrades the hub silently.
  - Moving the pin is an explicit `upgrade` step.
- **Hub-only releases don't force teammates to update.** The hub's minimum plugin version moves
  only when the protocol needs it, as it did for 0.3.0.

### 5.5 The server

**What it needs:**
- Ubuntu 24.04 LTS (the tested target), 1–2 GB RAM and about 20 GB of disk;
- a static public IP and a DNS name that points at it;
- SSH key login;
- inbound traffic: port 22 from the admin's IP only, and ports 4222 (NATS over TLS) and 80
  (Let's Encrypt) from anywhere.

**The DNS name.** Two options:
- **The admin's own subdomain.** Claude gives the A record to add and waits until it resolves.
- **The provider's free name, where one exists**, such as Azure's
  `<label>.<region>.cloudapp.azure.com`.

Some providers' default hostnames cannot get a Let's Encrypt certificate. AWS's `amazonaws.com`
names are refused (the builder should verify this), so on AWS the admin needs their own domain.

**Creating it.**
- For a new cloud server, Claude builds exactly this with the admin's CLI.
- `deploy/azure/provision.sh` stays as the tested Azure reference.
- For other providers, Claude writes the equivalent commands from this list. We do not maintain a
  script per provider.

**Preparing it.**
- A provider-neutral host script, generalised from `deploy/azure/vm-setup.sh`, installs Docker
  and certbot, gets the certificate and installs the renewal hook.
- It is safe to re-run.
- `deploy` then copies the workspace's `deploy/` and `config/` and runs
  `docker compose pull && docker compose --profile discord up -d`.

**The mode.** The deploy runs in auth-callout mode (`nats-config --tls --auth-callout`), so
members join by invite.

**Ingest.** *(My call.)* A new mesh starts with no ingest sources configured. The config keeps
them as commented examples, and the hub's HTTP port stays bound to localhost.

### 5.6 Trial on this machine (my call)

- **How it runs.** The hub runs in Docker on the admin's machine. NATS is bound to 127.0.0.1
  without TLS, in static mode (no auth callout).
- **Who can connect.** The admin's agent, plus an optional second test agent, are listed in
  `mesh.yaml`, the same way `pratik-test-agent` was. The Discord bridge works, since it only
  connects outward.
- **What it can't do.** Teammates cannot join, because invites need a public TLS address. Setup
  says this before the admin picks the trial.
- **Going real** means running setup again and choosing a server.

### 5.7 Admins, and the rule that agents never act as admins (decided)

- **The first admin** is written into `mesh.yaml` by setup: a human with `roles: [admin]` and a
  `discordUserId`, plus an agent with its public key. `mesh.yaml` wins over the registry, so a
  registry change cannot lock the first admin out.
- **Other admins** come from step 1. Their invite lines carry `roles:admin`.
- **Agents can never call admin RPCs, not even the admin's own Claude.** Admin methods accept
  only human callers with the `admin` role, and humans reach the hub only through the Discord
  bridge (`packages/protocol/src/rpc/enrollment.ts`, `apps/hub/src/rpc/router.ts:166`). Setup
  keeps it that way: Claude prints the invite lines and the admin runs them.
- **Operator commands** (`deploy`, config edits, SSH) run from the workspace with the admin's own
  SSH key. They are not mesh RPCs.
  - An active mesh session can receive a message that asks it to redeploy or edit config.
  - Setup therefore never adds allow rules for the CLI or for `ssh`, so each such command needs
    the admin's approval in the terminal.
  - The threat note covers this.

## 6. After setup

- **Members:** `/mesh invite`, `/mesh uninvite` and `/mesh remove` in Discord, unchanged.
- **Areas, policy and workflows:** the admin asks Claude in the workspace. Claude edits the files,
  runs `validate`, then runs `deploy`, which restarts the hub.
- **Health:** `agentmesh doctor` re-runs the checks from §7 at any time.
- **Runtime role, skill and area-owner changes** from Discord belong to the next design.

## 7. Proof: setup is done only when every check passes

```
AgentMesh is live for Acme
 ✓ mesh.acme.dev resolves to the server; :4222 answers TLS (cert valid to 21 Jan)
 ✓ nats, hub (healthy) and discord-bridge are running
 ✓ Discord bot online in "Acme": category, 7 channels and the planning forum exist
 ✓ riya-agent connects and appears in peers
 ✓ Round trip: hub → this session (/agentmesh:activate test message)
 ✓ Hello from riya-agent is visible in #mesh-council
 Next: run these 3 invite lines in Discord (below)
```

- A failing line says what is wrong and what to do next. Running setup again continues from that
  point.
- The trial skips the DNS and TLS line.
- `doctor` runs the infrastructure lines. The round trip and the hello need a session, so setup
  runs those itself.

## 8. Constraints (project rules that apply)

- **Files:** no source file over 300 lines. Pure logic (answer validation, rendering, checks)
  stays free of I/O and is unit-tested.
- **Config:** every team-specific value goes in config with a sensible default: registry, image
  version, workspace path, server spec defaults.
- **Types:** zod schemas at every boundary, including the answers file.
- **Platforms:** setup works from Windows, macOS and Linux. It relies on the system `ssh`/`scp`
  rather than a bash-only shell.
- **Plugin:** rebuild and commit `plugins/agentmesh/dist/`, and bump the version in
  `plugin.json`, `package.json` and `src/server.ts`.
- **Security:** a threat note in `docs/security.md` (this change touches secrets, SSH and the
  network surface).
- **Finish:** `pnpm check` passes before the work is called done.

## 9. Testing and acceptance

**Unit tests**
- The answers schema.
- Rendered config: answers → `mesh.yaml`, and the result passes `validate`.
- The `.env`, compose file and `nats.conf` renders.
- Idempotence: a second run changes nothing and keeps the keys.
- The Discord helper against a fake HTTP server.
- `doctor` checks with fakes.

**Secret-leak test.** Run every step with known secret values and assert that none appears in
stdout or stderr.

**Integration.** At minimum, the hub starts from a rendered workspace against a real nats-server
(the existing harness). Whether CI also runs the trial path under Docker is up to the builder.

**Manual acceptance before launch (Pratik).**
- On a fresh server, go from plugin install through `/agentmesh:setup` to an all-green proof in
  under 30 minutes, with no YAML edited by hand.
- Search the session transcript for the bot token and the seeds; none may be there.
- Also do one trial-mode run on Windows.

## 10. Docs and records

- **ADR 0007:** a Claude-run setup over a deterministic CLI, published images, and the workspace
  as the source of truth.
- **`getting-started.md`:** rewritten around `/agentmesh:setup`; the manual path moves to a
  "by hand" section.
- **`deploy.md`:** the generic server spec, published images, and upgrades by image version.
- **`security.md`:** the threat note (§5.3, §5.7).
- **`discord.md`:** bot creation the way setup does it.
- **`configuration.md`:** any new option.
- **READMEs:** installing and running setup in three lines in the README and the plugin README.
- **`CLAUDE.md`:** status and roadmap.

## 11. Who decided what

**Decided by Pratik**
- A single `/agentmesh:setup` command in which Claude asks for what it needs (Discord bot, company
  overview, team members and their roles).
- The admin chooses where the hub runs, locally or in the cloud. Installing the cloud CLI is the
  admin's responsibility.
- Agents can never call admin actions, not even the admin's own Claude.
- Members keep joining by `/mesh invite` in Discord, with roles and skills.
- Setup is built before launch. The repo goes public, and the Opzami team is invited after.

**My calls** (marked in the text)
- Claude conducts and a CLI does the work, from a structured answers file.
- The CLI ships inside the plugin.
- The Discord token goes into a file, never the chat.
- Images are published to GHCR, and the compose file pulls them.
- One version across the plugin, CLI, hub and bridge. A version bump on `main` is a release.
  The workspace pins the hub version, and only `upgrade` moves the pin.
- The answers file drives only the first render and the invite lines; after that the workspace
  files are the truth.
- Only the admin is asked for a GitHub avatar; invitees get avatars in the next design.
- One generic server spec plus Claude-written provider commands, with no per-provider scripts.
- The trial is static, local-only, and teammates can't join it.
- The admin's Discord id defaults to the server owner's id.
- No ingest sources by default.
- The workspace folder layout and its deny rules.

**Left to the builder**
- The names of the CLI steps and files.
- How the command finds the bundled CLI, for example `${CLAUDE_PLUGIN_ROOT}` or the unenrolled
  MCP server reporting its path.
- Whether the setup engine is a subcommand of the existing bundle or a second bundle.
- Whether step 5 can reuse `join`'s in-session switch to avoid a restart.
- How the hello in Discord is confirmed: through the Discord API, or by asking the admin.
- The interview mechanics, such as when to use multiple-choice questions.
- The exact provider check commands.
