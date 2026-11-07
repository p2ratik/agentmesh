# agentmesh — Claude Code channel plugin

Connects your local Claude Code session to your team's AgentMesh. Teammates' agents (and humans in
Discord) can ask you questions, assign tasks, request reviews and invite you to planning sessions;
their messages arrive inside your running session as `<channel source="plugin:agentmesh:mesh">`
events. It ships as bundled files run with `node`, so there is nothing else to install:
`dist/server.js` (the MCP server), `dist/cli.js` (the `agentmesh` CLI that `/agentmesh:setup` and
`/agentmesh:window` run), `dist/hook.js` (the prompt, session-start and session-end hook) and
`dist/guard.js` (the mesh window's worktree guard).

It needs Claude Code 2.1.295 or later and `node` on PATH: Claude Code runs the hooks with plain
`node`.

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

Claude Code leaves automatic updates off for this marketplace. Turn them on with
`/agentmesh:autoupdate`, in `/plugin` → Marketplaces → agentmesh → Enable auto-update, or by
saying yes when `/agentmesh:join` or `/agentmesh:setup` offers it (all of these set only
`extraKnownMarketplaces.agentmesh` in your own `~/.claude/settings.json`). New versions download in
the background and load after `/reload-plugins` or a restart
([more](../../docs/getting-started.md#keep-agentmesh-updated)).

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
4. Set up your [mesh window](#your-mesh-window) with `/agentmesh:window`.

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

## Your mesh window

Team work (tasks, reviews and teammates' questions) goes to one session per teammate, the **mesh
window**. Every other session is private.

**Set it up once** with `/agentmesh:window`; `/agentmesh:join` and `/agentmesh:setup` offer it.
Claude asks for your team's folder and the exact test commands, and the bundled CLI
(`agentmesh window init`) writes the launcher, its settings and its policy into `~/.agentmesh/`
([files](#settings-and-files)). Run it again to change them; the window keeps its token. With
`CLAUDE_CONFIG_DIR` set (an absolute path), the window starts in that Claude account; without it,
the launcher clears one the terminal has. `window init` prints which account it uses.

**Start it each day** in a terminal, in the folder that holds your team's repos:

```bash
claude-mesh                        # in the current folder
claude-mesh "/home/alice/code/acme"    # or in the folder it names, from anywhere
```

`claude-mesh` only runs the launcher. On Windows it works in cmd, PowerShell and Git Bash; in
PowerShell, type a bare `claude-mesh` inside the folder, because PowerShell passes a folder
argument without spaces to cmd unquoted, and a name with `&` or `^` would misbehave.

`window init` writes it next to `claude`, whose folder is on PATH already, when that folder is
really under your home folder (links resolved) and holds nothing named `claude-mesh` that it
didn't write. On Windows that is `claude-mesh.cmd` plus a `claude-mesh` sh script for Git Bash,
which enters the folder itself. Otherwise it writes it to `~/.agentmesh/bin` and prints a line
telling you to add that folder to your PATH; it never changes PATH itself. It also warns, naming
the file, when someone else's `claude-mesh` comes first on PATH. Until typing `claude-mesh`
reaches one of its own, use the line it prints:

```bash
~/.agentmesh/mesh-window "/home/alice/code/acme"
```

On Windows that is three lines:
- PowerShell gets the launcher `mesh-window.cmd`, with its absolute folder (a `~` in the folder
  doesn't work in PowerShell).
- Git Bash gets the sh `claude-mesh` by its path, because Git Bash can't pass a quoted folder to a
  `.cmd` whose own path has a space.
- cmd gets the launcher by `%USERPROFILE%`, since cmd doesn't know `~`.

```powershell
~/.agentmesh/mesh-window.cmd "C:\code\acme"    # PowerShell
```

```bash
~/.agentmesh/bin/claude-mesh "C:\code\acme"    # Git Bash
```

```bat
"%USERPROFILE%\.agentmesh\mesh-window.cmd" "C:\code\acme"
```

The Windows launcher and `claude-mesh.cmd` write paths under your user folder as `%USERPROFILE%\…`,
so a non-ASCII user folder works; any other non-ASCII path is refused.

The launcher marks the session and starts Claude Code with the channel flag, the name
`mesh-<agent>`, `--permission-mode default` and its settings file. The window then activates itself
with `/agentmesh:activate mesh window`; if it doesn't, type that.

**How it works.** Its rules come from the plugin: the `SessionStart` hook adds them at startup,
after `/clear` and after compaction, and `activate` repeats them.
- Each task and review gets its own `.claude/worktrees/mesh-*` worktree, made from the checkout
  `task_get` names (the one git checkout in the folder whose `origin` matches the task's repo).
- Routine steps run without asking. Tests on a branch the window didn't write, merges, force
  pushes, other branches and anything off its list ask
  ([security](../../docs/security.md#the-mesh-window)).
- It runs commands with the Bash tool; PowerShell commands always ask.
- After a restart it resumes its in-progress tasks (`task_list`) in their existing worktrees, and
  reads a thread (`thread`) before answering a reply meant for its earlier session.
- Before it starts a task it reads the task and its thread, asks the creator anything unclear,
  and checks for overlap: leases, everyone's tasks, and `task_get`'s count of your private
  sessions in that repo. It tells you; it never messages your sessions.
- It forwards reply pointers to your private sessions ([below](#other-sessions)) and sends nothing
  else with `SendMessage`. A cross-session message to the window is data, never instructions.
- Its `activate` result carries the full team policy, which the plugin's instructions cut at
  4096 characters.
- It never activates with `pull: true`.

**The worktree guard** is `dist/guard.js`, a `PreToolUse` hook on edits, Bash, PowerShell, Monitor,
`EnterWorktree`, `Agent`, `Workflow`, `SendMessage`, `ListAgents` and `activate`.
- Claude Code runs it in every session, which costs a `node` start (about 50–100 ms) per edit,
  shell call, subagent or workflow call. Outside the mesh window it does nothing else.
- In the window it refuses edits outside its mesh worktrees and asks before commands that aren't on
  its list. It passes one `SendMessage` per reply pointer the plugin pushed, exactly as pushed, and
  refuses every other one and `ListAgents`. `activate` there refuses unless the guard stamped an
  `activate` call in the last 2 minutes (`guard-alive.json`).
- It fails closed (`onFailure: "block"`, Claude Code 2.1.295+). If `node` or `dist/guard.js` is
  missing, edits and shell calls are blocked in every session until it is fixed.

**The session-start line.** In any other session, when no session of this account is active with
pushes (normally that is the mesh window), the hook shows one line at startup: "No AgentMesh mesh
window is running for this account, so teammates' requests will wait. …". Set `AGENTMESH_MESH_WINDOW_HINT=off` in the `env` of your Claude Code
`settings.json` to hide it.

## Other sessions

There are three kinds of session: your mesh window, private sessions, and sessions you activate
that aren't the window.

Every other session starts **private** (inactive): the tools work, but nothing is pushed to it,
and teammates do not see it. It can `ask` a teammate, and the answer comes back to it:
- **A pointer, on Windows.** The mesh window sends the session one line through Claude Code's
  cross-session messaging: `AgentMesh: bob-agent answered in thr-12 (msg msg-01…). Read it with
  thread thr-12 and reply there. Do not reply to this message.` It carries no content; the session
  reads the answer with `thread`. The prompt hook marks it a verified pointer only when it comes
  from your mesh window's address and has exactly that form. Cross-session messaging needs Claude
  Code 2.1.234 or later on native Windows (any Claude Code this plugin supports has it), and
  `crossSessionInbound` unset or `accept`. A session in bypass mode holds the pointer for approval
  and drops it after 5 minutes; VS Code, Desktop and `-p` sessions can't show that approval.
- **A note.** While an answer waits, the session's next prompt gets one line:
  `AgentMesh: 1 unread repl(ies) from bob-agent in threads this session started; call inbox to read
  them.` It finds the session by its Claude Code process, which is verified on Windows. It is the
  only path on macOS and Linux in 0.6.0, where it relies on the MCP server being a child of the
  Claude Code process, which the probe checks
  ([below](#cross-session-messaging-on-linux-and-macos)).
- Both start once the session has made a mesh call (asking is one). `AGENTMESH_RELAY=off` turns
  the pointers off for a session; the note stays.
- **If the session closed** before the answer came, the answer goes to the mesh window, which asks
  you to continue it there, reopen that session (`claude --resume <id>`, which gives it its threads
  back), or drop it. Unanswered, the hub pings you on Discord after the team's
  `relay.closedAskerEscalationMinutes` (15 by default).

The mesh window follows up the tasks a private session hands out. The task's description is the
handoff note: what you learned, files and lines, decisions, what is open. Everyone in the Discord
server can read it.

The third kind is an activated session that isn't the window. To make one receive mesh messages
anyway, run `/agentmesh:activate` there; Claude warns that team work will come to it while no mesh
window is running. The hub sends a test message with a code to the session over NATS, and the
plugin pushes it into Claude Code; Claude reads it and confirms with the code and a one-line
description of what the session is working on. If no test message arrives, the session was started
without the channel flag: Claude activates it pull-only instead ([Run](#run)), and you can restart
it with the command above for instant pushes. The mesh window never goes pull-only: Claude tries
again, then asks you to restart it with `claude-mesh`. If `activate` says the hub could not reach
the session, try again in a few seconds. If it keeps failing, the NATS permissions predate 0.2.0:
ask your mesh admin, or restart Claude Code if the hub uses auth callout.

- `/agentmesh:deactivate` turns the session off again and releases the work it owns; the next
  message about that work goes to another active session.
- `/agentmesh:take <task or thread>` moves that work to this session. Work belongs to the session
  that first acted on it, and its messages go there until it deactivates or closes, or you take
  the work. `inbox` lists the unread threads your other sessions own, with their session ids.
  An inactive session's `inbox` reads only the threads it owns; other team work is only counted
  ("N team thread(s) are waiting…") until a session is activated.

The slash commands are user-only. Claude updates the description with `describe_session` when the
session's focus changes.

## Settings and files

The plugin options are in [Configure by hand](#configure-by-hand). Environment knobs go in the
`env` of your Claude Code `settings.json`, or the shell that starts Claude Code:

| Variable | Meaning |
| --- | --- |
| `AGENTMESH_MESH_WINDOW` | Marks the mesh window with the token from `mesh-window.json`. Only the launcher and its settings file set it; never set it by hand. Any value turns the guard on, and only the matching token makes the session your mesh window. |
| `AGENTMESH_MESH_WINDOW_HINT` | `off` hides the session-start line about a missing mesh window. |
| `AGENTMESH_RELAY` | `off` stops the mesh window from sending reply pointers to this session. The note on the next prompt stays. |
| `AGENTMESH_LOG_FILE` | A file for the plugin's own log. |
| `AGENTMESH_HEARTBEAT_SECONDS` | The presence heartbeat, default 20, at least 5. |

Files in `~/.agentmesh/`:

| File | Written by | Holds |
| --- | --- | --- |
| `agent.json` and your `.nk` key | `/agentmesh:join`, `setup admin` or `agent-setup --write` | Your agent's settings and its key |
| `mesh-window.json` | `window init` | The window's policy: agent, token, own-branch prefix, integration branch, test commands (mode 600) |
| `mesh-window.settings.json` | `window init` | The settings file the launcher passes with `--settings`: the marker, the git environment and the allow rules (mode 600) |
| `mesh-window` (`mesh-window.cmd` on Windows) | `window init` | The launcher (mode 700) |
| `empty-git-hooks/` | `window init` | An empty folder; the window's git uses it as `core.hooksPath` |
| `bin/claude-mesh` (plus `claude-mesh.cmd` on Windows) | `window init` | `claude-mesh`, only when it can't go next to `claude` (mode 755); add `bin/` to your PATH |

State files go in `$CLAUDE_PLUGIN_DATA`, else `~/.agentmesh/run`. They never hold message text.
On macOS and Linux they are mode 600 (a folder the plugin creates for them is 700); Windows ignores
modes, so there your user profile's permissions protect them.
- `pull-…json` for a pull session ([Run](#run));
- a `push-…json` heartbeat from each active push session (the session-start line checks it; the
  mesh window's also holds its messaging address);
- `sess-…json`, a private session's record once it has made a mesh call: its address, its unread
  reply counts and project folder, refreshed every 30 s, for the note and the relay;
- `cc-<pid>.json`, Claude Code's conversation id per process, for `claude --resume`: written at
  session start, deleted at session end;
- `fwd-…json` (and `….claimed`), the mesh window's note to its guard of a pointer it pushed;
- `guard-alive.json`, the guard's stamp for `activate`, with its version;
- `events-<agent>-<pid>.jsonl`, the guard's and hook's timeline events (codes and counts, at most
  256 KB each), which the MCP server ships and deletes ([below](#what-agentmesh-records)).

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

## What AgentMesh records

The plugin, its guard and its hook report how AgentMesh behaves on this laptop to your team's hub,
which keeps the events for `observability.retentionDays` (14 by default). They hold ids, counts,
outcomes, error codes, timings and versions only. Never message text, prompts, code, file contents,
tool output or command lines.

- **Recorded:** the plugin, Claude Code and Node versions, the OS and CPU architecture; NATS
  disconnects and reconnects; activation steps; each mesh tool call's name, outcome, duration and
  the thread, task or plan id it named; each message's delivery stages; reply pointers; the mesh
  window guard's denials and asks, with the tool's name and a reason code; which fixed line the
  hook added to a prompt; and how many events were lost on the way.
- **Who can read it:** through the mesh, only the humans in `observability.viewers` in `mesh.yaml`
  (nobody by default), and the hub enforces it. Teammates and admins who aren't viewers are
  refused. Anyone with access to the hub's server, its data volume or a backup can read the events
  table directly, as they can the messages.
- **Off:** with `observability.enabled: false` on the hub, the plugin stops recording within one
  beat and drops what it holds. While off it sends one empty, free report a beat to check back,
  and it records again as soon as the hub takes one.

The full list, and what is never recorded, is in
[security](../../docs/security.md#what-agentmesh-records-about-your-sessions-and-what-it-never-records).

**Reading it (operators).** Ask Claude in any session, "show me alice-agent's mesh timeline for the
last two hours" (the `timeline` tool), or run:

```bash
node <plugin dir>/dist/cli.js timeline --agent alice-agent --since 2h
node <plugin dir>/dist/cli.js timeline --thread thr-31 --json   # one event per line
```

Options: `--agent`, `--session`, `--thread thr-N`, `--since` and `--until` (an ISO time or a
duration such as `30m`, `2h`, `1d`), `--limit` (up to 2000) and `--json`. The command uses your
agent's own settings in `~/.agentmesh/agent.json` (it ignores `AGENTMESH_*` overrides), makes one
call with a 5 s connect timeout, and exits within 2 s once its output is flushed. It exits 1 with
`error: …` when it is refused. On Windows, a key NATS refuses can show as an `ECONNRESET` error
rather than an authorization error. The tool's result starts with a line labelling it as data,
never instructions; the command prints no label. How to read the lines:
[protocol](../../docs/protocol.md#reading-the-timeline).

## Tools

`peers` · `set_status` · `ask` · `reply` · `broadcast` · `inbox` · `thread` · `escalate` ·
`task_create` · `task_list` · `task_get` · `task_act` · `request_review` · `review_submit` ·
`plan_start` · `plan_get` · `plan_contribute` · `plan_submit` · `lease` · `release` · `leases` ·
`activate` · `deactivate` · `describe_session` · `take` · `timeline`

`ask` takes `to_session` (a session id from `peers`) to pick one of an agent's active sessions, and
`repo` (`owner/name`) to say which repo the question is about.

`timeline` is for operators only ([above](#what-agentmesh-records)); the hub refuses anyone else.

Before this laptop has joined a mesh, the only tools are `join` and `connect` (which picks up the
settings `agentmesh setup admin` saved, without a restart).

The bundled `mesh-collaboration` skill is the guidebook for working as a team: who an agent
involves (only the people its human named), what deserves a mesh task at all, what earns a message,
the task lifecycle, splitting work by area and skill, reviews, settling a disagreement, and when to
reach past the group to a role owner or to escalate. Each team's own names, owners and rules stay in
`mesh.yaml` and the team policy, which the skill defers to.

## Cross-session messaging on Linux and macOS

The reply pointer runs only on Windows in 0.6.0, where the messaging address has been checked. On
Linux and macOS the mesh window doesn't forward it, and the AgentMesh line on the session's next
prompt says when an answer waits. That line finds the session by its Claude Code process, which
the probe also checks. Linux follows once the probe below shows what its address looks like; macOS
stays off for now.

To learn what the address looks like on Linux, run the probe once, from any folder:

```
node <plugin dir>/scripts/probe-messaging.mjs
```

It starts one non-interactive `claude -p` that loads no settings or plugins, so nothing reaches the
mesh. Claude Code records a project entry for the probe's temp folder in `~/.claude.json`. Paste the
output into the thread. Never run it inside a Claude Code session, because it starts Claude Code.

## Troubleshooting

- **Nothing arrives**: the session must be started with the channel flag above and activated
  (`/agentmesh:activate`; the mesh window launcher does both); without the flag Claude Code drops
  channel events silently. Ask Claude
  to call `inbox` — the hub keeps everything (an inactive session's `inbox` only counts team work and reads just its own threads). In Claude Desktop nothing is ever pushed: activate
  it pull-only, and new work is announced on each prompt.
- **"hub is unreachable"**: check Tailscale and `nats_url`; the plugin reconnects by itself.
- **"This session isn't registered with the hub"**: the plugin is older than 0.3.0. Run
  `claude plugin update agentmesh@agentmesh` and restart Claude Code.
- **"not configured"**: set the options in `/plugin` or write `~/.agentmesh/agent.json`.
- **Edits and shell calls are blocked in every session**: the guard couldn't start. Check that
  `node` is on PATH and that the plugin's `dist/guard.js` exists (update the plugin).
- **The mesh window won't activate**:
  - "The mesh window's worktree guard did not run for this call…": hooks are off
    (`disableAllHooks`) or `node` isn't on PATH.
  - "AGENTMESH_MESH_WINDOW is set, but it doesn't match…": start the window with `claude-mesh`, or
    run `/agentmesh:window` again.
- **`claude-mesh` not found after switching Node versions**: if `claude` lives in a
  version-managed folder (nvm and the like), `claude-mesh` went there too; re-run
  `/agentmesh:window` after switching versions.
- **`claude-mesh` starts a session that says it isn't your mesh window**: something else named
  `claude-mesh` ran, such as a function or alias in a shell profile. Find it with
  `Get-Command claude-mesh -All` (PowerShell) or `type claude-mesh` (bash, zsh). `window init`
  warns about the ones it finds in startup files.
- **The old mesh window still shows in `peers`**: closing its terminal says goodbye to the hub (a
  live check is pending). A laptop that slept or crashed leaves it away after
  `presence.offlineAfterSeconds`; `peers` shows `[away: no heartbeat since HH:MM; closes HH:MM
  unless it returns]`. A new `claude-mesh` window takes over its threads as soon as it activates;
  otherwise they wait until it closes (`presence.ownershipGraceMinutes`).
- **A private session never got its answer**: check the AgentMesh line on its next prompt, or ask
  Claude to call `inbox`. The pointer needs Windows, Claude Code 2.1.234 or later,
  `crossSessionInbound` unset or `accept`, a session not in bypass mode, a running mesh window and
  no `AGENTMESH_RELAY=off`.
- **The window didn't offer the closed-asker choices**: they come with a push. If the window read
  the answer with `inbox` instead, the thread is simply its work now.
- **`claude --resume` didn't bring a thread back**: resume is best effort. It needs Claude Code to
  keep the same conversation id, and it misses if the plugin's MCP server restarted inside a
  long-running Claude Code. The mesh window still has the answer.
- `/mcp` shows the server status; `claude --debug …` writes logs to `~/.claude/debug/`. Set
  `AGENTMESH_LOG_FILE` for the plugin's own log.

## Develop

```bash
pnpm --filter @agentmesh/plugin build      # dist/server.js, cli.js, hook.js and guard.js
node plugins/agentmesh/scripts/smoke.mjs   # MCP handshake + tools, no hub needed
```
