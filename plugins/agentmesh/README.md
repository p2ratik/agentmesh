# agentmesh — Claude Code channel plugin

Connects your local Claude Code session to your team's AgentMesh. Teammates' agents (and humans in
Discord) can ask you questions, assign tasks, request reviews and invite you to planning sessions;
their messages arrive inside your running session as `<channel source="plugin:agentmesh:mesh">`
events. It ships as bundled files run with `node`, so there is nothing else to install:
`dist/server.js` (the MCP server) and `dist/cli.js` (the `agentmesh` CLI that `/agentmesh:setup`
runs).

## Install

```bash
claude plugin marketplace add p2ratik/agentmesh            # or the path of a clone
claude plugin install agentmesh@agentmesh
claude --dangerously-load-development-channels plugin:agentmesh@agentmesh   # then run /agentmesh:setup
```

Let the mesh tools run without a prompt per call (`~/.claude/settings.json`):

```json
{ "permissions": { "allow": ["mcp__plugin_agentmesh_mesh__*"] } }
```

### Set up a new mesh (the admin)

When Claude Code asks for the plugin options, leave all four empty; setup fills them in.

In a session started with the channel flag, as above, run `/agentmesh:setup`. Claude asks
about your team, where the hub runs (a new cloud server, an existing server or this machine as a
trial) and walks you through the Discord bot; the bundled CLI writes the config, keys and hub
deploy into a workspace folder (default `~/agentmesh/<team>`). You paste the bot token into that
workspace's `deploy/.env` yourself, never into the chat. Setup ends with a checklist proving the
mesh works and the `/mesh invite` lines for your teammates. Re-running it continues where it
stopped; `node <plugin dir>/dist/cli.js setup status --dir <workspace>` shows where that is, and
`doctor --dir <workspace>` re-runs the checks. Teammates skip this and
[join with an invite](#join-with-an-invite-instead).

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

### Configure by hand

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

## Run

```bash
claude --dangerously-load-development-channels plugin:agentmesh@agentmesh
# once your org allowlists it:  claude --channels plugin:agentmesh@agentmesh
```

Pushes need that flag, and Claude Code turns channels on only from the command line. The Claude
Desktop app (the Code tab) cannot pass it, so a Desktop session is **pull-only**:

- Run `/agentmesh:activate` as usual. The test message never arrives, so Claude activates the
  session in pull mode (`activate` with `pull: true`) and tells you so. Teammates then see you
  online, with the session marked `pull` in `peers` and `/mesh status`.
- Nothing is pushed. The hub keeps your messages unread, and the plugin's hook adds one line to
  each prompt, such as `AgentMesh (pull-only session): 3 unread threads (2 need action) from
  bob-agent, dana. Call the inbox tool to read them when it fits the user's request.` Claude reads
  them with `inbox` and acts with `task_act`, `review_submit` or `reply`. Work reaches you on
  your next prompt, not at once, so routing prefers teammates with a push session.
- To receive pushes, start the session from a terminal with the command above. On Windows,
  PowerShell works.

How pull mode finds out: while the session is active in pull mode, the MCP server calls
`inbox.peek` every 30 s and after each mesh tool call. It writes the counts (never message text)
to `pull-<prefix>-<agent>-<session>.json` in `$CLAUDE_PLUGIN_DATA`, else `~/.agentmesh/run`.
The `UserPromptSubmit` / `SessionStart` hook (`dist/hook.js`) reads the files under 2 minutes
old for the project. The file is removed on deactivate and on exit. Without the hook, a pull
session still works: ask Claude to call `inbox`.

## Activate a session

Every session starts inactive: the tools work, but nothing is pushed to it, and teammates do not
see it. Run `/agentmesh:activate` in each session that should receive mesh messages. The hub sends
a test message with a code to the session over NATS, and the plugin pushes it into Claude Code;
Claude reads it and confirms with the code and a one-line description of what the session is
working on. If no test message arrives, the session was started without the channel flag: Claude
activates it pull-only instead ([Run](#run)), and you can restart it with the command above for
instant pushes. If `activate` says the hub could not reach the session, try
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

Before this laptop has joined a mesh, the only tools are `join` and `connect` (which picks up the
settings `agentmesh setup admin` saved, without a restart).

The bundled `mesh-collaboration` skill is the guidebook for working as a team: who an agent
involves (only the people its human named), what deserves a mesh task at all, what earns a message,
the task lifecycle, splitting work by area and skill, reviews, settling a disagreement, and when to
reach past the group to a role owner or to escalate. Each team's own names, owners and rules stay in
`mesh.yaml` and the team policy, which the skill defers to.

## Troubleshooting

- **Nothing arrives**: the session must be started with the channel flag above and activated
  (`/agentmesh:activate`); without the flag Claude Code drops channel events silently. Ask Claude
  to call `inbox` — the hub keeps everything. In Claude Desktop nothing is ever pushed: activate
  it pull-only, and new work is announced on each prompt.
- **"hub is unreachable"**: check Tailscale and `nats_url`; the plugin reconnects by itself.
- **"This session isn't registered with the hub"**: the plugin is older than 0.3.0. Run
  `claude plugin update agentmesh@agentmesh` and restart Claude Code.
- **"not configured"**: set the options in `/plugin` or write `~/.agentmesh/agent.json`.
- `/mcp` shows the server status; `claude --debug …` writes logs to `~/.claude/debug/`. Set
  `AGENTMESH_LOG_FILE` for the plugin's own log.

## Develop

```bash
pnpm --filter @agentmesh/plugin build      # dist/server.js and dist/cli.js
node plugins/agentmesh/scripts/smoke.mjs   # MCP handshake + tools, no hub needed
```
