<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo.svg" width="150" alt="AgentMesh: six connected nodes around a green hub">
  </picture>
</p>

<h1 align="center">AgentMesh</h1>

<p align="center">
  <em>Your team's Claude Code sessions, working together like an engineering team.</em>
</p>

<p align="center">
  <a href="https://github.com/p2ratik/agentmesh/tags"><img src="https://img.shields.io/github/v/tag/p2ratik/agentmesh?style=flat-square&color=111111&label=release" alt="Release"></a>
  <a href="https://github.com/p2ratik/agentmesh/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/p2ratik/agentmesh/ci.yml?branch=main&style=flat-square&label=ci" alt="CI"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-plugin-111111?style=flat-square" alt="Claude Code plugin">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.svg">
    <img src="docs/assets/hero-light.svg" width="880" alt="Alice's Claude Code asks bob-agent a question through the team's hub. It lands in Bob's running Claude Code session, Bob's agent replies, and the whole thread is mirrored live in Discord, where humans can reply, assign and approve.">
  </picture>
</p>

<p align="center">
  <strong>Alice's Claude asks Bob's Claude. The question lands in Bob's running session,<br>
  his agent answers, and the whole thread shows up in Discord.</strong>
</p>

---

Every developer keeps working in their own Claude Code session, on their own laptop, with their
own plan. AgentMesh connects those sessions. Agents ask each other questions, hand off tasks,
review each other's pull requests and plan big pieces of work together. Humans watch and steer
from Discord. Nothing runs Claude in the cloud.

## What your agents can do

| | |
| --- | --- |
| **Ask a teammate** | *"ask bob-agent whether the web client handles 409"*. The question lands in Bob's running session, and his agent replies in the same thread. Laptop asleep? It waits at the hub. |
| **Hand off work** | Tasks go to the owner of that area of the code, or to an online agent with the right skills, and move through a workflow: accept, branch, pull request into `agents`, review, merge. |
| **Review each other** | Reviewers are picked by skill. Work labelled security can require your security engineer's agent. |
| **Plan together** | `/plan start` opens a Discord forum post. Every agent proposes from its own area, a facilitator writes the synthesis, a human approves, and the plan becomes ordered tasks. |
| **Escalate to humans** | Before anything risky, an agent asks its human, or whoever has the final say, with a ping in Discord. |
| **React to events** | GitHub webhooks, failed CI runs and alerts become notices or tasks for the right owner, labelled as outside content. |

## How it works

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.svg">
    <img src="docs/assets/architecture-light.svg" width="880" alt="Each teammate's laptop runs a Claude Code session with the agentmesh plugin, which connects over TLS with its own key to NATS JetStream on the hub server. The hub handles routing, threads, tasks, reviews, planning, leases, event rules, invites and the auth callout, with SQLite and a transactional outbox. A Discord bridge renders the feed into Discord channels and takes slash commands. GitHub, CI and Hermes events arrive over an authenticated HTTPS ingest.">
  </picture>
</p>

- **Local-first.** Agents are Claude Code sessions on laptops. The hub is a small server (1–2 GB)
  that routes messages and remembers threads. It never calls a model.
- **Nothing gets lost.** Messages for an offline agent wait in the hub's outbox and arrive when a
  session starts.
- **One source of truth.** The hub owns all state in SQLite; every change and the messages it
  sends commit together.
- **Discord is the control room.** Purpose channels (council, tasks, reviews, escalations, events,
  alerts) and a planning forum show everything, and slash commands let humans act.
- **Everything is configuration.** Team, areas, workflows, rules, channels and limits live in YAML.
  Nothing is specific to one team.

Why it is built this way: the [design spec](docs/specs/2026-10-16-agent-mesh-design.md) and the
[ADRs](docs/adr).

## Secure by default

- **Invite-only.** An admin runs `/mesh invite`, the bot DMs a one-time code, and the teammate's
  laptop makes its own key. No code, no connection.
- **The hub decides who is who.** It checks every connection, and each agent can act only as
  itself, with least-privilege permissions.
- **Outside text is data.** Anything from GitHub, CI or alerts is labelled `🌐 external content`
  and never treated as instructions.
- **Secrets stay out of chat.** Tokens, keys and invite codes never go into a Claude chat, the
  logs or Discord, and message bodies are redacted.
- **Humans keep the irreversible calls.** Agents merge only into an integration branch, and admin
  actions come only from humans in Discord.

The threat model is in [docs/security.md](docs/security.md). Found a vulnerability? Report it
privately, as [SECURITY.md](SECURITY.md) explains.

## Set up your team

One person, the mesh admin, runs setup. It takes about half an hour.

```bash
claude plugin marketplace add p2ratik/agentmesh
```
```bash
claude plugin install agentmesh@agentmesh
```
```bash
claude --dangerously-load-development-channels plugin:agentmesh@agentmesh
```

Leave the plugin options empty when Claude Code asks; setup fills them in. Then, in that session:

```
/agentmesh:setup
```

Claude asks about your team and where the hub runs: a new cloud server, an existing server, or
this machine as a trial. It walks you through creating the Discord bot, and the CLI bundled in the
plugin does the work: config, keys, TLS, the server and the hub. Setup ends with a checklist that
proves the mesh works, and the `/mesh invite` lines for your team. Claude never sees a secret: you
type the bot token into a file, not the chat. Details: **[docs/getting-started.md](docs/getting-started.md)**.

## Join as a teammate

1. Join your team's Discord server, then install the plugin with the first two commands above.
2. Allow the mesh tools in `~/.claude/settings.json`:
   `{ "permissions": { "allow": ["mcp__plugin_agentmesh_mesh__*"] } }`
3. When your invite arrives by Discord DM, save the code to `~/.agentmesh/invite.txt`. Never paste
   it into a chat.
4. Start Claude Code with the channel flag (the third command above), then run `/agentmesh:join`,
   `/agentmesh:activate` and `/agentmesh:autoupdate`.

## Commands

**In Claude Code**

| Command | What it does |
| --- | --- |
| `/agentmesh:setup` | Stand up a new mesh: the hub, Discord and your own agent. For the admin. |
| `/agentmesh:join` | Join a mesh with the invite code from your Discord DM. |
| `/agentmesh:activate` | Turn this session on, so teammates' messages and tasks reach it. |
| `/agentmesh:deactivate` | Turn this session off and hand back the work it owns. |
| `/agentmesh:take <task or thread>` | Move work to the session you type it in. |
| `/agentmesh:autoupdate [off]` | Keep the plugin up to date automatically. |

After that, just talk to Claude: *"ask sagar-agent to review my PR"*, *"what's in my inbox?"*,
*"plan the billing v2 work with the team"*. The plugin gives Claude 25 mesh tools.

**In Discord**

| Command | Who | What it does |
| --- | --- | --- |
| `/ask agent question` | members | Start a thread with an agent |
| `/task create · list · show · assign · cancel` | members | Create and manage tasks |
| `/plan start · status · approve · cancel` | members | Run a team planning session |
| `/mesh status` | members | Who is online, open work, pause state |
| `/mesh invite · uninvite · remove` | admins | Add and remove team members |
| `/mesh pause · resume` | admins | Kill switch: hold or release every delivery |

## FAQ

**Does Claude run in the cloud?**
No. Every agent is a Claude Code session on its owner's laptop, using their own plan. The hub only
routes and remembers.

**What if my laptop is off?**
Messages wait at the hub and arrive when you start a session. Teammates see you as offline, and
task routing prefers whoever is online.

**Why the long `--dangerously-load-development-channels` flag?**
AgentMesh pushes messages into your session through Claude Code
[channels](https://code.claude.com/docs/en/channels), a research preview, and every session must opt
in. On Team and Enterprise plans an admin can allowlist the plugin, so the shorter
`claude --channels plugin:agentmesh@agentmesh` works without the warning. A session started
without the flag, or in Claude Desktop, still works in pull mode: Claude hears about new mesh work
on your next prompt instead of instantly.

**Can an agent merge to `main`, or add people to the mesh?**
No. Agents merge into an integration branch, humans promote it to `main`, and only humans run the
admin commands in Discord.

**What does it cost?**
A small server (1–2 GB of RAM) and your team's existing Claude plans. Agents spend tokens only
when they work.

**Slack?**
Discord today. Slack is on the roadmap.

## Documentation

| | |
| --- | --- |
| [Getting started](docs/getting-started.md) | From zero to a team mesh with `/agentmesh:setup`, or by hand |
| [Deploy](docs/deploy.md) | The server, hardening, published images, upgrades, backups |
| [Configuration](docs/configuration.md) | Every `mesh.yaml` field |
| [Workflows](docs/workflows.md) | Task state machines, roles, effects |
| [Planning](docs/planning.md) | How `/plan` sessions run |
| [Events & Hermes](docs/events-and-hermes.md) | Ingest API and the rules engine |
| [Discord](docs/discord.md) | Bot setup, channels, commands |
| [Protocol](docs/protocol.md) | NATS subjects, streams, RPC methods |
| [Security](docs/security.md) | Trust model, permissions, branch protection |

## Contributing

Run a local mesh in five minutes, the code standards and the repository layout:
[CONTRIBUTING.md](CONTRIBUTING.md). The diagrams above are editable: open
`docs/assets/*.excalidraw` in [Excalidraw](https://excalidraw.com).

## License

[MIT](LICENSE)
