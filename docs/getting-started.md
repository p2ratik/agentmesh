# Getting started

From nothing to a team where every developer's agent is on the mesh, with a mesh window that takes
its team work. Roles: one **mesh admin** runs `/agentmesh:setup`, which stands up the hub and the
admin's own agent; every **developer** then joins by invite. To do it without setup, see
[Set up by hand](#set-up-by-hand).

## 1. What the admin needs

- **Claude Code** with Anthropic authentication (claude.ai or a Console API key). On
  Team/Enterprise plans an Owner must enable **Channels** (Organization settings → Claude Code →
  Channels).
- **Node 24.** The plugin and its bundled CLI run on it.
- **A Discord server** where you can add a bot. Everyone in the server can read the mesh channels
  ([discord.md](discord.md#channels)), so use one that holds only your team.
- **A place for the hub**, one of:
  - **a new cloud server**, created with your provider's CLI, installed and logged in. Ideally also
    a domain you control.
  - **an existing server** you reach over SSH with a key: Ubuntu 24.04 and passwordless `sudo`
    ([deploy.md → The server](deploy.md#the-server)).
  - **this machine, as a trial**, with Docker. Teammates cannot join a trial.

## 2. Run setup (admin)

```bash
claude plugin marketplace add p2ratik/agentmesh
claude plugin install agentmesh@agentmesh
claude --dangerously-load-development-channels plugin:agentmesh@agentmesh
```

When Claude Code asks for the plugin options, leave all four empty; setup fills them in.

Allow the mesh tools in `~/.claude/settings.json`, so that the mesh calls in steps 6 and 7, and
your agent's later work, do not each ask first. The rule covers only the mesh tools, not the CLI,
`ssh` or `scp`:

```json
{ "permissions": { "allow": ["mcp__plugin_agentmesh_mesh__*"] } }
```

In that session, run `/agentmesh:setup`. Claude asks for what it needs one topic at a time,
explains each step, and runs the `agentmesh` CLI bundled in the plugin
(`node <plugin dir>/dist/cli.js`) to make every change:

| Step | What happens | CLI |
| --- | --- | --- |
| 1. About you | Team name, what you build, the people (name, role, Discord username), other admins, who has the final say, whether plans need approval. Claude proposes ids, skills, areas and a short team policy for you to correct. Nothing is written until you confirm the summary. | `setup render --dry-run` |
| 2. Where | A new cloud server (Claude proposes the size, links the provider's pricing and waits for your yes), an existing server, or this machine. | — |
| 3. Render | The config, the keys (never printed), `deploy/.env` with an empty token line, and the NATS config. | `setup render` |
| 4. Discord | You create the bot and paste its token into `deploy/.env`. The CLI checks it, prints the link that adds the bot to your server and finds the server. | `setup discord` |
| 5. Launch | Docker, certbot, security updates, per-IP limits on NATS connections and the TLS certificate on the server, then the files copied over SSH and the hub started from the published images. | `setup host`, `setup deploy` |
| 6. You join | Your own agent is saved on this machine, and this session connects as it without a restart. You run `/agentmesh:activate`. | `setup admin` |
| 7. Proof | A checklist: DNS and TLS, the containers, the Discord channels, your agent's key, a round trip to this session and a hello in `#mesh-council`. | `doctor` |
| 8. Your team | One `/mesh invite` line per person, for you to run in Discord, and a note to send your teammates. | `setup invites` |

Worth knowing:
- **The bot token goes only into the workspace's `deploy/.env`,** typed in your own editor. Claude
  never asks for it and never reads the file. If you paste it into the chat anyway, reset it in
  the developer portal.
- **Claude never writes the config itself.** It writes your answers to `setup-answers.json`; the
  CLI renders and validates everything else.
- **You approve each command.** Setup adds no allow rules for the CLI, `ssh` or `scp`, so read what
  each one runs ([security.md](security.md#setup-and-the-admin-workspace)).
- **Setup is safe to re-run.** If a step fails, Claude shows the message; fix the cause and run
  `/agentmesh:setup` again. It continues from the step that failed (`setup status` shows where).
- **Agents never run `/mesh` admin commands,** yours included: you run the invite lines.
- **If this machine is already on another mesh,** `setup admin` refuses to replace
  `~/.agentmesh/agent.json` until you run it with `--replace`. The old mesh's agent then stops
  working here.
- **The plugin's `agent_id`, `nats_url` and `nkey_seed` options win over `agent.json`** while they
  name another agent. If you filled them in at install, or this machine joined another mesh
  through them, clear them in `/plugin` and restart Claude Code; `setup admin` reminds you.

### The workspace

Setup keeps everything in one folder on your machine, by default `~/agentmesh/<team>`:

```
setup-answers.json       your answers (no secrets)
.agentmesh-setup.json    which steps are done (no secrets)
config/                  mesh.yaml and policy/team-policy.md
deploy/                  docker-compose.yml, .env (the bot token), nats/nats.conf, secrets/*.nk
.gitignore               keeps .env, .env.*, secrets/, nats.conf and *.nk out of git
.claude/settings.json    denies Claude's Read tool on .env and secrets/
CLAUDE.md                the same rules for any later Claude session opened here, and how to
                         run the CLI (the path setup ran it from; never `npx agentmesh`)
```

An existing `.gitignore`, such as a repo's, is kept and only gains the lines it lacks.

Your own agent's key goes to `~/.agentmesh/<meshName>-<you>-agent.nk`, next to the `agent.json`
that `setup admin` writes. The mesh name keeps it apart from the keys of other meshes on this
machine.

- **After the first render, the files are the truth.** To change areas, the policy or workflows,
  ask Claude in the workspace or edit `config/` yourself, then run `setup deploy`
  ([deploy.md](deploy.md#checking-and-changing-a-setup-deploy)). Teammates never appear in
  `mesh.yaml`; they join by invite.
- **The workspace holds the hub's keys.** Keep it on an encrypted disk and out of synced folders.
  You can keep it in a private git repo; the `.gitignore` keeps the secrets out.

### A trial on this machine

- The hub and the Discord bridge run in Docker here. NATS listens on 127.0.0.1 without TLS, and
  the agents are listed in `mesh.yaml` instead of joining by invite.
- You can add a second test agent for another Claude account on this machine (`CLAUDE_CONFIG_DIR`);
  `setup admin` prints its `agent-setup` command.
- Teammates cannot join. To go real in the same workspace:
  1. Change `hosting` in `setup-answers.json` to the server.
  2. Run `setup render --force`. It sets `NATS_BIND` and `NATS_PUBLIC_HOST` in `deploy/.env` and
     marks host, deploy and admin as to do. `--force` re-renders `config/mesh.yaml` and the team
     policy from `setup-answers.json`, so re-apply any edits made to them during the trial.
  3. Stop the trial: run `docker compose --profile discord down` in `<workspace>/deploy`. Its
     containers restart with Docker, and two bridges with the same bot token would both answer
     every Discord interaction.
  4. Run `setup host`, `setup deploy` and `setup admin --replace`.

  Trial data is not carried over.

### After setup

- **Hand over to your mesh window.** The setup session holds the workspace's secrets, so it must
  not take team work: run `/agentmesh:deactivate` there. Then set up your
  [mesh window](#your-mesh-window) and start it in your team's folder, not in the workspace.
- `agentmesh doctor --dir <workspace>` re-runs the checks at any time.
- `agentmesh upgrade --dir <workspace>` moves the hub to another version
  ([deploy.md](deploy.md#upgrading-a-setup-deploy)).
- `agentmesh autoupdate` turns on automatic plugin updates for your own Claude account
  ([Keep AgentMesh updated](#keep-agentmesh-updated)).
- Members join and leave with `/mesh invite`, `/mesh uninvite` and `/mesh remove` in Discord.

## 3. Each developer's laptop

Setup's last step prints a note for the admin to send teammates; it says what this section says.
Install the plugin before the admin sends your invite: codes expire 24 hours after it.

Install the plugin and allow its tools (`~/.claude/settings.json`):

```bash
claude plugin marketplace add p2ratik/agentmesh
claude plugin install agentmesh@agentmesh
```

```json
{ "permissions": { "allow": ["mcp__plugin_agentmesh_mesh__*"] } }
```

Then either join with an invite or fill in the options by hand.

### Join with an invite

1. An admin runs `/mesh invite user:@dana id:dana skills:api` in Discord (options:
   [discord.md](discord.md#inviting-a-member)). The bot DMs you a one-time code. It works once
   and expires after `enrollment.inviteTtlHours` (24 hours by default). Allow DMs from the
   server's members, or the DM cannot reach you.
2. Leave every plugin option empty when Claude Code asks for them.
3. Save the code from the DM to `~/.agentmesh/invite.txt`. Never paste it into a chat: it is a
   one-time secret, and Claude is told never to ask for it.
4. Start Claude Code with the channel enabled (below) and run `/agentmesh:join`.
5. Claude shows which hub the invite points at, such as `mesh.example.com:4222`, and asks whether
   it is your team's hub. Confirm only if it is. A forged invite could point at someone else's
   hub.

The plugin then:
- generates your key on this laptop and enrolls with the hub;
- deletes `invite.txt`;
- writes `~/.agentmesh/agent.json` and `~/.agentmesh/<agent-id>.nk`;
- switches to the mesh tools in the same session.

From then on, the plugin connects with that key alone. Claude then offers to turn on automatic
plugin updates ([Keep AgentMesh updated](#keep-agentmesh-updated)).

To join from a terminal instead, so nothing goes through Claude:

```bash
node <plugin dir>/dist/server.js join --file ~/.agentmesh/invite.txt
```

The plugin dir is under `~/.claude/plugins/cache/agentmesh/agentmesh/<version>/`. Without
`--file`, the command asks you to paste the code into the terminal. `--yes` skips the hub
question.

If the hub refuses, the message is the same whatever the reason (used, expired, cancelled or
another hub's invite): ask your admin for a new invite. If the laptop is already set up for
another mesh, Claude asks you before replacing it. From a terminal, add `--replace`.

If you pasted the code somewhere, lost it, or it reached the wrong person, tell your admin right
away. They run `/mesh uninvite person:<your id>`, which stops the code working. If it says you
already joined, someone used the code, so they run `/mesh remove` first. Then they send a new
invite ([discord.md](discord.md#if-a-code-leaks-or-is-lost)).

### Your mesh window

Team work goes to one session per teammate, your **mesh window**: tasks, reviews and teammates'
questions. Your other sessions stay private. The window needs Claude Code 2.1.295 or later, and
`node` on PATH.

**Set it up once.** Run `/agentmesh:window` in any Claude Code session on this laptop;
`/agentmesh:join` offers it when it finishes. In the session that just joined, it reads your agent,
owner and Git rules from the `join` (or `connect`) result, since that session's instructions were
written before it joined; if it can't find them, it asks you to run it in a new session. Claude asks
for:
- your team's folder. We recommend the folder that holds the team's repos, so every repo is in
  reach; one repo checkout works too.
- the exact test commands the window may run on its own branches, such as
  `pnpm install --frozen-lockfile` and `pnpm test`. Only these exact strings run without a prompt;
  with none, every test run asks.

The bundled CLI (`agentmesh window init`) then writes the launcher and its settings into
`~/.agentmesh/`, and the `claude-mesh` command that runs the launcher. Run `/agentmesh:window`
again to change them, and restart the window to load them. If `CLAUDE_CONFIG_DIR` is set when it
runs (a second Claude account), the launcher starts the window in that account; it must be an
absolute path (no `~`). If it isn't set, the launcher clears one the terminal has, so the window
starts your default account. `window init` prints which account the window uses.

**Start it each day** in a terminal, in your team's folder:

```bash
claude-mesh                        # starts the window in the current folder
claude-mesh "/home/alice/code/acme"    # or names the folder, from anywhere
```

On Windows `claude-mesh` works in cmd, PowerShell and Git Bash. In PowerShell, type a bare
`claude-mesh` inside the folder: PowerShell passes a folder argument without spaces to cmd
unquoted, so a folder name with `&` or `^` would misbehave. In cmd and Git Bash a quoted folder
argument is fine.

`window init` puts `claude-mesh` in the folder `claude` was found in, which is on your PATH
already, when that folder is really under your home folder (links resolved): the native
installer's `~/.local/bin`, or npm's folder on Windows. On Windows that is a `claude-mesh.cmd` for
cmd and PowerShell, and a `claude-mesh` sh script for Git Bash, which enters the folder itself. It
never overwrites a `claude-mesh` it didn't write, and never changes PATH, the registry or your
shell profile.

When it can't put `claude-mesh` there (`claude` is outside your home folder, as with Homebrew; the
folder can't be written; or it holds something else named `claude-mesh`), it writes it to
`~/.agentmesh/bin` and prints a line telling you to add that folder to your PATH. It also warns,
naming the file, when someone else's `claude-mesh` comes first on PATH. Until typing `claude-mesh`
reaches one of its own, start the window with the line it prints instead:

```bash
~/.agentmesh/mesh-window "/home/alice/code/acme"
```

On Windows `window init` prints three lines. In PowerShell the launcher `mesh-window.cmd` (with
its absolute folder; a `~` in the folder doesn't work in PowerShell). In Git Bash the sh
`claude-mesh` by its path, because Git Bash can't pass a quoted folder to a `.cmd` whose own path
has a space. In cmd the launcher by `%USERPROFILE%`, since cmd doesn't know `~` at all:

```powershell
~/.agentmesh/mesh-window.cmd "C:\code\acme"    # PowerShell
```

```bash
~/.agentmesh/bin/claude-mesh "C:\code\acme"    # Git Bash
```

```bat
"%USERPROFILE%\.agentmesh\mesh-window.cmd" "C:\code\acme"
```

The Windows launcher and `claude-mesh.cmd` write paths under your user folder as
`%USERPROFILE%\…`, because cmd reads them in the console's code page; so a user folder with
non-ASCII letters works. `window init` refuses any other path with non-ASCII letters (Claude Code
installed outside your user folder, say).

Confirm the development channel when Claude Code asks. The window then activates itself with
`/agentmesh:activate mesh window`; if it doesn't, type that. Leave it open, and work in your other
sessions as usual. After a restart it lists its tasks and resumes those still in progress in their
existing worktrees, and it reads a thread before it answers a reply meant for its earlier session.

**What it does without asking, and what asks:**
- **Without asking:** edits inside its own `.claude/worktrees/mesh-*` worktrees (expected; a live
  check is pending, and if they prompt instead, that is safe); `git status`, `git fetch origin`,
  and adding and removing those worktrees; reading diffs; and, on its own branches, your test
  commands, `git add`, `git commit`, a push of that branch and `gh pr create` into the integration
  branch.
- **It asks you first:** before it runs the tests of a branch it didn't write (it tells the
  author's agent that the verdict waits for you), and for merges, force pushes, other branches,
  PowerShell commands and anything else not on its list.
- **Refused outright:** edits outside its mesh worktrees, in `~/.agentmesh/`, or in any `.git`
  folder.
- It never runs in auto or bypass mode. The details and their limits are in
  [security.md](security.md#the-mesh-window).

**Worktrees.** Every task and review gets its own worktree in the repo's `.claude/worktrees/`. Add
that folder to each repo's `.gitignore`, so the worktrees don't show up as untracked files:

```
.claude/worktrees/
```

`window init` warns about each checkout in the folder that lacks it. Make sure each repo's test
runner, typechecker and linter skip `.claude/worktrees/` too (vitest's default include does not).
The window never clones a repo: if a task's repo has no checkout in the folder, it asks you for the
path.

**Private sessions.** Every other session is your own work. Its mesh tools still work: it can `ask`
a teammate, and the answer waits for it (read it with `thread` or `inbox`). It doesn't take team
work, and the mesh window follows up the tasks a private session hands out. You can still activate
a private session; it then warns that team work will come to it while no mesh window is running.

**The session-start line.** When no session of yours is active with pushes (normally that is your
mesh window), a new session says so in one line at startup. Add `AGENTMESH_MESH_WINDOW_HINT=off` to the `env` of your Claude Code `settings.json` to
hide it.

**Claude Desktop users.** Desktop can't pass the channel flag, so it can't be a mesh window. Start
the window in a terminal, and turn off any inbox poll you set up in Desktop. Your Desktop sessions
become private sessions.

### Configure by hand (mesh.yaml)

The admin runs `pnpm mesh agent-setup <agent-id> --config config --nats-url nats://<vm-tailnet-name>:4222`
and sends you the output. Fill the plugin options when asked: `agent_id`, `nats_url`,
`nkey_seed` (the path to your `.nk` file) and `prefix`.

### Start a session

```bash
claude --dangerously-load-development-channels plugin:agentmesh@agentmesh
```

(Once an org admin adds `agentmesh@agentmesh` to `allowedChannelPlugins`, use
`claude --channels plugin:agentmesh@agentmesh`.)

**Claude Desktop is pull-only.** Pushes need the channel flag, and Claude Code turns channels on
only from the command line, so the Desktop app's Code tab cannot receive them. Run your
[mesh window](#your-mesh-window) in a terminal instead. Without one, you can run
`/agentmesh:activate` in Desktop: the test message never arrives, so Claude activates the session
in pull mode and says so. Teammates see you online (marked `pull`). Nothing is pushed: the hub keeps
your messages unread, and each prompt you type starts with one AgentMesh line counting them, so
Claude reads them with `inbox` and acts with `task_get`, `task_act`, `review_submit` or `reply`.
Work reaches a pull session on your next prompt, not at once, so routing prefers teammates with a
push session. To receive pushes, start a session from a terminal with the command above
(PowerShell on Windows).

Check it: ask Claude to run `peers` — you should see your teammates and who is online.

Your mesh window activates itself ([Your mesh window](#your-mesh-window)). Every other session
stays inactive: the mesh tools still work, but nothing is pushed to it, it reads only its own
threads, and teammates do not see it.

To make another session receive mesh messages anyway, run `/agentmesh:activate` there. The hub
sends the session a test message, and the session goes live once Claude confirms it arrived. If it
does not arrive, the session was started without the channel flag: Claude activates it pull-only
instead (see above), and you can restart it with the command above for instant pushes. (The mesh
window never goes pull-only: Claude tries again, then asks you to restart it with `claude-mesh`.)
If Claude
reports that the hub could not reach the session, try again in a few seconds. If it keeps failing,
the NATS permissions predate plugin 0.2.0: in static mode the admin re-renders nats.conf and
reloads NATS ([deploy.md](deploy.md#operations)); in auth-callout mode, restart Claude Code.
`/agentmesh:deactivate` turns a session off again and releases the work it owns, and
`/agentmesh:take <task or thread>` moves work to the session where you type it.

To take someone off the mesh, an admin runs `/mesh remove person:dana`. Their agent is
disconnected within seconds and refused from then on. People listed in mesh.yaml are removed by
editing it, followed by a re-render or a hub restart. The steps differ by mode; see
[deploy.md](deploy.md#operations).

### Keep AgentMesh updated

Claude Code leaves automatic updates off for a marketplace you add yourself, and the marketplace
cannot turn them on for you. Turn them on once per Claude account, in any of these ways:

- **The command.** In Claude Code, run `/agentmesh:autoupdate` (`/agentmesh:autoupdate off` turns
  it off again). `/agentmesh:join` and `/agentmesh:setup` also offer it. From a terminal:

  ```bash
  node <plugin dir>/dist/cli.js autoupdate     # --off turns it off again
  ```

  It sets `extraKnownMarketplaces.agentmesh` in your own `settings.json` (in `$CLAUDE_CONFIG_DIR`
  if set, else `~/.claude`) to the marketplace source Claude Code recorded when you added it, with
  `autoUpdate: true`. Nothing else in the file changes, and a second run says so.
  `--marketplace <name>` picks another marketplace name.
- **The toggle.** In Claude Code, `/plugin` → Marketplaces → agentmesh → Enable auto-update.
- **By hand**, in `~/.claude/settings.json`:

  ```json
  {
    "extraKnownMarketplaces": {
      "agentmesh": {
        "source": { "source": "github", "repo": "p2ratik/agentmesh" },
        "autoUpdate": true
      }
    }
  }
  ```

  Use the source you added the marketplace with: a different one makes Claude Code fetch the
  marketplace again. This setting wins over the `/plugin` toggle.

Claude Code downloads a new version in the background after a session's first message. Running
sessions keep the old version until you run `/reload-plugins` or restart Claude Code. Updates move
only the plugin; the hub changes version only with `agentmesh upgrade`.

**Optional, for a team repo.** The same `extraKnownMarketplaces` entry can go into the repo's
`.claude/settings.json`. It is a convenience, not a guarantee: it applies only to sessions started
in that repo, only after each teammate trusts the folder, and `enabledPlugins` there does not
install the plugin from this marketplace by itself, so each teammate still runs
`claude plugin install agentmesh@agentmesh`. The per-user setting above is the reliable path.

## 4. First run

- In Discord: `/ask agent:bob-agent question:What's left on the render queue?`
- `/task create title:Add retries to the queue consumer area:api`
- `/plan start topic:Render status end to end` — watch the agents propose and discuss in the
  planning forum; the facilitator's plan becomes tasks.
- `/mesh status` shows who is online and what is open. `/mesh pause` is the kill switch.

## Set up by hand

The manual path, without `/agentmesh:setup`: you write the config, generate the keys and run the
repo's compose file, which builds the images from source. Contributors use it, and so do teams
that keep NATS on a private network such as Tailscale. Plan about an hour.

### Prerequisites

- Node 24 and pnpm 10 on the admin's machine (to run the `agentmesh` CLI).
- A small Linux VM for the hub (see [deploy.md](deploy.md#deploying-by-hand)) with Docker.
- For invite-only onboarding: a DNS name for the VM with a TLS certificate for NATS. Without
  invites: [Tailscale](https://tailscale.com) (or another private network) on the VM and every
  laptop.
- Claude Code and a Discord server, as above.

### Create the config

```bash
git clone <your AgentMesh fork> && cd AgentMesh
pnpm install && pnpm build
pnpm mesh init config            # copies config/examples → config/
```

Edit `config/mesh.yaml`: your humans (with Discord user ids), one agent per person, your code
areas and owners, and the git policy. If members will join by invite (next steps), list only the
admin(s): `/mesh invite` refuses any id or Discord account that mesh.yaml already has. Areas can
still name the agents of people you will invite (`owners: [dana-agent]` for `id:dana`). They
become owners when they join. Then:

```bash
cp deploy/.env.example deploy/.env      # fill HERMES_INGEST_TOKEN etc. (openssl rand -hex 24)
set -a; . deploy/.env; set +a
pnpm mesh validate --config config
```

Every problem is reported with its path (`agents[1].owner: unknown human "bobb"`).

### Discord bot

Follow [discord.md → By hand](discord.md#by-hand): create the application, enable the **Message
Content** intent, invite the bot, put its token/application id/guild id in `deploy/.env`, and set
`discord.enabled: true`.

### Keys and NATS config

Every process authenticates to NATS with its own nkey; mesh.yaml stores only public keys. First
decide how members join:

- **By invite** (recommended). An admin runs `/mesh invite` in Discord. The member's laptop
  generates its own key, so no seed is handed over, mesh.yaml is not edited and nothing restarts.
  This needs NATS on a public TLS endpoint (`tls://`) and auth-callout mode.
- **By mesh.yaml**. You list every agent, generate each seed and send it privately. This works
  on a private network such as Tailscale without TLS.

You can mix the two: in auth-callout mode, the agents listed in mesh.yaml still connect with
their own keys.

#### With invites

```bash
for id in hub discord-bridge hermes hub-issuer hub-xkey hub-sys; do
  pnpm mesh keys add $id --config config --secrets deploy/secrets
done
pnpm mesh nats-config --config config --tls --auth-callout --out deploy/nats/nats.conf
```

- `hub-issuer`, `hub-xkey` and `hub-sys` are the hub's callout keys. `keys add` writes their
  public keys into `hub.authCallout`.
- In mesh.yaml, set `enrollment.natsUrl` to the address laptops connect to, for example
  `tls://mesh.example.com:4222`. It goes into every invite.
- Use `tls://`. The protocol also accepts `wss://`, but the plugin refuses websocket invites until
  its NATS client supports them.
- Keep at least one human with `roles: [admin]` and a `discordUserId` in mesh.yaml: only admins
  can run `/mesh invite`.

Then expose NATS on that address: the `deploy/.env` binds, the certificate files and the firewall
are in [deploy.md → Public TLS endpoint](deploy.md#public-tls-endpoint-for-invites).

All seeds stay on the VM.

#### With mesh.yaml only

```bash
for id in hub discord-bridge hermes alice-agent bob-agent carol-agent; do
  pnpm mesh keys add $id --config config --secrets deploy/secrets
done
pnpm mesh nats-config --config config --out deploy/nats/nats.conf
```

Each agent's seed (`deploy/secrets/<agent>.nk`) goes to its owner over a private channel. The
hub, bridge and ingest seeds stay on the VM.

### Start the hub (on the VM)

Copy the repo (with `config/`, `deploy/.env`, `deploy/secrets`, `deploy/nats/nats.conf`) to the
VM, then:

```bash
cd deploy
docker compose --profile discord up -d --build
docker compose logs -f hub        # "mesh topology ready" … "agentmesh hub started"
```

Discord now shows an **Agent Mesh** category with the purpose channels. Each developer then sets
up their laptop as in [section 3](#3-each-developers-laptop).

## Branch protection (recommended)

Agents push with their owners' credentials. Protect `main` so a pull request needs a human
CODEOWNER's approval, and let agents merge into `agents` after peer review. See
[security.md](security.md).
