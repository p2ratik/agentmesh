# ADR 0009 — Team work belongs to a session that can take it

**Status:** accepted · 2026-11-02; part 2 of 3 built (the mesh window), after part 1 (reads and
ownership, plugin 0.4.4). Part 2 ships in plugin 0.5.0. It amends
[ADR 0006](0006-per-session-delivery.md) ("reads claim nothing") and
[ADR 0008](0008-pull-mode.md) ("a pull session cannot hide work"). The design is
[the mesh window](../specs/2026-11-01-mesh-window-design.md).

## Context

A request for Aheen's agent went missing. Aheen uses Claude Desktop, which runs in pull mode, and
had it check the inbox every 5 minutes. A poll that ran in an unrelated project called `inbox.get`.
That call returned every unread thread nobody owned to any session of the agent, active or not, in
any project. It moved the agent-wide read cursor past them and claimed nothing. From then on no hook
line, no other session and no reminder showed the request again.

Three gaps made it easy:

- An inactive session could read and mark read work it could never act on.
- `thread` marked unowned threads read as well.
- `/mesh pause` held pushes but not reads.

ADR 0008 said a pull session "cannot hide work" because it is never delivered to. That holds for
deliveries, not for reads.

A teammate's request also had nowhere safe to land. Unowned work went to the agent's longest-active
session, usually the busiest one, and "work in a separate worktree" was only text in a skill, so a
plain `ask` such as "fix this bug" could end up in the human's own checkout.

## Decision, part 1: reads and ownership

Part 1 changes who may take unowned work.

- **Only a session that may take unowned work reads it, and marks it read.** That is an active push
  session, or an active pull session while the agent has no ready push session. Any other session
  (inactive, or pull while a push session is ready) reads only the threads it owns. One shared
  reader, `takeUnownedReader` in `apps/hub/src/modules/sessions/readers.ts`, is wired into
  messaging as `mayTakeUnowned`, and every read uses it.
- **Inactive sessions are told what waits.** `inbox.get` and `inbox.peek` return `waiting`: unowned
  unread threads this session may not take. The plugin's `inbox` tool says so.
- **`thread` marks read only what the session owns.** On a thread it does not own, it only looks.
  Callers without a session (humans, services) still mark read.
- **Pause stops consuming.** While `/mesh pause` is on, a read by a caller with a session only
  looks: `inbox.get` returns `paused: true` and advances nothing, and `thread` adds the note "The
  mesh is paused: nothing was marked read." Callers without a session are unaffected.
- **An active session's `inbox.get` claims the non-FYI threads it returns,** none while paused. A
  read that consumes work makes the reader its owner, so follow-ups go to the session that has the
  context. This amends ADR 0006: reads no longer claim nothing. It runs through the router's atomic
  claim path (`claims.ts`), so the read and the claims commit together.
- **An inactive session claims only its own conversations.** It claims through `message.send` on a
  `conversation` thread and `escalate` on an `escalation` thread. Its `task.*`, `review.*` and
  `plan.*` actions, and its replies into task, planning or event threads, claim nothing, so those
  threads stay unowned and route to an active session (`claimsWhenInactive`).
- **Routing skips an inactive owner reached through the chain.** An inactive session that owns the
  parent thread or the task no longer holds the work: routing falls through to the sender's pick,
  the repo and the longest-active rules. A thread's direct owner (in any state) still holds its
  conversation, and so do away or pull owners reached through the chain.

## Decision, part 2: the mesh window

Each teammate runs one **mesh window**: an activated push session, started by a launcher, that takes
the agent's team work (tasks, reviews, teammates' questions). Every other session is private.

- **The marker and the hello flag.** `agentmesh window init` writes a random token (32 hex
  characters) into `~/.agentmesh/mesh-window.json`. The launcher and the settings file's `env` set
  `AGENTMESH_MESH_WINDOW=<token>`.
  - The guard (below) is on whenever the variable is non-empty.
  - The plugin sends `meshWindow: true` in `session.hello` only when the value equals the policy's
    token and the policy's agent is the plugin's agent.
  - The hub stores the flag when it creates the session (migration 007, `sessions.mesh_window`)
    and never changes it. `peers` marks the session `[mesh window]`.
  - A marked session whose token doesn't verify refuses to `activate`.
- **Routing order:** owner chain → sender's pick → mesh window → repo → longest-active.
  - The mesh-window rule takes the longest-active ready window (reason `mesh window`).
  - It comes before the repo rule. A window started in a folder that holds the repos has no repo,
    so otherwise a session activated out of habit in the task's repo would collect the task,
    without the guard.
  - A fall-through past an inactive parent or task owner adds `; skipped inactive <id> (<why>)` to
    the reason.
- **The launcher and its settings file.** `/agentmesh:window` (user-only) asks for the team folder
  and the test commands, then runs the bundled CLI's `window init`. It writes, in `~/.agentmesh/`:
  - `mesh-window.json`, the policy: agent, token, own-branch prefix, integration branch, up to 10
    test commands;
  - `mesh-window.settings.json`, passed with `--settings`: the marker, the git environment, the
    allow rules, `disableAllHooks: false`, `defaultMode: "default"`, and bypass and auto mode
    disabled;
  - the launcher, `mesh-window.cmd` on Windows or `mesh-window` elsewhere;
  - an empty `empty-git-hooks/` folder.

  The launcher sets the marker, changes to the folder it is given, and runs
  `claude --dangerously-load-development-channels plugin:agentmesh@agentmesh -n mesh-<agent> --permission-mode default --settings <file> "/agentmesh:activate mesh window"`.
  Re-running `window init` keeps the token, so a running window stays verified.
- **Two layers, and the guard fails closed.**
  - The settings file's allow rules approve routine work.
  - The plugin's `PreToolUse` hook, `dist/guard.js`, acts only when the marker is set. It denies
    edits outside a registered `.claude/worktrees/mesh-*` worktree, and inside `~/.agentmesh` or
    any `.git`. It asks before any Bash command that isn't one of its exact forms. It never allows.
  - A hook's deny or ask outranks every allow rule and mode, so both layers must agree before
    anything runs without a prompt. The one exception is an installed mod: without managed settings
    or a Team or Enterprise login, a mod can approve a call the guard denied or asked about
    ([security.md](../security.md#tampering-git-and-settings)).
  - It fails closed. The hook has `onFailure: "block"` (Claude Code 2.1.295+). A call it can't read
    or a tool it doesn't know is refused, and a command it can't check asks. `activate` in a marked
    session refuses unless the guard stamped an `activate` call in the last 2 minutes
    (`guard-alive.json`).
- **Tests (Pratik's
  [decision 5](../specs/2026-11-01-mesh-window-design.md#12-pratiks-decisions-on-the-open-questions-2026-11-01))
  and the `working` reply.**
  - A test command runs without a prompt only in a mesh worktree on the window's own branch. The
    own-branch prefix is the branch template with `{owner}` and `{agent}` filled in, cut at the
    first other placeholder; it counts only when it ends in `/`, `_` or `.`. Anywhere else tests
    ask.
  - Reading another branch's diff never asks.
  - Before running another branch's tests, the window replies in the task thread with status
    `working`: "Running the tests on <branch> needs my human's approval; my verdict waits for it."
    `working` is a status item, so it never starts a turn for the author's agent. `needs_human`
    would interrupt the wrong person.
- **Rules from the plugin.** The window has no folder or rules file of its own. The `SessionStart`
  hook adds its rules at startup, after `/clear` and after compaction. The activation result repeats
  them, and the `mesh-collaboration` skill has a section on it. None of it uses the 4096-character
  MCP instructions.
- **The session-start hint.** In any other session, at startup only, on an enrolled laptop with no
  fresh heartbeat from an active push session, the hook shows one line saying nothing is listening.
  `AGENTMESH_MESH_WINDOW_HINT=off` hides it.
- **Layered settings are accepted.** Claude Code merges the human's user and project settings into
  the window. Cutting them with `--setting-sources` would drop the user settings that enable the
  plugin. The guard's deny and ask still outrank every allow rule.
- **The sandbox is deferred.** Decision 5 lets Claude Code's macOS and Linux sandbox stand in for
  the test prompt. It couldn't be tested on the Windows dev box, and a wrong sandbox config would run
  a foreign branch's tests unprompted. The prompt applies on every OS.

Still to come: plan 3, the relay, which carries an answer to the private session that asked.

## Consequences

Part 1:

- Inactive sessions only count team work. They cannot swallow it, so a private session no longer
  hides a teammate's request from the session that can act on it.
- A pull session takes unowned work only while no push session of the agent is ready. Pull mode
  still works for Claude Desktop users who have no push session.
- `thread` no longer marks unowned threads read. Consuming happens in `inbox`, where it also claims.
  A thread the session owns is unchanged.
- A session can still take work by acting: `take`, or a reply into an unowned conversation thread.
  Both are deliberate.
- `messages.seen` is unchanged. It can never pass an unread action.
- Without a mesh window, a request for an agent whose sessions are all inactive waits in the hub
  until someone activates a session. `waiting` and the plugin's `inbox` text tell the human.
- Tests that pinned the old behaviour (an inactive read of an unowned thread, "claims nothing for
  reads", the dispatcher's read-then-publish case) changed on purpose.

Part 2:

- Team work goes to the mesh window even when another active session is in the task's repo.
- Private sessions stay private. Activating a session (push or pull) without the marker still
  works, with a warning: "This isn't your mesh window; team work will come here while no mesh
  window is running."
- The window's own delivery runs without asking, from its own task worktree only: `git add`,
  `git commit -m '…'`, `git push [-u] origin <that branch>` and
  `gh pr create --base <integration> --head <that branch>`. Merges, force pushes, other branches
  and anything off the list prompt. Branch protection still gates every merge.
- PowerShell commands always ask in the window, so the window works through the Bash tool.
- Read-only shell commands other than `pwd`, `cd`, `ls`, `git status`, `git worktree list` and
  `git diff|log|show` ask, so the window reads files with Read, Grep and Glob.
- The guard runs in every session. It costs a `node` start (about 50–100 ms) on every edit, shell
  call, subagent and workflow call, and a broken install (no `node`, no `dist/guard.js`) blocks
  those calls in every session until it is fixed.
- The hub needs migration 007. A 0.5.0 plugin works with an older hub, which ignores the flag, so
  team work reaches the window by the old rules until the hub is upgraded.
- The threat notes are in [security.md](../security.md#sessions-and-per-session-delivery) and
  [security.md → The mesh window](../security.md#the-mesh-window).
