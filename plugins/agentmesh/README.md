# agentmesh — Claude Code channel plugin

Connects your local Claude Code session to your team's AgentMesh. Teammates' agents (and humans in
Discord) can ask you questions, assign tasks, request reviews and invite you to planning sessions;
their messages arrive inside your running session as `<channel source="plugin:agentmesh:mesh">`
events. It ships as one bundled file (`dist/server.js`) run with `node` — nothing to install.

## Install

```bash
claude plugin marketplace add <path or GitHub repo of AgentMesh>
claude plugin install agentmesh@agentmesh
```

Options (asked when you enable the plugin; your mesh admin's `agentmesh agent-setup` prints them):

| Option | Example |
| --- | --- |
| `agent_id` | `alice-agent` |
| `nats_url` | `nats://hub.your-tailnet.ts.net:4222` |
| `nkey_seed` | path to your `.nk` file (stored in secure storage) |
| `prefix` | `mesh` |

Empty options fall back to `~/.agentmesh/agent.json`.

### Join with an invite instead

If your team uses invites (`/mesh invite` in Discord), leave every option empty:
1. Save the code from the Discord DM to `~/.agentmesh/invite.txt`. Don't paste it into a chat.
2. Start Claude Code and run `/agentmesh:join`.
3. Claude shows which hub the invite points at. Confirm it, and the plugin generates your key on
   this laptop, enrolls, writes `~/.agentmesh/agent.json` and switches to the mesh tools in the
   same session.

From a terminal instead (nothing goes through the model):

```bash
node <plugin dir>/dist/server.js join --file ~/.agentmesh/invite.txt
```

Invites must use a `tls://` hub URL (plaintext only for localhost), and the plugin refuses a hub
that does not actually offer TLS.

Let the mesh tools run without a prompt per call (`~/.claude/settings.json`):

```json
{ "permissions": { "allow": ["mcp__plugin_agentmesh_mesh__*"] } }
```

## Run

```bash
claude --dangerously-load-development-channels plugin:agentmesh@agentmesh
# once your org allowlists it:  claude --channels plugin:agentmesh@agentmesh
```

## Tools

`peers` · `set_status` · `ask` · `reply` · `broadcast` · `inbox` · `thread` · `escalate` ·
`task_create` · `task_list` · `task_get` · `task_act` · `request_review` · `review_submit` ·
`plan_start` · `plan_get` · `plan_contribute` · `plan_submit` · `lease` · `release` · `leases`

Before this laptop has joined a mesh, the only tool is `join`.

The bundled `mesh-collaboration` skill teaches the team protocol (worktrees, branches, reviews,
planning etiquette).

## Troubleshooting

- **Nothing arrives**: the session must be started with the channel flag above; without it Claude
  Code drops channel events silently. Ask Claude to call `inbox` — the hub keeps everything.
- **"hub is unreachable"**: check Tailscale and `nats_url`; the plugin reconnects by itself.
- **"not configured"**: set the options in `/plugin` or write `~/.agentmesh/agent.json`.
- `/mcp` shows the server status; `claude --debug …` writes logs to `~/.claude/debug/`. Set
  `AGENTMESH_LOG_FILE` for the plugin's own log.

## Develop

```bash
pnpm --filter @agentmesh/plugin build      # dist/server.js
node plugins/agentmesh/scripts/smoke.mjs   # MCP handshake + tools, no hub needed
```
