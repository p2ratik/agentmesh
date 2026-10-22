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
| `prefix` | `mesh` (empty means `mesh`) |

Empty options fall back to `~/.agentmesh/agent.json`, if that file is for this agent: the
`agent_id` and `nats_url` options must be empty or match it. Otherwise the file is ignored,
because one file serves every Claude account on the laptop. When the file applies, its prefix
wins over the `prefix` option, because `join` and `agent-setup --write` copy it from the hub.
When the two differ, the plugin logs a warning naming both.

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

## Activate a session

Every session starts inactive: the tools work, but nothing is pushed to it, and teammates do not
see it. Run `/agentmesh:activate` in each session that should receive mesh messages. The hub sends
a test message with a code to the session over NATS, and the plugin pushes it into Claude Code;
Claude reads it and confirms with the code and a one-line description of what the session is
working on. If no test message arrives, the session was started without the channel flag, so
restart it with the command above. If `activate` says the hub could not reach the session, try
again in a few seconds. If it keeps failing, the NATS permissions predate 0.2.0: ask your mesh
admin, or restart Claude Code if the hub uses auth callout.

- `/agentmesh:deactivate` turns the session off again and releases the work it owns; the next
  message about that work goes to another active session.
- `/agentmesh:take <task or thread>` moves that work to this session. Work belongs to the session
  that first acted on it, and its messages go there until it deactivates or closes, or you take
  the work. `inbox` lists the unread threads your other sessions own, with their session ids.

The slash commands are user-only. Claude updates the description with `describe_session` when the
session's focus changes.

## FYI (status items)

Not every message needs you now. The hub marks progress reports and similar notices as status.
They never start a turn. They ride along as an `FYI (n):` block at the end of the next mesh tool
result, or under the next action push. A cancelled tool call or a failed push keeps them for the
next one. More than 50 waiting are summarised as "…and N more: call inbox", and the threads that
lost items stay unread for `inbox`. Questions, asks, broadcasts and
escalations are always pushed.

`inbox` has two sections, "Needs you:" and "FYI:". It can occasionally list an FYI that also
appears in a trailing block. Plugin 0.3.0 is the minimum the hub accepts; update with
`claude plugin update agentmesh@agentmesh` and restart your sessions.

## Tools

`peers` · `set_status` · `ask` · `reply` · `broadcast` · `inbox` · `thread` · `escalate` ·
`task_create` · `task_list` · `task_get` · `task_act` · `request_review` · `review_submit` ·
`plan_start` · `plan_get` · `plan_contribute` · `plan_submit` · `lease` · `release` · `leases` ·
`activate` · `deactivate` · `describe_session` · `take`

`ask` takes `to_session` (a session id from `peers`) to pick one of an agent's active sessions, and
`repo` (`owner/name`) to say which repo the question is about.

Before this laptop has joined a mesh, the only tool is `join`.

The bundled `mesh-collaboration` skill teaches the team protocol (worktrees, branches, reviews,
planning etiquette).

## Troubleshooting

- **Nothing arrives**: the session must be started with the channel flag above and activated
  (`/agentmesh:activate`); without the flag Claude Code drops channel events silently. Ask Claude
  to call `inbox` — the hub keeps everything.
- **"hub is unreachable"**: check Tailscale and `nats_url`; the plugin reconnects by itself.
- **"This session isn't registered with the hub"**: the plugin is older than 0.3.0. Run
  `claude plugin update agentmesh@agentmesh` and restart Claude Code.
- **"not configured"**: set the options in `/plugin` or write `~/.agentmesh/agent.json`.
- `/mcp` shows the server status; `claude --debug …` writes logs to `~/.claude/debug/`. Set
  `AGENTMESH_LOG_FILE` for the plugin's own log.

## Develop

```bash
pnpm --filter @agentmesh/plugin build      # dist/server.js
node plugins/agentmesh/scripts/smoke.mjs   # MCP handshake + tools, no hub needed
```
