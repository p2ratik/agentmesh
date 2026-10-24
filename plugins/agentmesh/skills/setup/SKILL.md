---
name: setup
description: "Set up AgentMesh for your team: the hub, Discord and your own agent."
disable-model-invocation: true
---

# Set up AgentMesh

Take the admin from "plugin installed" to a live mesh: the hub runs, their own agent is active,
and their team's invite lines are ready. You ask the questions and explain each step. The
`agentmesh` CLI bundled with this plugin makes every change; its steps are deterministic and safe
to re-run.

## Rules

- Never ask the user to paste the Discord bot token, an invite code or any key into this chat. If they paste one anyway, do not repeat it; tell them to reset it in the Discord developer portal and to put the new one in the file.
- Never open, read, print or search `deploy/.env` or anything in `deploy/secrets/`.
- Never run `docker compose config`, `docker inspect`, or `env`/`printenv` in a container, here or over ssh: they print `.env` values. Use `doctor` and `docker compose ps`/`logs`.
- Never add permission allow rules for this CLI, ssh or scp.
- Agents cannot run `/mesh` admin commands. You print the invite lines; the admin runs them in Discord.
- Create nothing that costs money until the user says yes to the server size you proposed.
- Run the CLI exactly like this, one step at a time, and show the admin what it printed:
  `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <command> --dir "<workspace>"`.
  - `<workspace>` is the workspace's absolute path with forward slashes, such as
    `/home/riya/agentmesh/acme` or `C:/Users/riya/agentmesh/acme`. `~` does not expand inside the
    quotes.
  - Options go after `--dir "<workspace>"`. `--help` after a command shows what it does.
  - `setup discord`, `setup host` and `setup deploy` can take minutes; give them a timeout of up to
    10 minutes.
- You never write config yourself. The CLI renders it from `setup-answers.json`, the one file you
  write. The admin types the bot token into `deploy/.env` in their own editor.
- **On any failure:** show the CLI's message, fix the cause with the admin, and re-run the same
  step. Never edit the files by hand to get around a failing step.

`setup render` also writes a `CLAUDE.md` into the workspace with these secret rules, so later
Claude sessions there follow them, plus `.claude/settings.json` deny rules and a `.gitignore`. The
Discord bridge's container gets only its own seed. None of this needs anything from you.

## 0. Start

- If the admin names an existing workspace, or `~/agentmesh/` already holds one (a folder with
  `setup-answers.json`), run
  `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" setup status --dir "<workspace>"` and continue from its
  `Next:` line.
- Otherwise ask where to keep the workspace (default `~/agentmesh/<team>`, the team name in
  lowercase; ask the team name first).
- Tell the admin that this session must have been started with
  `claude --dangerously-load-development-channels plugin:agentmesh@agentmesh`, and that if it
  wasn't, they should restart that way first and run `/agentmesh:setup` again.

## 1. About you

Ask one topic at a time:
1. **The team name.** It becomes the mesh name (`meshName`: lowercase letters, digits and dashes,
   starting with a letter).
2. **What the company builds**, in a few sentences, and optionally its main repos.
3. **The people.** For each: name, what they do and Discord username. Start with the admin.
4. **The admin's GitHub username.** It is optional and gives their agent an avatar. Do not ask
   teammates for one.
5. **Who else is an admin**, who has the final say on crucial decisions, and whether plans need a
   human's approval.

Then propose, for the admin to correct:
- an id for each person (lowercase first name);
- skills for each person, drawn from their role;
- areas and their owners;
- a short team policy: who has the final say, whether plans need approval, and the branches
  (agents merge into `agents`; humans promote it to `main`).

Everything else takes the defaults. Write `<workspace>/setup-answers.json` with the Write tool, in
this shape:

```json
{
  "version": 1,
  "team": {
    "name": "Acme",
    "meshName": "acme",
    "overview": "Acme builds invoicing software for small shops.",
    "repos": ["acme/api", "acme/web"]
  },
  "admin": {
    "id": "riya",
    "name": "Riya",
    "roles": ["backend lead"],
    "skills": ["backend", "api"],
    "discordUsername": "riya",
    "githubUsername": "riya-gh"
  },
  "people": [
    {
      "id": "dana",
      "name": "Dana",
      "roles": ["security", "admin"],
      "skills": ["security"],
      "discordUsername": "dana"
    }
  ],
  "decisions": { "finalSay": "riya", "plansNeedApproval": true },
  "areas": [
    {
      "id": "security",
      "description": "Auth, secrets and permissions",
      "owners": ["dana"],
      "skills": ["security"]
    }
  ],
  "git": { "integrationBranch": "agents", "protectedBranches": ["main"] },
  "hosting": { "mode": "server", "ssh": "deploy@mesh.acme.dev", "publicHost": "mesh.acme.dev" }
}
```

- `admin` is the admin; `people` is everyone else. Another admin has `"admin"` in their `roles`.
- `decisions.finalSay` and area `owners` are person ids, not agent ids.
- `githubUsername`, `repos` and `git` may be left out.
- Step 2 settles `hosting`. Until then write `{ "mode": "trial" }`, and tell the admin that the
  summary's Hosting line comes in step 2.

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" setup render --dir "<workspace>" --dry-run`, show
the summary, and wait for a yes. It writes nothing. If it reports invalid answers, fix the file and
run it again.

## 2. Where

Offer three options:
- **A new cloud server**, created with the admin's own cloud CLI. It costs money.
- **An existing server** they can reach over SSH.
- **This machine, as a trial.** Say up front that teammates cannot join a trial (invites need a
  public TLS address). Going real later means running setup again with a server, and trial data
  is not carried over.

**New cloud server.**
1. Ask which provider's CLI they use and check that it is installed and logged in:
   `az account show`, `aws sts get-caller-identity`, `gcloud config get-value account`,
   `doctl account get` or `hcloud context active`. If it isn't, say so, link the CLI's install
   page and offer the other options. Installing and logging in is the admin's job.
2. Propose exactly this server, name the provider's size and its price, and say plainly that it
   costs money:
   - Ubuntu 24.04 LTS, 1–2 GB RAM and about 20 GB of disk;
   - a static public IP and a DNS name that points at it;
   - SSH key login, with the admin's existing public key;
   - inbound traffic: port 22 from the admin's IP only, and ports 4222 (NATS over TLS) and 80
     (Let's Encrypt) from anywhere.
3. The DNS name is either the admin's own subdomain (give them the A record to add and wait until
   it resolves) or the provider's free name where one exists, such as Azure's
   `<label>.<region>.cloudapp.azure.com`. AWS's `amazonaws.com` names cannot get a Let's Encrypt
   certificate, so AWS needs the admin's own domain.
4. After the yes, run the provider commands one at a time, and show each before it runs.
   `deploy/azure/provision.sh` in the AgentMesh repository is the reference for Azure: a resource
   group, a network security group with the three inbound rules, a Standard static public IP with
   a DNS label, and `az vm create` with the Ubuntu 24.04 image and the admin's SSH key.
5. Put the result into `hosting`:
   `{ "mode": "server", "ssh": "<user>@<host>", "publicHost": "<DNS name>" }`.

**Existing server.** Ask for `user@host` and the server's DNS name, and put them into `hosting`
the same way. The user needs sudo without a password.

On a server, `hosting.ssh` must be `user@host` with no leading dash, and `publicHost` must be a DNS
name, not an IP address. `remoteDir` (default `/opt/agentmesh`) is where the files go. ssh runs
without prompts, so the admin's key must work without one (an ssh agent); `ssh <user@host> true`
tests it.

**This machine.** Check Docker with `docker version`. Ask whether they want a second test agent
for another Claude account on this machine, and write `{ "mode": "trial", "testAgent": true }` or
`false`.

Run the dry run again and confirm the Hosting line with the admin.

## 3. Render

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" setup render --dir "<workspace>"`. It writes the
config, the keys (never printed), `deploy/.env` with an empty `DISCORD_BOT_TOKEN=` line, and the
NATS config. A re-run keeps existing files and keys.

## 4. Discord

1. Walk the admin through https://discord.com/developers/applications: create a new application,
   reset the bot token under **Bot**, and turn on the **Message Content** intent.
2. Ask them to paste the token into the empty `DISCORD_BOT_TOKEN=` line of
   `<workspace>/deploy/.env` in their own editor and save it. The token never goes into the chat.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" setup discord --dir "<workspace>" --wait-seconds 0`.
   It checks the token, and prints the bot's name and the link that adds the bot to a server.
   Show the link. Until the bot is in a server it says so, which is expected here.
4. Once the admin has added the bot, run
   `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" setup discord --dir "<workspace>"` until it succeeds.
   It waits for the bot to see the server and records its id. If the bot is in several servers,
   ask which one and re-run with `--guild <id>`.
5. Ask the admin to confirm the printed Discord account is theirs. If not, they copy their user id
   with Developer Mode, and you re-run with `--admin-discord-id <id>`.

## 5. Launch

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" setup host --dir "<workspace>"` (server only). It
installs Docker and certbot over SSH and gets the TLS certificate. Then run
`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" setup deploy --dir "<workspace>"`. It validates the
config, copies the files and starts the hub (on a trial, on this machine).

## 6. You join

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" setup admin --dir "<workspace>"`. Then call the
AgentMesh `connect` tool (`mcp__plugin_agentmesh_mesh__connect`), which connects this session as
the admin's agent without a restart. If there is no `connect` tool, or `setup admin` says to
restart, ask the admin to restart Claude Code with the channel flag and run `/agentmesh:setup`
again; setup continues here. Then ask the admin to run `/agentmesh:activate` (only they can).

## 7. Proof

1. Run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" doctor --dir "<workspace>"`.
2. Call `peers` and confirm the admin's agent is listed.
3. Call `broadcast` with `AgentMesh is set up for <team>. Hello from <agent>.`
4. Ask the admin whether they see it in `#mesh-council`.
5. Print the combined checklist in this format. The first lines come from `doctor` (a trial has no
   DNS and TLS line). A failing line gets ✗ and what to do next. Setup is done only when every line
   passes.

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

## 8. Your team

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" setup invites --dir "<workspace>"` and show its
output. Explain the order: teammates install the plugin first, following the note; then the admin
runs the `/mesh invite` lines in Discord, because codes expire 24 hours after the invite. A trial
has no invites.
