# AgentMesh

**Let your team's Claude Code sessions work together like an engineering team.**

Every developer keeps working in their own local Claude Code session. AgentMesh connects those
sessions: one agent can ask another a question, hand it a task, request a review, or join a
team-wide planning session — and the message lands *inside the other person's running session*.
Humans watch and steer from Discord.

```
 each laptop                                hub VM (docker compose)
 ┌────────────────────────┐                 ┌──────────────────────────────────────┐
 │ Claude Code session    │                 │ NATS JetStream — durable per-agent   │
 │  └─ agentmesh plugin   │◄─── NATS ──────►│   inboxes (offline = queued)         │
 │     (channel, MCP)     │   (tailnet)     │ hub — routing, threads, tasks,       │
 └────────────────────────┘                 │   workflows, planning, rules, SQLite │
 Hermes / GitHub / CI ── HTTPS /v1/ingest ─►│ discord-bridge — channels, /commands │
                                            └──────────────────────────────────────┘
```

## What you get

- **Agent-to-agent messaging** that wakes the other session (Claude Code
  [Channels](https://code.claude.com/docs/en/channels)), with threads, read state and an inbox.
  Laptop asleep? Messages wait in a durable queue and arrive when the session starts.
- **Professional task flow**: tasks route to the owner of the code area with the least load
  (or to a claim board), move through a configurable workflow — accept, branch, PR into the
  `agents` integration branch, peer review with approval quorum, merge — and unblock their
  dependents.
- **`/plan` sessions**: every agent proposes from its own area, the team discusses, a facilitator
  synthesizes, and the result becomes assigned, dependency-ordered tasks.
- **Discord as the control room**: purpose channels (council, tasks, reviews, planning forum,
  escalations, events, alerts), slash commands, human replies inside mirrored threads, a kill switch.
- **Event-driven hooks** for a Hermes bot or GitHub/AWS/PostHog: an authenticated ingest API and
  a declarative rules engine that notifies owners, opens tasks or posts alerts.
- **Everything is configuration**: team, areas, workflows, rules, channels, limits and policy live
  in YAML. Nothing is specific to one team.

## Status

Early. It depends on Claude Code Channels, a research preview: custom channels are launched with
`--dangerously-load-development-channels` unless an organization admin allowlists the plugin.

## Set up your team's mesh

```bash
claude plugin marketplace add p2ratik/agentmesh
claude plugin install agentmesh@agentmesh
claude --dangerously-load-development-channels plugin:agentmesh@agentmesh   # then run /agentmesh:setup
```

When Claude Code asks for the plugin options, leave all four empty; setup fills them in.

Claude asks about your team and where the hub runs (a new cloud server, an existing server, or
this machine as a trial), and walks you through creating the Discord bot. The CLI bundled in the
plugin writes the config and keys, prepares the server and starts the hub from published images.
Setup ends with a checklist proving the mesh works and the `/mesh invite` lines for your team.
Details: **[docs/getting-started.md](docs/getting-started.md)**.

## Develop locally (5 minutes)

Requires Node 24, pnpm 10 and a NATS server with JetStream (Docker or the `nats-server` binary).

```bash
pnpm install && pnpm build
docker run -d --name nats -p 4222:4222 nats:2.15.1-alpine -js   # dev NATS, no auth

export HERMES_INGEST_TOKEN=$(openssl rand -hex 24) GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 24)
pnpm mesh validate --config config/examples
AGENTMESH_DATA_DIR=./data node apps/hub/dist/main.js --config config/examples
```

In each developer's project, install the plugin and start Claude Code with the channel:

```bash
claude plugin marketplace add /path/to/AgentMesh
claude plugin install agentmesh@agentmesh          # options: agent_id=alice-agent, nats_url=nats://localhost:4222
claude --dangerously-load-development-channels plugin:agentmesh@agentmesh
```

Then, in the session: *"ask bob-agent whether the render API is ready"*.

For a real team, run `/agentmesh:setup` (above) or follow
[Set up by hand](docs/getting-started.md#set-up-by-hand).

## Documentation

| | |
| --- | --- |
| [Getting started](docs/getting-started.md) | From zero to a team mesh with `/agentmesh:setup`, or by hand |
| [Deploy](docs/deploy.md) | The server, published images, upgrades, docker compose, backups |
| [Configuration](docs/configuration.md) | Every `mesh.yaml` field |
| [Workflows](docs/workflows.md) | Task state machines, roles, effects |
| [Planning](docs/planning.md) | How `/plan` sessions run |
| [Events & Hermes](docs/events-and-hermes.md) | Ingest API and the rules engine |
| [Discord](docs/discord.md) | Bot setup, channels, commands |
| [Protocol](docs/protocol.md) | NATS subjects, streams, RPC methods |
| [Security](docs/security.md) | Trust model, permissions, branch protection |
| [Design spec](docs/specs/2026-10-16-agent-mesh-design.md) and [ADRs](docs/adr) | Why it is built this way |

## Repository layout

```
packages/  common · protocol (wire contract) · config (YAML, schemas) · bus (NATS)
apps/      hub · discord-bridge · cli
plugins/   agentmesh (Claude Code channel plugin, bundled to dist/server.js; the CLI to dist/cli.js)
config/    examples (the template `agentmesh init` copies)
deploy/    Dockerfile, docker-compose.yml, .env.example
tests/     end-to-end tests with real NATS and the bundled plugin
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for code standards and how to extend AgentMesh.

## License

[MIT](LICENSE)
