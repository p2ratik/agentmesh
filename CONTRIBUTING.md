# Contributing

## Setup

```bash
pnpm install
pnpm check          # typecheck + lint + file-size check + unit tests
pnpm build          # bundles hub, bridge, CLI and the plugin
```

End-to-end tests need NATS and the built plugin:

```bash
docker run -d -p 4222:4222 nats:2.15.1-alpine -js
AGENTMESH_TEST_NATS=nats://localhost:4222 AGENTMESH_TEST_NATS_BIN=$(which nats-server) pnpm test:integration
```

## Run a local mesh (5 minutes)

Requires Node 24, pnpm 10 and a NATS server with JetStream (Docker or the `nats-server` binary).

```bash
pnpm install && pnpm build
docker run -d --name nats -p 4222:4222 nats:2.15.1-alpine -js   # dev NATS, no auth

export HERMES_INGEST_TOKEN=$(openssl rand -hex 24) GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 24)
pnpm mesh validate --config config/examples
AGENTMESH_DATA_DIR=./data node apps/hub/dist/main.js --config config/examples
```

In each developer's project, install the plugin from your clone and start Claude Code with the
channel:

```bash
claude plugin marketplace add /path/to/AgentMesh
claude plugin install agentmesh@agentmesh          # options: agent_id=alice-agent, nats_url=nats://localhost:4222
claude --dangerously-load-development-channels plugin:agentmesh@agentmesh
```

Then, in the session: *"ask bob-agent whether the render API is ready"*.

## Diagrams

The README's diagrams live in `docs/assets/`: the `.excalidraw` files are the sources, and the
`*-light.svg` / `*-dark.svg` files are what GitHub shows. Edit a source in
[Excalidraw](https://excalidraw.com), then export it twice as SVG (light, and with dark mode on)
over the matching files.

## Code standards

- **Small, focused files.** No source file over 300 lines (`pnpm check:size` enforces it); aim for
  under 200. One responsibility per module.
- **Decisions in pure functions, I/O at the edges.** Routing, reviewer selection, rule matching,
  rendering and workflow checks are pure and unit-tested; repositories and adapters stay thin.
- **Strict TypeScript.** No `any`, no non-null assertions, `import type` for types.
- **Contracts first.** Wire types live in `packages/protocol`; hub modules talk only through
  `apps/hub/src/contracts.ts`.
- **Nothing team-specific in code.** Names, channels, limits, prompts and workflows come from config.
- Biome formats and lints (`pnpm format`, `pnpm lint`).

## Layout

| Path | What |
| --- | --- |
| `packages/protocol` | zod schemas: RPC methods, messages, tasks, plans, events, NATS subjects |
| `packages/config` | YAML loading, schemas, built-in workflows/template/policy, validation |
| `packages/bus` | NATS connection, topology, typed RPC, durable consumers |
| `apps/hub/src/modules/*` | control, presence, messaging, leases, tasks, planning, ingest |
| `apps/discord-bridge` | `render/` (pure), `feed/`, `commands/`, `discord/`, `inbound/` |
| `apps/cli` | `commands/`, `render/` (pure), `lib/` |
| `plugins/agentmesh` | MCP server, `tools/`, `inbox/` |

## Extending

- **A workflow effect**: add the name to `packages/config/src/effects.ts`, implement it in
  `apps/hub/src/modules/tasks/effects/` and register it in `effects/registry.ts` (the compiler
  enforces the registry is complete). Document it in `docs/workflows.md`.
- **A rule action**: extend `RuleAction` in `packages/config/src/schema/rules.ts`, handle it in
  `apps/hub/src/modules/ingest/rules/actions.ts`.
- **An RPC method**: define it in `packages/protocol/src/rpc/*.ts`, implement the handler in the
  owning hub module's `handlers`, expose it as a plugin tool in `plugins/agentmesh/src/tools/` if
  agents should use it.
- **A bridge (Slack, web)**: a service with `role: bridge` reads the activity feed
  (`runConsumer` on `{P}_EVENTS` with consumer `feed-{id}`), stores its external ids with
  `refs.*`, and relays humans with `actAs`. The Discord bridge is the reference.

## Pull requests

Keep them small, with tests for new behaviour. Never weaken a check to make CI green.
