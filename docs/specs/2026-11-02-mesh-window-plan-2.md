# Mesh window, plan 2: the mesh window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every teammate gets one marked, guarded session that takes the team's work (the mesh
window), started in any folder by a one-time `/agentmesh:window` and a daily launcher, doing every
piece of work in its own worktree, and asking its human before it runs a branch it didn't write.

**Architecture:**
- **Marked and preferred.** The launcher sets a random-token marker. The plugin reports
  `meshWindow` in hello when the token matches `~/.agentmesh/mesh-window.json`, and the hub's pure
  router prefers a ready mesh window right after the sender's pick, ahead of the repo rule.
- **Two layers of enforcement, both Claude Code's own.** The launcher's `--settings` file carries
  the allow rules for routine work. A plugin `PreToolUse` hook (`dist/guard.js`, built-ins only)
  denies edits outside registered `mesh-*` worktrees and asks before any shell command that isn't
  on its exact list, including tests on branches that aren't the window's own.
- **Rules from the plugin.** The `SessionStart` hook gives the window its rules and tells other
  sessions, once at startup, when nothing listens. The activation result repeats the rules, and the
  skill has a section for each kind of session.
- The file format the CLI writes and the plugin reads lives in one built-ins-only module,
  `@agentmesh/common/window`.

**Tech Stack:**
- Node 24, TypeScript 7, zod 4 (not in the hook or the guard), vitest 5, Biome 2, pnpm 10, tsup.
- Claude Code 2.1.316 on the dev box. The guard needs 2.1.295+ (`onFailure`).

**Spec:** `docs/specs/2026-11-01-mesh-window-design.md`: §3, §6, the plan-2 parts of §7, §8, §10,
§11, §12 decisions 1–5, and §13 "The worktree guard (plan 2)", "Routing and settings (plan 2)" and
the overstated claims. **Out of scope (plan 3):** the relay, `localKey`, `host`, the nudge,
`AGENTMESH_RELAY`, the `SendMessage` guard, and §13 "The relay (plan 3)".

**Where to work:**
- The worktree `G:\Projects\AgentMesh-meshwindow`, on branch `agent/pratik/mesh-window`, from
  `896239d`. Plan 1 is built there (`git log 61f393d..HEAD`).
- Commit after each task. **Never push.** Pratik pushes and merges.

## Rulings

Builder-level calls this plan makes. Each says what it costs if it's wrong.

- **Ruling: one shared format module.** `packages/common/src/window.ts` is exported as
  `@agentmesh/common/window` and imports only `node:*`. The CLI writes the files and the plugin
  (server, hook, guard) reads them, and zod stays out of `dist/hook.js` and `dist/guard.js`.
  *Cost if wrong:* a second export path in `common`.
- **Ruling: the files.** All live in `~/.agentmesh/`:
  - `mesh-window.json`, the policy: version, agent, token, own-branch prefix, integration branch,
    test commands;
  - `mesh-window.settings.json`;
  - the launcher, `mesh-window.cmd` on Windows and `mesh-window` (no extension, mode 700)
    elsewhere;
  - an empty folder, `empty-git-hooks/`.

  The spec said `.sh`. Without the extension, the spec's own daily line `~/.agentmesh/mesh-window`
  works on macOS and Linux. *Cost if wrong:* doc wording only.
- **Ruling: the marker.** It is `AGENTMESH_MESH_WINDOW=<32 hex>`, set both by the launcher script
  and by the settings file's `env`.
  - The guard is on whenever the variable is non-empty.
  - The plugin reports `meshWindow` only when the value equals the policy's token **and** the
    policy's agent is the plugin's agent.

  *Cost if wrong:* a repo that sets the variable turns the guard on in a private session. That is
  visible and harmless (its edits are refused).
- **Ruling: one mesh window per laptop user**, keyed by `~/.agentmesh` like `agent.json`. A second
  Claude account (a test agent) can't run its own window at the same time. *Cost:* Pratik's live
  test uses one window plus private sessions.
- **Ruling: re-running `window init` keeps a valid token**, so a running window stays verified
  until it restarts.
- **Ruling: migration 007 is `mesh_window` only.** Plan 3 takes 008 for its relay columns (spec §5
  had put both in 007).
- **Ruling: routing order** is owner chain → sender's pick → mesh window → repo → longest-active.
  - The mesh-window rule takes the longest-active of the ready windows, with reason `mesh window`.
  - A fall-through after skipping an inactive parent or task owner appends
    `; skipped inactive <id> (<why>)` to its reason (§13, parked from plan 1).
- **Ruling: one edit allow rule,** `Edit(**/.claude/worktrees/mesh-*/**)`. permissions.md says
  `Write(...)` path rules never match and `Edit(...)` rules cover Write and NotebookEdit.
- **Ruling: the guard never returns `allow`.** It denies (exit 2), asks, or stays silent. The
  settings allow rules do the approving, so both layers must agree before anything runs unprompted.
- **Ruling: the Bash list** (what the guard leaves to the normal permission flow):
  - `pwd`;
  - `ls`, `git diff`, `git log` and `git show`, each with safe tokens and never `--output`;
  - `git status`, `git worktree list` and `git fetch origin`, exactly;
  - `cd <path>`;
  - two `git worktree add` forms: `-b <own prefix>… origin/<integration branch>`, or a detached
    `origin/<ref>`;
  - `git worktree remove .claude/worktrees/mesh-<slug>`;
  - a configured test command, bare or as `cd <path> && <test>`, in an own-branch mesh worktree;
  - **(controller ruling, 2026-11-02)** the task's own delivery steps, bare or as `cd <path> && …`,
    and only in a mesh worktree whose branch starts with the own-branch prefix:
    - `git add -A`, or `git add -- <paths>`;
    - `git commit -m '<text>'` (one or more single-quoted `-m`, with no `'` inside);
    - `git push origin <branch>` or `git push -u origin <branch>`, where `<branch>` equals that
      worktree's own branch exactly;
    - `gh pr create --base <integration branch> --head <that branch>`, followed only by
      single-quoted `--title` and `--body`.

    Never `--force`, `--amend`, `--no-verify`, or a refspec with `:` or `+`. `gh pr merge` and
    everything else still ask.
    - *Why:* Pratik's decision 3 ("routine work runs without asking") and the design's task flow
      (code, commit, push, open the PR, `task_act(submit)`). Without these, every task stops at a
      prompt.
    - *Cost if wrong:* a compromised window could push and open PRs from its own branches. Branch
      protection still gates every merge.

  Everything else asks. *Cost:* reading a diff never prompts (decision 5). Other read-only commands
  (`cat`, `grep`, `find`) prompt, so the rules send Claude to Read, Grep and Glob.
- **Ruling: PowerShell and Monitor commands always ask in the mesh window.** `EnterWorktree` is
  denied: it would load a reviewed branch's project settings and hooks. *Cost:* a Windows teammate
  without Git Bash is prompted for routine git and tests.
- **Ruling: what an own branch is.**
  - The prefix is the team's branch template with `{owner}` and `{agent}` filled in, cut at the
    first other placeholder: `agent/{owner}/{task}-{slug}` gives `agent/pratik/`.
  - If the prefix names neither the owner nor the agent, it is `null`, and every test asks.
  - `-b` must branch from `origin/<integration branch>`, so a foreign branch can never be checked
    out under an own-branch name.
- **Ruling: where a test runs.**
  - `cd <path> && <test>` names its folder.
  - A bare `<test>` uses the hook input's `cwd`.
  - A run the guard can't place in a registered mesh worktree asks. That stays safe even if the
    hook's `cwd` doesn't follow the shell.
- **Ruling: the guard's liveness stamp.**
  - On the `activate` tool call, the guard writes `guard-alive.json` in the plugin data folder.
  - `activate` in a marked session requires a stamp written in the last 2 minutes.
  - It is one file, not keyed per process.
- **Ruling: the review-wait reply uses status `working`.**
  - It is a status item (`sendClass` in `apps/hub/src/modules/messaging/send.handlers.ts`), so it
    rides along on the author's agent's next tool result and never starts a turn. The author's agent
    has nothing to do, and the verdict still arrives as `review_submit`.
  - Not `needs_human`: that is an action. It would interrupt the author's agent, and the human who
    must act is the reviewer's, not the recipient's.
  - Not `info`: `working` says the review is in progress, which is the truth.
- **Ruling: layered settings are accepted and documented,** not cut with `--setting-sources`.
  - The guard's deny and ask outrank every allow rule and mode (permissions.md, "Precedence among
    rules, hooks, and mods").
  - Restricting the sources would drop the user settings that enable the plugin, and the repos'
    `CLAUDE.md` files.
  - *Cost:* the human's own allow rules for other tools (other MCP servers, WebFetch) apply in the
    window. The fallback is one flag in the launcher.
- **Ruling: finding a checkout.**
  - In the mesh window, `task_get` adds a `checkout:` line. It reads `.git/config` in the folder and
    its direct subfolders, with no git spawn.
  - It matches the task's `owner/name` against `origin`, ignoring case and `.git`. Exactly one
    match must be found, or the line says to ask.
  - Tasks carry no host, so the host isn't compared.
- **Ruling: `window init` checks only `.gitignore`.** It warns per checkout that doesn't ignore
  `.claude/worktrees/`, and prints one fixed reminder about test, typecheck and lint excludes.
  Parsing every tool's config is out of reach. *Cost:* a repo whose test runner walks into the
  worktrees isn't named.
- **Ruling: `claude`'s absolute path comes from a PATH walk** in the CLI: absolute entries only,
  with PATHEXT on Windows. `where claude` searches the current folder first.
- **Ruling: launcher input.**
  - The `.cmd` refuses `% ^ & " ! < > |` in the paths it bakes in, and quotes the runtime folder
    (`cd /d "%~1"`).
  - The POSIX script single-quotes the baked paths and refuses `'`.
  - The session name is `mesh-<agent>`, cut to 64 characters.
- **Ruling: the session-start hint.**
  - It goes in `systemMessage`. hooks.md's JSON-output table defines it as "Warning message shown
    to the user", and the SessionStart section doesn't discard it.
  - It shows only on an enrolled laptop: `~/.agentmesh/agent.json` exists, or
    `CLAUDE_PLUGIN_OPTION_AGENT_ID` is set (plugins-reference.md says options are exported to hook
    processes).
- **Ruling: the heartbeat.**
  - The pull watcher's 30 s tick writes `push-<prefix>-<agent>-<session>.json` while the session is
    active, push, and not waiting for a re-check.
  - No startup prune in plan 2: readers ignore files older than 2 minutes. Plan 3 adds the prune
    with its own state files.
- **Ruling: the macOS/Linux sandbox alternative is deferred** (decision 5 says it "can" stand in).
  - It can't be tested on this Windows box, and a wrong sandbox config would run foreign tests
    unprompted.
  - The prompt applies on every OS. *Cost:* macOS and Linux teammates get a prompt the sandbox could
    have replaced.
- **Ruling: the settings file also sets `permissions.disableAutoMode: "disable"`** and
  `defaultMode: "default"`, because the spec says no auto or bypass mode.
- **Ruling: the guard is a plugin hook, so it runs in every session.**
  - Outside the window it reads stdin, capped at 1 s, and exits 0 at once.
  - It is wrapped so that nothing outside the window can make it exit non-zero, because
    `onFailure: "block"` would then block that session's edits.
  - *Cost:* about 50 ms of `node` start per edit or shell call in every session.

## Claude Code behaviour this plan relies on

Verified from the docs (code.claude.com/docs/en/*.md, fetched 2026-11-02):
- **permissions.md**
  - Rules: an `Edit(...)` rule covers all file-editing tools, and `Write(...)`/`NotebookEdit(...)`
    path rules never match.
  - Path patterns: `//abs`, `~/`, `/` (settings source), relative (cwd).
  - A hook ask or block outranks allow rules and modes ("Precedence among rules, hooks, and mods").
    Exit 2 stops a call before rules are evaluated.
  - Built-in read-only commands include `ls`, `cd`, `pwd` and read-only `git`. A compound with `cd`
    plus `git` into another folder prompts.
  - `disableBypassPermissionsMode` and `disableAutoMode` take `"disable"`.
  - Mods can override hooks in some auth setups; this goes in the threat note.
- **permission-modes.md:** `.claude` is protected, except "Claude's own git worktrees under
  `.claude/worktrees/`". A file passed to `--settings` is protected. Allow rules never pre-approve
  protected writes.
- **hooks.md**
  - Matchers: letters, digits, `_` and `|` only means an exact list.
  - Exit 2 blocks with stderr as the reason. `permissionDecision` is allow, deny, ask or defer.
  - `onFailure: "block"` needs v2.1.295. A timed-out PreToolUse hook doesn't block without it.
  - SessionStart `source` is startup, resume, clear, compact or fork.
  - `tool_input.file_path` is absolute. Bash and PowerShell carry `tool_input.command`.
  - `systemMessage` is "shown to the user".
  - CwdChanged's example shows `cwd` following `cd`.
- **settings.md / settings-reference.md:** `--settings` sits above local, project and user
  settings. Lists merge. A settings `env` overrides the shell. `disableAllHooks` exists.
- **cli-reference.md:** `claude "query"`, `-n`, `--permission-mode`, `--settings`, and
  `--dangerously-load-development-channels` (it prompts, and is ignored with `-p`).
  `--setting-sources` exists. `--continue` mentions sessions "whose first prompt was `/loop`",
  which is evidence that a slash command works as the initial prompt.
- **plugins-reference.md:** `CLAUDE_PLUGIN_DATA`. `CLAUDE_PLUGIN_OPTION_<KEY>` is exported to
  hooks.
- **tools-reference.md:** Monitor uses Bash's permission rules. There is no MultiEdit tool today.
  The PowerShell hook input matches Bash's. `EnterWorktree` exists.
- **worktrees.md:** `claude --worktree` uses `<repo>/.claude/worktrees/<name>`, and the docs
  recommend `.claude/worktrees/` in `.gitignore`. `EnterWorktree` moves the session's project
  settings.

Not verifiable from the docs. Each is a live check in its owning task, gathered for Pratik in
Task 12, with a fallback:
- a slash command as the launcher's initial prompt (Task 4);
- the hint reaching the human (Task 6);
- the hook's `cwd` following `cd` (Task 8);
- the edit rule and the `.claude/` exemption on Windows (Task 4);
- `NoDefaultCurrentDirectoryInExePath` covering the hook's `node` (Task 4);
- the PowerShell form of the daily command (Task 4).

## Global Constraints

- **Size and checks.** No source or test file over 300 lines (`pnpm check:size`). `pnpm check` must
  pass after every task. `sessions.service.ts` is at 288/300: add at most 4 lines to it.
- **Built-ins only.** These import only `node:*`, each other, and type-only imports:
  - `packages/common/src/window.ts`;
  - `plugins/agentmesh/src/hook.ts`, `src/guard.ts`, `src/guard/**`;
  - `src/window/{rules,heartbeat,session-start,guard-stamp}.ts`;
  - `src/pull/state.ts`.
- **Environment.** Only the entry and composition points read `process.env`: `main.ts`,
  `session.ts` (`openSession`), `hook.ts` and `guard.ts`. Every new function takes `env` as a
  parameter.
- **No new spawns.** The plugin's new code never spawns `git` or `claude`; it reads git's files.
- **Logic placement.** Routing, the guard's classifiers and the renderers are pure, with unit tests.
  Modules talk only through services and late-bound readers.
- **Root-cause fixes, failing test first** for every security-relevant change (CLAUDE.md).
- **Protocol fields are additive:** `.optional()` on params, `.default(...)` on results.
- **Copy.** Strings in quotes in this plan are exact copy, and tests pin them.
- **Version bump and dist rebuild only in Task 12.**
  - The bump touches `packages/common/src/version.ts`, the 9 workspace `package.json` files and
    `plugins/agentmesh/.claude-plugin/plugin.json`: 0.4.4 becomes 0.5.0.
  - Rebuild with `pnpm --filter @agentmesh/plugin build`.
- **Windows dev box.** `python3` is a stub, so use node. Edit files with the editor tools, not bash
  heredocs. Tests that check file modes run only off Windows, like the existing ones.
- **Integration tests skip silently without nats-server.** To run them:
  1. Start `C:\Users\USER\AppData\Local\Temp\claude\G--Projects-AgentMesh\01d905da-504d-4369-91a5-bb8bb09a37e4\scratchpad\nats-bin\nats-server-v2.15.1-windows-amd64\nats-server.exe -js -p 4333 -sd <scratch dir>`.
  2. Run with `AGENTMESH_TEST_NATS_BIN=<that exe>` and `AGENTMESH_TEST_NATS=nats://127.0.0.1:4333`.
- **Commits.** End every commit message with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Windows spellings of a legitimate worktree path:** lowercase drive, forward slashes, mixed
   case. The edit must still pass, and a junction out of the worktree must still be refused. Tests
   in Task 7.
2. **A checkout path with spaces** (`C:/Users/John Smith/opzami/web`): edits pass, and
   `cd "<path>" && pnpm check` is recognized. Tests in Tasks 7 and 8.
3. **Re-running `/agentmesh:window` while the window runs:** the token is kept, so the running
   window stays verified. Test in Task 4.
4. **A Write call whose content is several MB:** the guard reads all of it and decides, with no
   truncation and no hang. Test in Task 9.
5. **The mesh window started inside a repo checkout** (its repo equals the task's) **next to another
   session in that repo:** the window still wins. Test in Task 2.

---

### Task 1: The mesh window's files, in one shared module

**Files:**
- Create: `packages/common/src/window.ts`
- Create: `packages/common/src/window.test.ts`
- Modify: `packages/common/package.json` (`exports` gains `"./window": "./src/window.ts"`)

**Interfaces:**
- **Produces** (`@agentmesh/common/window`, built-ins only):
  - **Constants:**
    - `MESH_WINDOW_ENV = 'AGENTMESH_MESH_WINDOW'`
    - `MESH_WINDOW_HINT_ENV = 'AGENTMESH_MESH_WINDOW_HINT'`
    - `CHANNEL_FLAG = '--dangerously-load-development-channels plugin:agentmesh@agentmesh'`
    - `` RESTART = `claude ${CHANNEL_FLAG}` ``
    - `LAUNCH_PROMPT: string | null = '/agentmesh:activate mesh window'`
    - `LAUNCHER_DISPLAY = '~/.agentmesh/mesh-window'`
  - `interface WindowFiles { dir: string; policy: string; settings: string; launcher: string; emptyHooks: string }`.
    `windowFiles(home: string, platform: NodeJS.Platform): WindowFiles` joins `home/.agentmesh/`
    with `mesh-window.json`, `mesh-window.settings.json`, `mesh-window.cmd` (win32) or
    `mesh-window` (elsewhere), and `empty-git-hooks`.
  - `interface WindowPolicy { version: 1; agentId: string; token: string; ownBranchPrefix: string | null; integrationBranch: string; testCommands: string[] }`.
  - `TOKEN_PATTERN = /^[0-9a-f]{32}$/`.
  - `isBranchName(v: string): boolean`: matches `/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/` and has no
    `..`.
  - `isTestCommand(v: string): boolean`: matches `/^[A-Za-z0-9][A-Za-z0-9 ._:/=@-]{0,199}$/`, with
    no double space and no trailing space.
  - `parseWindowPolicy(text: string): WindowPolicy | null`. It returns null unless every field is
    valid: `agentId` is the participant pattern (copied); the token, prefix (null or a branch name),
    integration branch and 0–10 test commands all pass their checks.
  - `ownBranchPrefix(template: string, owner: string, agent: string): string | null`.
  - `type MarkerState = 'none' | 'marked' | 'verified'`.
  - `readMarker(env, home, platform, agentId?: string): { state: MarkerState; policy: WindowPolicy | null }`.
    - `none` when the variable is empty.
    - `verified` when it equals the policy's token (and, if `agentId` is given, the policy's
      agent).
    - `marked` otherwise.
    - `policy` is non-null only when the state is `verified`. A missing or unreadable file never
      throws.

- [ ] **Step 1: Baseline.** Run `pnpm install`, then `pnpm check`. Expected: PASS. Record the test
  count.
- [ ] **Step 2: Write the failing tests** (`window.test.ts`).
  - `it('renders the own-branch prefix from the branch template')`:
    - `ownBranchPrefix('agent/{owner}/{task}-{slug}', 'pratik', 'pratik-agent')` is `'agent/pratik/'`;
    - `('agent/{agent}/{task}', 'pratik', 'pratik-agent')` is `'agent/pratik-agent/'`;
    - `('agent/{owner}-{slug}', 'pratik', 'pratik-agent')` is `'agent/pratik-'`;
    - `('{task}-{slug}', 'pratik', 'pratik-agent')` is `null`.
  - `it('parses a valid policy and refuses every malformed one')`:
    - a valid object round-trips through `JSON.stringify`;
    - `null` for each of: a bad token (`'XYZ'`), agent `'Bob'`, prefix `'../x'`, test command
      `'pnpm test; rm -rf ~'`, 11 test commands, `version: 2`, and non-JSON text.
  - `it('reads the marker: none, marked or verified')`, using a temp home with a policy file:
    - `{}` gives `none`;
    - the right token gives `verified` with the policy;
    - the wrong token gives `marked` with a null policy;
    - the right token with `agentId: 'other-agent'` gives `marked`;
    - the right token with no file gives `marked`.
  - `it('names the launcher by platform')`: `windowFiles('/h', 'win32').launcher` ends with
    `mesh-window.cmd`, and `windowFiles('/h', 'linux').launcher` ends with
    `join('.agentmesh', 'mesh-window')`.
- [ ] **Step 3: Run** `pnpm vitest run packages/common`. Expected: FAIL (module missing).
- [ ] **Step 4: Implement** `window.ts` and the export. `readMarker` uses `readFileSync` in a
  try/catch.
- [ ] **Step 5: Run** `pnpm check`. Expected: PASS.
- [ ] **Step 6: Commit** `"Common: the mesh window's files, policy and marker"`.

---

### Task 2: The hub knows the mesh window and routes team work to it

**Files:**
- Modify: `packages/protocol/src/rpc/session.ts` (`session.hello` params)
- Modify: `packages/protocol/src/primitives.ts` (`SessionSummary`)
- Create: `apps/hub/src/db/migrations/007-mesh-window.ts`
- Modify: `apps/hub/src/db/migrate.ts`, `apps/hub/src/db/migrate.test.ts`
- Modify: `apps/hub/src/modules/sessions/sessions.repo.ts` (`SessionRow`, `NewSession`, `insert`)
- Modify: `apps/hub/src/sessions.contracts.ts` (`open` input)
- Modify: `apps/hub/src/modules/sessions/sessions.service.ts` (`open` passes the flag, ≤4 lines)
- Modify: `apps/hub/src/modules/sessions/mappers.ts` (`toRouteSession`, `toSummary`)
- Modify: `apps/hub/src/modules/sessions/routing.ts`
- Modify: `apps/hub/src/modules/sessions/handlers.ts` (the `session hello` log gains `meshWindow`)
- Create: `apps/hub/src/modules/sessions/mesh-window.test.ts`
- Test: `apps/hub/src/modules/sessions/routing.test.ts`, `packages/protocol/src/rpc/caps.test.ts`

**Interfaces:**
- **Produces:**
  - **Hello params:** `meshWindow: z.boolean().optional()`, doc comment "Started by the mesh window
    launcher (AGENTMESH_MESH_WINDOW matched): routing prefers it for team work."
  - **`SessionSummary`** gains `meshWindow: z.boolean().default(false)`.
  - **Migration:** `MIGRATION_007 = "ALTER TABLE sessions ADD COLUMN mesh_window INTEGER NOT NULL DEFAULT 0 CHECK (mesh_window IN (0, 1));"`.
  - **Repo and service:** `SessionRow.mesh_window: number`. `NewSession.meshWindow?: boolean`.
    `SessionsService.open(agentId, input: { …; meshWindow?: boolean })`, stored at insert only (a
    process keeps its marker).
  - **Routing:**
    - `RouteSession.meshWindow: boolean`.
    - `routeDelivery` order: chain owner, pick, the longest-active ready `meshWindow` session
      (`claim: true`, reason `'mesh window'`), repo, longest-active.
    - When the owner chain skipped an inactive parent or task owner, every fall-through reason ends
      with `` `; skipped inactive ${id} (${why})` ``.

- [ ] **Step 1: Write the failing tests**
  - `routing.test.ts`. The `s()` helper defaults `meshWindow: false`; `w = s({ id: 's2', meshWindow: true, activatedAt: '2026-10-21T10:00:00Z' })`.
    - `it('prefers a ready mesh window over a session activated earlier')`:
      `input({ sessions: [s1, w] })` gives
      `{ kind: 'deliver', sessionId: 's2', claim: true, reason: 'mesh window' }`.
    - `it('prefers the mesh window over a session in the task repo')`: `s1` has repo `'acme/web'`,
      the input repo is `'acme/web'`, and `w` has repo `null`, then `'acme/web'`. Both give
      `'mesh window'` to `s2`. (Review Focus 5.)
    - `it('skips a mesh window that is away or pull')`: gives `s1`, `'longest-active session'`.
    - `it('a sender pick and a thread owner still win over the mesh window')`: `picked: 's1'` gives
      `'picked by sender'`, and `threadOwner: 's1'` gives `'owns thread'`.
    - `it('names the inactive chain owner it skipped')`, with `parentOwner` set to an inactive
      `s1`:
      - with `[s1i, s2]`, the reason is `'longest-active session; skipped inactive s1 (owns parent thread)'`;
      - with `[s1i, w]`, it is `'mesh window; skipped inactive s1 (owns parent thread)'`;
      - with `taskOwner` set and `[s1i]` only, it is
        `{ kind: 'wait', reason: 'no active push session; skipped inactive s1 (owns task)' }`.
    - Change on purpose: plan 1's `'an inactive parent owner does not hold the work'` and
      `'an inactive task owner does not hold the work'` now expect the skipped suffix.
  - `mesh-window.test.ts` (`createBobDispatchHarness`). `win()` opens with
    `{ clientVersion: '0.5.0', meshWindow: true }` and activates.
    - `it('keeps the flag from hello and shows it in the active sessions')`: after `active()` and
      `win()`, `sessions.activeSessions('bob-agent').map((s) => s.meshWindow)` equals
      `[false, true]`.
    - `it("routes a teammate's ask to the mesh window, not the session activated first")`: with
      `a = active()`, then `w = win()`, `sessions.route('bob-agent', ask(thread()))` equals
      `{ kind: 'deliver', sessionId: w, claim: true, reason: 'mesh window' }`.
  - `caps.test.ts`: the hello params accept `{ ...ok, meshWindow: true }` and refuse
    `{ ...ok, meshWindow: 'yes' }`.
  - `migrate.test.ts`, changed on purpose:
    - the v2 upgrade applies `5` migrations;
    - the 005 test applies `3`;
    - and `SELECT id, mesh_window FROM sessions` gives `[{ id: 's-aaaaaaaaaaaa', mesh_window: 0 }]`.
- [ ] **Step 2: Run** `pnpm vitest run apps/hub/src/modules/sessions apps/hub/src/db packages/protocol`.
  Expected: FAIL.
- [ ] **Step 3: Implement.** In `routing.ts`, find the skipped owner in one pure helper beside
  `chainOwner` (the first claim-chain owner that is listed but inactive), and apply the suffix in
  one place.
- [ ] **Step 4: Run** `pnpm check`. Expected: PASS, with `sessions.service.ts` ≤300 lines.
- [ ] **Step 5: Commit** `"Hub: sessions report the mesh window, and routing prefers it over the repo rule"`.

---

### Task 3: The plugin's mesh window session: hello flag, activation, instructions

**Files:**
- Create: `plugins/agentmesh/src/window/context.ts`
- Create: `plugins/agentmesh/src/window/rules.ts`, `plugins/agentmesh/src/window/rules.test.ts`
- Create: `plugins/agentmesh/src/tools/window.test.ts`
- Modify: `plugins/agentmesh/src/session.ts` (`Session.window`; the hello param in `register`)
- Modify: `plugins/agentmesh/src/main.ts` (`toolDeps`, instructions input)
- Modify: `plugins/agentmesh/src/tools/types.ts` (`ToolDeps.window`), `plugins/agentmesh/src/tools/fake-hub.ts`
- Modify: `plugins/agentmesh/src/tools/sessions.ts` (`activate`; `RESTART` now from `@agentmesh/common/window`)
- Modify: `plugins/agentmesh/src/instructions.ts`, `plugins/agentmesh/src/instructions.test.ts`
- Modify: `plugins/agentmesh/src/tools/format.ts`, `plugins/agentmesh/src/tools/format.test.ts`
- Modify: `plugins/agentmesh/skills/activate/SKILL.md`

**Interfaces:**
- **Consumes:** Task 1 (`readMarker`, `WindowPolicy`, `RESTART`) and Task 2 (the hello
  `meshWindow`, `SessionSummary.meshWindow`).
- **Produces:**
  - `interface MeshWindowContext { state: MarkerState; policy: WindowPolicy | null; dataDir: string; folder: string }`.
    `NO_WINDOW` has state `none`, a null policy, and `dataDir` and `folder` set to `'.'`.
    `meshWindowContext(env, home, platform, folder, agentId): MeshWindowContext`, where `dataDir`
    is `pullStateDirs(env, home)[0]`.
  - `Session.window` and `ToolDeps.window`. `fakeHub` defaults to `NO_WINDOW`.
  - Hello sends `meshWindow: true` only when the state is `verified`.
  - `windowRules(policy: WindowPolicy | null): string` (built-ins only; Tasks 6 and 10 use it).
  - `InstructionsInput.meshWindow?: boolean`.

- [ ] **Step 1: Write the failing tests**
  - `rules.test.ts`: `it('gives the mesh window its rules')`. `windowRules(policy)` contains each
    of these lines, with `bob-agent` and `agents` filled in:
    - `"AgentMesh: this session is bob-agent's mesh window. It takes the team's work: tasks, reviews and teammates' questions."`
    - `"- One task at a time, in order. Answer teammates' questions between steps."`
    - `"- Every piece of work gets its own worktree in the repo's checkout under this folder: cd to the checkout, run git fetch origin, then git worktree add .claude/worktrees/mesh-<task>-<slug> -b <suggested branch> origin/agents. Edits anywhere else are refused."`
    - `"- Never clone a repo. If its checkout isn't in this folder, ask your human for the path."`
    - `"- Remove a worktree with git worktree remove .claude/worktrees/mesh-<name> once its PR is merged."`
    - `"- Commits, pushes and PRs ask your human; that is expected. Escalate before anything risky."`
    - `"- Never activate with pull: true here. If the test message doesn't arrive, call activate again."`

    With a `null` policy it says `"your agent's mesh window"` and `origin/<integration branch>`.
  - `tools/window.test.ts`, using `fakeHub` with `deps.window` set:
    - `it('activating an ordinary session warns that team work will come here')`: unmarked, code
      plus `description: 'web client'`. The text is exactly
      `'This session is active on the mesh as “web client”. ' + NOT_WINDOW`, where
      `NOT_WINDOW = "This isn't your mesh window; team work will come here while no mesh window is running. Your human can turn it off with /agentmesh:deactivate and set up a mesh window with /agentmesh:window."`.
      A pull activation also ends with `NOT_WINDOW`.
    - `it('the mesh window never activates pull-only')`: verified, `{ pull: true, description: 'x' }`.
      The result has `isError`, the text equals `PULL_REFUSED`, and no hub call is made.
      `PULL_REFUSED = "This is your mesh window: it never runs pull-only. Call activate again with no arguments to send a new test message; if none arrives, the window was started without the channel flag, so tell your human to restart it with ~/.agentmesh/mesh-window."`.
    - `it('a marker that does not match the launcher refuses')`: state `marked`. The result has
      `isError`, the text equals
      `"AGENTMESH_MESH_WINDOW is set, but it doesn't match ~/.agentmesh/mesh-window.json for alice-agent, so this session can't be your mesh window. Start it with ~/.agentmesh/mesh-window, or run /agentmesh:window again."`,
      and no hub call is made.
    - `it('the mesh window activates and repeats its rules')`: verified, a code and
      `description: 'mesh window'`. The text equals
      `` `This session is active on the mesh as “mesh window”. It is your mesh window.\n\n${windowRules(policy)}` ``.
  - `instructions.test.ts`, changed on purpose:
    - the second paragraph is now
      `"This session receives mesh messages only after your human runs /agentmesh:activate. Team work belongs in your mesh window (/agentmesh:window sets one up); until then the tools still work and answers wait for this session."`;
    - with `meshWindow: true` it is
      `"This session is your mesh window: after your human runs /agentmesh:activate it takes your team's work. Its rules arrive at session start and with activation; never activate it pull-only."`;
    - the unread line is
      `"2 mesh thread(s) have unread messages; your mesh window takes team work, and this session reads only its own threads."`,
      or for the window `"2 mesh thread(s) have unread messages; call inbox once this session is active."`;
    - all stay ≤4096.
  - `format.test.ts`: a session summary with `meshWindow: true` and description `'mesh window'`
    renders `'    · s-aaaaaaaaaaaa — mesh window [mesh window]'`.
- [ ] **Step 2: Run** `pnpm vitest run plugins/agentmesh/src`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The marker checks in `activate` run before any hub call.
  - `RESTART` moves to the common module. `sessions.ts` keeps its current texts otherwise.
  - The activate skill gains one line: "In your mesh window, never use `pull: true`: if no test
    message arrives, call `activate` again with no arguments, and if it still doesn't arrive, tell
    the user to restart the window with `~/.agentmesh/mesh-window`."
- [ ] **Step 4: Run** `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `"Plugin: the mesh window reports itself, refuses pull and repeats its rules; other sessions warn"`.

---

### Task 4: `agentmesh window init` writes the launcher and its settings

**Files:**
- Create: `apps/cli/src/commands/window.ts`, `apps/cli/src/commands/window.test.ts`
- Create: `apps/cli/src/render/window.ts`, `apps/cli/src/render/window.test.ts`
- Create: `apps/cli/src/lib/path-lookup.ts`, `apps/cli/src/lib/path-lookup.test.ts`
- Modify: `apps/cli/src/main.ts` (`COMMANDS` gains `windowInitCommand`)
- Modify: `.gitignore` (adds `.claude/worktrees/` under a comment line)

**Interfaces:**
- **Consumes:** Task 1 (`windowFiles`, `WindowPolicy`, `parseWindowPolicy`, `ownBranchPrefix`,
  `isBranchName`, `isTestCommand`, `CHANNEL_FLAG`, `LAUNCH_PROMPT`, `LAUNCHER_DISPLAY`,
  `TOKEN_PATTERN`).
- **Produces:**
  - `findOnPath(name: string, env: Record<string, string | undefined>, platform: NodeJS.Platform, isFile: (p: string) => boolean): string | null`.
    It skips relative PATH entries. On win32 it tries the PATHEXT extensions in order (default
    `.COM;.EXE;.BAT;.CMD`). It never looks in the current folder.
  - `interface WindowInputs { agentId: string; claude: string; files: WindowFiles; token: string; testCommands: string[] }`.
  - `windowSettings(i: WindowInputs): Record<string, unknown>`, exactly this shape:

    ```json
    {
      "env": {
        "AGENTMESH_MESH_WINDOW": "<token>",
        "GIT_CONFIG_COUNT": "3",
        "GIT_CONFIG_KEY_0": "core.hooksPath", "GIT_CONFIG_VALUE_0": "<files.emptyHooks>",
        "GIT_CONFIG_KEY_1": "core.fsmonitor", "GIT_CONFIG_VALUE_1": "false",
        "GIT_CONFIG_KEY_2": "safe.bareRepository", "GIT_CONFIG_VALUE_2": "explicit"
      },
      "disableAllHooks": false,
      "permissions": {
        "defaultMode": "default",
        "disableBypassPermissionsMode": "disable",
        "disableAutoMode": "disable",
        "allow": [
          "Edit(**/.claude/worktrees/mesh-*/**)",
          "Bash(git status)",
          "Bash(git fetch origin)",
          "Bash(git worktree add .claude/worktrees/mesh-*)",
          "Bash(git worktree remove .claude/worktrees/mesh-*)",
          "Bash(<each test command>)",
          "Bash(git add *)",
          "Bash(git commit -m *)",
          "Bash(git push origin <own branch prefix>*)",
          "Bash(git push -u origin <own branch prefix>*)",
          "Bash(gh pr create --base <integration branch> *)"
        ]
      }
    }
    ```

  - `launcherScript(i: WindowInputs, platform: NodeJS.Platform): string`.
    - **win32**, CRLF, lines:
      1. `@echo off`
      2. `setlocal`
      3. `set "NoDefaultCurrentDirectoryInExePath=1"`
      4. `set "AGENTMESH_MESH_WINDOW=<token>"`
      5. `if not "%~1"=="" cd /d "%~1" || exit /b 1`
      6. `call "<claude>" <CHANNEL_FLAG> -n "<name>" --permission-mode default --settings "<settings>" "<LAUNCH_PROMPT>"`
         — `call` is required (controller ruling, Task 4 review): without it, an npm-installed `claude.cmd`
         shim ends the launcher's `setlocal` context before node starts, losing the `cd`,
         `NoDefaultCurrentDirectoryInExePath` and the marker. `bakeable` already refuses `%` and `^`, so
         `call`'s second expansion is safe.
    - **Elsewhere**, LF, lines:
      1. `#!/bin/sh`
      2. `export AGENTMESH_MESH_WINDOW='<token>'`
      3. `if [ -n "$1" ]; then cd -- "$1" || exit 1; fi`
      4. `exec '<claude>' <CHANNEL_FLAG> -n '<name>' --permission-mode default --settings '<settings>' '<LAUNCH_PROMPT>'`
    - When `LAUNCH_PROMPT` is null, the last argument is left out.
  - `bakeable(path: string, platform: NodeJS.Platform): boolean`. On win32 it is false if the path
    contains any of `% ^ & " ! < > |`; elsewhere, if it contains `'`. It is false anywhere for a
    newline.
  - `` sessionName(agentId: string): string `` returns `` `mesh-${agentId}`.slice(0, 64) ``.
  - `windowInitCommand`, named `'window init'`, with these flags:
    - `--agent` (required);
    - `--owner` (default: the agent);
    - `--branch-template` (default `agent/{owner}/{task}-{slug}`);
    - `--integration-branch` (default `agents`);
    - `--test` (repeatable);
    - `--dir` (default the current folder).

    It validates every flag, finds `claude` with `findOnPath`, and writes the policy and settings
    files (mode 600), the launcher (mode 700) and `empty-git-hooks/` (mode 700). It keeps the token
    of a valid existing policy, otherwise it makes a new one with `randomBytes(16)`. It exits 0, or
    2 on a usage error, or 1 when `claude` isn't on PATH.
- **Output lines** (exact), in this order:
  1. `Wrote your mesh window for <agent>: <launcher>, <settings> and <policy>.`
  2. `Start it each day in your team's folder: ~/.agentmesh/mesh-window "<dir>"`
  3. Only on a re-run that kept the token:
     `A mesh window that is already running keeps working; restart it to load the new settings.`
  4. Only for a null prefix:
     `Warning: the branch template names neither the owner nor the agent, so the window can't tell its own branches: every test run will ask.`
  5. For each checkout (the folder or a direct subfolder with a `.git` entry) whose `.gitignore` has
     no line `.claude/worktrees/`, `.claude/worktrees`, `.claude/` or `.claude`:
     `Warning: <checkout> doesn't ignore .claude/worktrees/; add it to .gitignore so the window's worktrees don't show up as untracked files.`
  6. Always, last:
     `Check that each repo's test runner, typechecker and linter skip .claude/worktrees/ (vitest's default include does not).`

- [ ] **Step 1: Write the failing tests**
  - `path-lookup.test.ts`, with a stub `isFile` and an explicit platform:
    - `it('finds claude on PATH and never in the current folder')`: for win32,
      `PATH='.;relative;C:\\bin'` with only `C:\\bin\\claude.cmd` existing gives
      `join('C:\\bin', 'claude.cmd')`.
    - `.exe` wins over `.cmd` when both exist.
    - for linux, `PATH='/usr/bin:/opt/x'` gives `'/opt/x/claude'`.
    - nothing found gives `null`.
  - `render/window.test.ts`:
    - `windowSettings` deep-equals the shape above for `home='/home/bob'`,
      token `'0123456789abcdef0123456789abcdef'` and `['pnpm check']`;
    - `launcherScript` equals the exact win32 and linux texts above;
    - `bakeable('C:/Users/R&D/.agentmesh/x', 'win32')`, `'C:/a%b'`, `'C:/a"b'` and
      `('/home/o\'b', 'linux')` are each `false`;
    - `sessionName('a'.repeat(63)).length` is `64`.
  - `commands/window.test.ts`, with a temp home, a temp bin holding `claude` (or `claude.cmd` on
    win32) on `ctx.env.PATH`, and `ctx.platform = process.platform`:
    - `it('writes the launcher, its settings and the policy')`: exit `0`.
      `parseWindowPolicy(policy)` gives agent `'bob-agent'`, `ownBranchPrefix: 'agent/bob/'`,
      `integrationBranch: 'agents'` and `testCommands: ['pnpm check']`. Off Windows the modes are
      600, 600 and 700.
    - `it('keeps the token when it runs again')` (Review Focus 3): run twice; the token is unchanged
      and line 3 is printed.
    - `it('refuses unsafe input')`: `--agent Bob`, `--test 'pnpm test; rm -rf ~'` and
      `--integration-branch '../main'` each exit `2`, and no file is written.
    - `it('says when claude is not on PATH')`: an empty PATH exits `1` with
      `"error: claude is not on PATH. Install Claude Code first."`.
    - `it('warns about a checkout that does not ignore its worktrees')`: `--dir` holds `web/.git/`
      with no `.gitignore` and `api/.git/` whose `.gitignore` has `.claude/`. Only `web` gets
      line 5.
- [ ] **Step 2: Run** `pnpm vitest run apps/cli`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Use `parseCommandArgs` with `test: { type: 'string', multiple: true }`, and `writeFileAtomic`
    from `lib/files.ts`.
  - Refuse (usage error) when `bakeable` is false for `claude` or the settings path.
  - Add `.claude/worktrees/` to the repo `.gitignore`.
- [ ] **Step 4: Run** `pnpm check`. Expected: PASS.
- [ ] **Step 5: Live checks** (they need an interactive terminal; if you can't run one, write "not
  run" in the commit body and Task 12 hands them to Pratik):
  1. Run the launcher in a scratch folder (`window init --dir <scratch>` with a scratch home is
     fine). Accept the development-channel prompt.
     - Expected: `/agentmesh:activate mesh window` runs as the first prompt.
     - **Fallback:** set `LAUNCH_PROMPT = null` in Task 1's module and add the output line
       `Then type /agentmesh:activate mesh window in the window.`
  2. In that window, have Claude create `.claude/worktrees/mesh-x` with `git worktree add` and edit
     a file there.
     - Expected: no prompt (the allow rule matches on Windows, and the `.claude/` exemption covers
       a git-made worktree).
     - **Fallback:** edits prompt, which is safe; record it in `docs/security.md` and the README.
  3. From PowerShell, `~/.agentmesh/mesh-window C:\scratch` starts the window.
     - **Fallback:** print the `& "<absolute launcher>" "<dir>"` form on win32.
  4. Copy any harmless `.exe` (for example `whoami.exe`) to `<scratch>\node.exe` and start the
     window there.
     - Expected: hooks still run the real node.
     - **Fallback:** record the residual risk in `docs/security.md`.
- [ ] **Step 6: Commit** `"CLI: window init writes the mesh window launcher, its settings and policy"`.

---

### Task 5: `/agentmesh:window`, and every "activate each session" text

**Files:**
- Create: `plugins/agentmesh/skills/window/SKILL.md`
- Create: `plugins/agentmesh/src/window-skill.test.ts`
- Modify: `plugins/agentmesh/src/join/tool.ts` (the joined text), `plugins/agentmesh/src/join/join.test.ts`
- Modify: `plugins/agentmesh/commands/join.md`
- Modify: `plugins/agentmesh/skills/setup/SKILL.md` (the handover after the proof)
- Modify: `apps/cli/src/setup/render/invites.ts`, `apps/cli/src/setup/render/invites.test.ts`

**Interfaces:**
- **Consumes:** the `window init` flags from Task 4.

- [ ] **Step 1: Write the failing tests**
  - `window-skill.test.ts`:
    - the frontmatter has `disable-model-invocation: true` and no `allowed-tools`;
    - every `node "…" …` call in the skill matches
      `/^node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.js" window init /`;
    - the skill contains `Never run the launcher yourself`.
  - `join.test.ts`: the joined text contains `/agentmesh:window` and `~/.agentmesh/mesh-window`.
  - `invites.test.ts`: step 8 is
    ``'8. Run `/agentmesh:window`, then start your mesh window each day with `~/.agentmesh/mesh-window` in your team\'s folder.'``.
    The old `'8. Run `/agentmesh:activate`.'` expectation is replaced on purpose.
- [ ] **Step 2: Run** `pnpm vitest run plugins/agentmesh apps/cli/src/setup`. Expected: FAIL.
- [ ] **Step 3: Write the skill and the texts.**
  - The window skill is user-only, with argument hint `"[team folder]"`.
    1. From this session's AgentMesh instructions, take:
       - the agent (`You are <agent>`);
       - the owner (`working for <owner>`, else the agent);
       - the integration branch and branch template (the `Git:` line).

       If they are missing, the laptop hasn't joined: stop and point to `/agentmesh:join`.
    2. Ask for the team folder (default `$ARGUMENTS`, else the current folder). Recommend the
       folder that holds the team's repos.
    3. Ask for the exact test command lines. Explain that they run without a prompt on the window's
       own branches and with a prompt on everyone else's.
    4. Run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" window init --agent … --owner … --branch-template "…" --integration-branch … --test "…" --dir "<folder>"`,
       and show its output.
    5. Tell the user how to start the window daily in a terminal. They confirm the development
       channel, and it activates itself; if it doesn't, they type
       `/agentmesh:activate mesh window`.
    6. Tell them to deactivate other sessions they had activated, and to turn off any inbox poll
       (Claude Desktop).

    The skill also says: "Never run the launcher yourself, never edit the files it wrote, and never
    add permission rules."
  - **The joined text.** Replace "The mesh tools are live now; call inbox. Restart Claude Code with
    the channel flag later…" with:
    `The mesh tools are live now. Team work goes to a mesh window: offer your human /agentmesh:window to set one up; they then start it each day with ~/.agentmesh/mesh-window in their team's folder. This session stays private unless they activate it.`
    `commands/join.md` gets the same offer after the auto-update question.
  - **The setup skill, after step 7's checklist:** "This session holds the workspace's secrets, so
    it must not take team work. Ask the admin to run `/agentmesh:deactivate` here, then offer
    `/agentmesh:window`, and start the mesh window in the team's folder, not in this workspace."
    `setup-skill.test.ts` must stay green (no new `node` calls).
- [ ] **Step 4: Run** `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `"Plugin: /agentmesh:window, offered after join and setup"`.

---

### Task 6: Session start: the window's rules, and "is anything listening?"

**Files:**
- Create: `plugins/agentmesh/src/window/heartbeat.ts`, `plugins/agentmesh/src/window/heartbeat.test.ts`
- Create: `plugins/agentmesh/src/window/session-start.ts`, `plugins/agentmesh/src/window/session-start.test.ts`
- Modify: `plugins/agentmesh/src/pull/watcher.ts`, `plugins/agentmesh/src/pull/watcher.test.ts`
- Modify: `plugins/agentmesh/src/session.ts` (watcher deps; `recheck` refreshes the watcher)
- Modify: `plugins/agentmesh/src/hook.ts`

**Interfaces:**
- **Consumes:** `windowRules` (Task 3); `readMarker`, `windowFiles` and the env names (Task 1);
  `STATE_MAX_AGE_MS` and `pullStateDirs` (`pull/state.ts`).
- **Produces:**
  - `` heartbeatFile(prefix, agentId, sessionId) = `push-${prefix}-${agentId}-${sessionId}.json` ``.
  - `isHeartbeatFile(name): boolean` is true for `push-*.json`.
  - `interface Heartbeat { agentId: string; sessionId: string; meshWindow: boolean; updatedAt: string }`.
  - `anyFresh(values: readonly unknown[], now: number): boolean` is true when any value has an
    `updatedAt` aged 0 to `STATE_MAX_AGE_MS`.
  - **`PullWatcherDeps`** gains `meshWindow: boolean`.
    - While `!activation.pull && activation.lastDescription !== null && activation.renewedFrom === null && hub.sessionId`,
      `refresh()` writes the heartbeat with no hub call, write-then-rename at mode 600.
    - Otherwise it removes the file.
  - `interface SessionStartInput { source: string | undefined; marked: boolean; policy: WindowPolicy | null; enrolled: boolean; hintOff: boolean; listening: boolean; launcherExists: boolean }`.
  - `sessionStartOutput(i): { additionalContext: string | null; systemMessage: string | null }`.
  - `HINT_START = "No AgentMesh mesh window is running for this account, so teammates' requests will wait. Start it with ~/.agentmesh/mesh-window in your team's folder. (AGENTMESH_MESH_WINDOW_HINT=off in settings.json env hides this line.)"`.
  - `HINT_SETUP = "No AgentMesh mesh window is running for this account, so teammates' requests will wait. Run /agentmesh:window to set one up. (AGENTMESH_MESH_WINDOW_HINT=off in settings.json env hides this line.)"`.
  - **`hook.ts`:**
    - For SessionStart, it prints `{ systemMessage?, hookSpecificOutput: { hookEventName, additionalContext? } }`.
      `additionalContext` is the pull announcement and the rules, joined by `\n`.
    - Values:
      - `marked` is `!!env.AGENTMESH_MESH_WINDOW`;
      - `enrolled` is `existsSync(~/.agentmesh/agent.json) || !!env.CLAUDE_PLUGIN_OPTION_AGENT_ID`;
      - `hintOff` is `env.AGENTMESH_MESH_WINDOW_HINT === 'off'`;
      - `listening` is `anyFresh` over the `push-*` files in `pullStateDirs(env, home)[0]`.
    - It prints nothing when there is nothing to say.

- [ ] **Step 1: Write the failing tests**
  - `session-start.test.ts`:
    - `it('gives the mesh window its rules at every session start')`: for each of `startup`,
      `resume`, `clear`, `compact` and `fork`, `{ additionalContext: windowRules(policy), systemMessage: null }`.
    - `it('tells a new session once when nothing is listening')`: startup, unmarked, enrolled, not
      listening, launcher present gives `HINT_START`. Without the launcher it gives `HINT_SETUP`.
    - `it('stays quiet otherwise')`: both fields are `null` when the session is listening; when the
      source is `resume`, `clear` or `compact`; when `hintOff`; and when not `enrolled`.
  - `heartbeat.test.ts`: `anyFresh` is true for an `updatedAt` 60 s old, false for 3 minutes, false
      for a future time, and false for `[null, 'x', {}]`.
  - `watcher.test.ts`:
    - `it('an active push session keeps a heartbeat file and drops it when it stops')`: with
      `lastDescription` set, `refresh()` writes `push-mesh-alice-agent-s-aaaaaaaaaaaa.json`
      (`meshWindow: false`, no hub call). Clearing `lastDescription` and refreshing removes it.
    - `it('writes no heartbeat while it waits for its re-check')`: `renewedFrom` is set, so there is
      no file.
- [ ] **Step 2: Run** `pnpm vitest run plugins/agentmesh/src/window plugins/agentmesh/src/pull`.
  Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In `hook.ts`, generalize `readStates` into `readJsonFiles(dir, filter)`.
  - In `session.ts`, `recheck` calls `void session.pull.refresh()` after setting `renewedFrom`, and
    `openSession` passes `meshWindow: session.window.state === 'verified'`.
- [ ] **Step 4: Run** `pnpm check`. Expected: PASS.
- [ ] **Step 5: Live check** (Task 12 hands it to Pratik if not run here): start a new private
  session with no window running.
  - Expected: the `HINT_START` or `HINT_SETUP` line shows in the terminal.
  - **Fallback:** move the text into `additionalContext`, prefixed `Tell your human in one line: `.
- [ ] **Step 6: Commit** `"Plugin: session start gives the mesh window its rules and says when nothing is listening"`.

---

### Task 7: The worktree guard's path check

**Files:**
- Create: `plugins/agentmesh/src/guard/paths.ts`, `plugins/agentmesh/src/guard/paths.test.ts`

**Interfaces:**
- **Produces** (built-ins only):
  - `interface PathOptions { platform: NodeJS.Platform; home: string }`.
  - `interface MeshWorktree { root: string; gitDir: string; branch: string | null }`.
  - `meshWorktreeOf(path: string, o: PathOptions): MeshWorktree | { refused: string }`. It returns
    the registered mesh worktree that contains the path (or is the path).
  - `editTarget(path: string, o: PathOptions): { ok: true } | { refused: string }`.
  - **The algorithm** (`meshWorktreeOf`):
    1. Refuse a path that isn't absolute or contains NUL. On win32 also refuse `\\?\`, `\\.\`,
       `//?/`, `//./`, UNC (`\\host` or `//host`) and a `:` after the drive (alternate data
       streams).
    2. Resolve: `realpathSync.native` of the nearest existing ancestor, plus the missing tail
       segments.
    3. Find the last `.claude/worktrees/<name>` run of segments. `<name>` must start with `mesh-`.
       Compare without regard to case on win32 and darwin.
    4. `<root>/.git` must be a regular file (lstat) reading `gitdir: <p>`. Resolve `p` against the
       root, then take its realpath as `gitDir`.
    5. `gitDir/commondir` must exist.
    6. The realpath of `gitDir/gitdir` (resolved against `gitDir` when relative) must equal the
       realpath of `<root>/.git`.
    7. `branch` comes from `gitDir/HEAD` `ref: refs/heads/<b>`, else null.
  - **`editTarget`** additionally requires the path to be strictly inside `root`, no `.git` segment
    after `root`, and nothing inside the realpath of `<home>/.agentmesh`.
  - **Refusal details** (exact):
    - `'the path is not absolute'`
    - `'device, UNC and stream paths are refused'`
    - `'not inside .claude/worktrees/mesh-*'`
    - `'not a registered git worktree'`
    - `'.git is off limits'`
    - `'~/.agentmesh is off limits'`

- [ ] **Step 1: Write the failing tests** (`paths.test.ts`).
  - The helper `mesh(repo, name, branch)` builds the layout git writes (checked against
    `git worktree add` 2.49):
    - `<repo>/.git/worktrees/<name>/{commondir: '../..', gitdir: '<repo>/.claude/worktrees/<name>/.git', HEAD: 'ref: refs/heads/<branch>'}`;
    - `<repo>/.claude/worktrees/<name>/.git` reading `gitdir: <repo>/.git/worktrees/<name>`.
  - **Accepts:**
    - `it('accepts a file inside a registered mesh worktree')`, including a new file in a folder
      that doesn't exist yet. `meshWorktreeOf` gives the branch `'agent/pratik/task-1-a'`, and
      `null` for a detached HEAD (a SHA).
    - `it.runIf(win32)('accepts the same path with a lowercase drive and forward slashes')`
      (Review Focus 1).
    - `it('accepts a checkout path with spaces')` (Review Focus 2).
  - **Refuses** (the exact detail in each):
    - `it('refuses the human checkout')`: `<repo>/src/a.ts`.
    - `it('refuses a worktree without the mesh- prefix')`: `claude --worktree`'s own
      `.claude/worktrees/feature`.
    - `it('refuses a fake .claude/worktrees folder')`: no `.git` file. A `.git` folder in its place
      is refused too.
    - `it('refuses a .git file whose back-pointer names another folder')`.
    - `it('refuses a symlink or junction out of the worktree')`: on win32 the link is
      `symlinkSync(target, link, 'junction')`, elsewhere `'dir'`. The link inside `mesh-a` points
      at `<repo>/src`, and the target goes through it.
    - `it('refuses .git inside a worktree')`: `<wt>/.git` and `<wt>/sub/.git/hooks/pre-commit`.
    - `it('refuses ~/.agentmesh')`.
    - `it.runIf(win32)('refuses device, UNC and stream paths')`: `\\\\?\\C:\\x\\a.ts`,
      `\\\\.\\pipe\\x`, `\\\\server\\share\\a.ts` and `C:\\r\\a.ts:evil`.
    - `it('refuses a relative path')`.
- [ ] **Step 2: Run** `pnpm vitest run plugins/agentmesh/src/guard`. Expected: FAIL.
- [ ] **Step 3: Implement** `paths.ts`.
- [ ] **Step 4: Run** `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `"Plugin: the worktree guard resolves paths and accepts only registered mesh worktrees"`.

---

### Task 8: The worktree guard's command check, and the test policy

**Files:**
- Create: `plugins/agentmesh/src/guard/commands.ts`, `plugins/agentmesh/src/guard/commands.test.ts`

**Interfaces:**
- **Consumes:** `WindowPolicy` (Task 1) and `MeshWorktree` (Task 7).
- **Produces:**
  - `interface CommandContext { policy: WindowPolicy | null; cwd: string; worktreeOf: (dir: string) => MeshWorktree | null }`.
  - `classifyCommand(command: string, c: CommandContext): { pass: true } | { ask: string }`.
  - **The forms that pass** (exact, whole-string). `SAFE` is the token class
    `[A-Za-z0-9._/:@^~=,-]+`, not starting with `--output`. `PATH` is an unquoted
    `[A-Za-z0-9._/:-]+` or a double-quoted `"[A-Za-z0-9._/: -]+"`. `SLUG` is `[a-z0-9][a-z0-9-]{0,62}`.
    - `pwd`, `git status`, `git fetch origin`, `git worktree list`;
    - `ls( SAFE)*`;
    - `git (diff|log|show)( SAFE)*`;
    - `cd PATH`;
    - `git worktree add .claude/worktrees/mesh-SLUG origin/<branch name>`;
    - `git worktree add .claude/worktrees/mesh-SLUG -b <own prefix><rest> origin/<integration branch>`,
      where `<rest>` is a branch-name tail;
    - `git worktree remove .claude/worktrees/mesh-SLUG`;
    - a test command `T` from `policy.testCommands`, bare (in `cwd`) or as `cd PATH && T` (`PATH`
      resolved against `cwd`). Its folder's `worktreeOf` must be non-null, with a `branch` that
      starts with a non-null `ownBranchPrefix`;
    - **(controller ruling)** the delivery forms, bare or as `cd PATH && <form>`, under the same
      own-branch worktree condition as tests:
      - `git add -A`; `git add -- PATH( PATH)*`;
      - `git commit( -m '[^']*')+`;
      - `git push( -u)? origin B`, where `B` equals the worktree's `branch` exactly;
      - `gh pr create --base <integration branch> --head B( --title '[^']*')?( --body '[^']*')?`.

      In a foreign or unplaceable worktree they ask the generic reason.
  - **Ask reasons** (exact):
    - no policy: `"mesh window: ~/.agentmesh/mesh-window.json is missing or invalid, so every command needs your human's approval"`;
    - a test outside a worktree: `"mesh window: run tests inside a task worktree (cd <worktree> && <test>)"`;
    - a foreign test: `` `mesh window: ${branch ?? 'a detached checkout'} isn't your branch, so running its tests needs your human's approval` ``;
    - everything else: `"mesh window: this command isn't on the window's list, so your human decides"`.

- [ ] **Step 1: Write the failing tests** (`commands.test.ts`).
  - Set-up:
    - `policy = { …, agentId: 'pratik-agent', ownBranchPrefix: 'agent/pratik/', integrationBranch: 'agents', testCommands: ['pnpm check'] }`;
    - `own` is the `MeshWorktree` for
      `resolve('/t/John Smith/web/.claude/worktrees/mesh-task-3-login')`, branch
      `agent/pratik/task-3-login`;
    - `theirs` is the one for `resolve('/t/web/.claude/worktrees/mesh-review-task-2')`, branch
      `agent/sagar/task-2-x`;
    - `worktreeOf` is a stub keyed by `resolve(dir)`, and `classifyCommand` resolves `cd` targets
      with `resolve(cwd, path)`, so the test runs the same on Windows and Linux.
  - `it('passes routine and read-only commands')`, each with `cwd` `C:/t`:
    - `git status`
    - `git fetch origin`
    - `pwd`
    - `ls -la src`
    - `git diff origin/agents...origin/agent/sagar/task-2-x`
    - `git log --oneline -5`
    - `git show HEAD~1 --stat`
    - `git worktree list`
    - `cd C:/t/web`
    - `cd "C:/Users/John Smith/web"`
    - `git worktree add .claude/worktrees/mesh-task-3-login -b agent/pratik/task-3-login origin/agents`
    - `git worktree add .claude/worktrees/mesh-review-task-2 origin/agent/sagar/task-2-x`
    - `git worktree remove .claude/worktrees/mesh-task-3-login`
  - `it('runs tests without asking only on its own branch')`:
    - `cd "<own root>" && pnpm check` passes, with a root containing a space (Review Focus 2);
    - `pnpm check` with `cwd` set to the own root passes;
    - `cd <theirs root> && pnpm check` asks
      `"mesh window: agent/sagar/task-2-x isn't your branch, so running its tests needs your human's approval"`;
    - `pnpm check` with `cwd` `C:/t` asks the "run tests inside a task worktree" reason.
  - `it('commits, pushes and opens its PR without asking only from its own worktree')`:
    - With `cwd` set to the own root, these pass:
      - `git add -A`
      - `git commit -m 'Add login' -m 'Body text; with $ and ;'`
      - `git push -u origin agent/pratik/task-3-login`
      - `gh pr create --base agents --head agent/pratik/task-3-login --title 'Login' --body 'Closes task-3'`
      - `cd "<own root>" && git commit -m 'x'`
    - These ask:
      - `git push origin agent/pratik/other` (not this worktree's branch);
      - `git push --force origin agent/pratik/task-3-login`;
      - `git push origin HEAD:agents`;
      - `git commit --amend -m 'x'`;
      - `git commit -m "double $(quoted)"`;
      - `gh pr create --base main --head agent/pratik/task-3-login`;
      - `gh pr merge 12`;
      - `cd <theirs root> && git push origin agent/sagar/task-2-x`.
  - `it('asks for everything else')`, each giving the generic reason:
    - `git fetch origin +refs/heads/*:refs/heads/*`
    - `git fetch origin main:main`
    - `git push origin agent/pratik/x`
    - `git worktree add .claude/worktrees/mesh-x -b agent/sagar/x origin/agents`
    - `git worktree add .claude/worktrees/mesh-x -b agent/pratik/x origin/agent/sagar/y`
    - `git worktree add -f .claude/worktrees/mesh-x origin/agents`
    - `git worktree remove --force .claude/worktrees/mesh-x`
    - `git worktree add .claude/worktrees/feature origin/agents`
    - `git -C web status`
    - `git diff --output=/tmp/x`
    - `git status; rm -rf .`
    - `git status && curl x`
    - `ls $(whoami)`
    - `pnpm check --watch`
    - `pnpm  check`
    - `cd C:\\t\\web`
    - `git status\nrm -rf /`
  - `it('asks for every command without a policy')`: `git status` with `policy: null` gives the
    no-policy reason.
- [ ] **Step 2: Run** `pnpm vitest run plugins/agentmesh/src/guard`. Expected: FAIL.
- [ ] **Step 3: Implement** `commands.ts` as whole-string regexes built once from the policy. Test
  commands are compared by string equality, never by pattern.
- [ ] **Step 4: Run** `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `"Plugin: the worktree guard's command list, and tests only on its own branches without asking"`.

---

### Task 9: The guard runs: `dist/guard.js`, fail-closed, and activation needs it

**Files:**
- Create: `plugins/agentmesh/src/guard.ts` (entry)
- Create: `plugins/agentmesh/src/guard/decide.ts`, `plugins/agentmesh/src/guard/decide.test.ts`
- Create: `plugins/agentmesh/src/guard/io.ts`, `plugins/agentmesh/src/guard/io.test.ts`
- Create: `plugins/agentmesh/src/window/guard-stamp.ts`, `plugins/agentmesh/src/window/guard-stamp.test.ts`
- Create: `plugins/agentmesh/src/guard.entry.test.ts`
- Create: `plugins/agentmesh/src/hooks.test.ts`
- Modify: `plugins/agentmesh/hooks/hooks.json`
- Modify: `plugins/agentmesh/tsup.config.ts` (`entry` gains `guard: 'src/guard.ts'`; update the comment)
- Modify: `plugins/agentmesh/src/tools/sessions.ts` (`activate`), `plugins/agentmesh/src/tools/window.test.ts`

**Interfaces:**
- **Consumes:** Task 7 (`editTarget`, `meshWorktreeOf`), Task 8 (`classifyCommand`) and Task 1
  (`readMarker`, `MESH_WINDOW_ENV`).
- **Produces:**
  - **Constants:** `ACTIVATE_TOOL = 'mcp__plugin_agentmesh_mesh__activate'`;
    `FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']`.
  - `interface GuardContext { marked: boolean; policy: WindowPolicy | null; home: string; platform: NodeJS.Platform }`.
  - `type GuardDecision = { kind: 'pass' } | { kind: 'stamp' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason: string }`.
  - `decide(input: unknown, ctx: GuardContext): GuardDecision`.
    - Unmarked: always `pass`.
    - Marked:
      - unparsable input: deny `"mesh window: the guard could not read this tool call, so it is refused"`;
      - `FILE_TOOLS` read `tool_input.notebook_path ?? tool_input.file_path`. A missing path denies
        `"mesh window: this edit names no file, so it is refused"`. `editTarget` refusals deny
        `` `mesh window: work only inside a task worktree (${detail})` ``;
      - `Bash` uses `classifyCommand` with `cwd` from the input, and `worktreeOf` from
        `meshWorktreeOf` (a refusal maps to null);
      - `PowerShell` and `Monitor` ask `` `mesh window: ${tool} commands need your human's approval here` ``;
      - `EnterWorktree` denies `"mesh window: stay in this folder; make worktrees with git worktree add .claude/worktrees/mesh-…"`;
      - `ACTIVATE_TOOL` gives `stamp`;
      - any other tool denies `` `mesh window: the guard does not know ${tool}, so it is refused` ``.
  - `readAll(stream: NodeJS.ReadableStream, capMs: number | null): Promise<string>`. It reads to
    the end with no size limit. With `capMs` it resolves what it has after that many ms.
  - `hookOutput(d: GuardDecision): { exitCode: 0 | 2; stdout: string; stderr: string }`:
    - deny: exit 2, `stderr` is the reason;
    - ask: exit 0, `stdout` is
      `JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } })`;
    - pass and stamp: exit 0 with nothing.
  - `GUARD_STAMP = 'guard-alive.json'`, `GUARD_STAMP_MAX_AGE_MS = 120_000`,
    `writeGuardStamp(dir: string, now: Date): void` (mkdir 700, write-then-rename 600),
    `guardAlive(dir: string, now: number): boolean`.
  - **`guard.ts`:**
    1. `marked` is `!!process.env.AGENTMESH_MESH_WINDOW`.
    2. `readAll(stdin, marked ? null : 1000)`.
    3. Unmarked: exit 0.
    4. Marked: the policy is `readMarker(...).policy`. It decides, writes the stamp into
       `pullStateDirs(env, home)[0]`, then prints and exits by `hookOutput`.
    5. A throw exits 2 when marked and 0 when unmarked.
  - **`hooks.json`** gains `PreToolUse` with two groups:
    - matcher `Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Monitor|EnterWorktree`:
      `{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/guard.js"], "timeout": 10, "onFailure": "block" }`;
    - matcher `mcp__plugin_agentmesh_mesh__activate`: the same command, with no `onFailure`.

    The description mentions the guard.
  - **`activate` in a marked session** refuses before any hub call when
    `!guardAlive(window.dataDir, Date.now())`, with
    `"The mesh window's worktree guard did not run for this call, so this session can't take team work. Check that hooks are on (disableAllHooks) and that node is on PATH, then call activate again."`

- [ ] **Step 1: Write the failing tests**
  - `decide.test.ts` (temp repo with Task 7's `mesh()` helper):
    - `it('does nothing outside the mesh window')`: `decide(null, unmarked)` and an Edit of
      `C:/x.ts` both `pass`;
    - `it('fails closed on a call it cannot read')`;
    - `it('refuses an edit with no path')`;
    - `it('refuses a tool it does not know')`: `Glob`;
    - `it('refuses an edit outside a task worktree')`: the reason starts with
      `'mesh window: work only inside a task worktree ('`;
    - `it('lets an edit inside a registered mesh worktree through')`, including NotebookEdit with
      `notebook_path`;
    - `it('refuses EnterWorktree')`;
    - `it('asks for PowerShell and Monitor')`;
    - `it('stamps the activate call')`;
    - `it('passes Bash to the command list')`: `git status` passes, and `git push` asks.
  - `io.test.ts`:
    - `it('reads a 5 MB tool call whole')`: `readAll(Readable.from(chunks), null)` returns the full
      5,000,000 characters (Review Focus 4);
    - `hookOutput` for each kind equals the shapes above.
  - `guard-stamp.test.ts`: `guardAlive` is true after `writeGuardStamp(dir, now)`; false at
    `now + 121_000`, with no file, and with a corrupt file.
  - `guard.entry.test.ts`: spawn `process.execPath` with `['--import', 'tsx', 'plugins/agentmesh/src/guard.ts']`
    from the repo root, `input` and `env`:
    - unmarked, an Edit of `C:/x.ts`: exit `0`, empty stdout;
    - marked, the same: exit `2`, stderr starts with `mesh window: work only inside a task worktree`;
    - marked, `ACTIVATE_TOOL`, with `CLAUDE_PLUGIN_DATA` set to a temp dir: exit `0`, and
      `guard-alive.json` exists.
  - `hooks.test.ts`: `hooks.json`'s two `PreToolUse` matchers are exactly the strings above. The
    first has `onFailure: 'block'`. Both run `${CLAUDE_PLUGIN_ROOT}/dist/guard.js`.
  - `tools/window.test.ts`: `it('the mesh window refuses to activate while the guard is down')`
    (verified, no stamp, so `isError` with the text above and no hub call), and the Task 3
    verified cases now write a fresh stamp into `deps.window.dataDir` first.
- [ ] **Step 2: Run** `pnpm vitest run plugins/agentmesh/src`. Expected: FAIL.
- [ ] **Step 3: Implement.** If `tsx` can't load the entry in the spawn test on this box, say so in
  the commit, drop that file, and rely on Task 12's smoke against `dist/guard.js`.
- [ ] **Step 4: Run** `pnpm check`. Expected: PASS.
- [ ] **Step 5: Live check** (Task 12 hands it to Pratik if not run here): in a launched window,
  run `cd .claude/worktrees/mesh-x` as one Bash call, then `pnpm check` as the next.
  - Expected: no prompt (the hook's `cwd` follows `cd`).
  - **Fallback:** none needed for safety. The bare form asks, and the rules already use
    `cd <worktree> && <test>`.
- [ ] **Step 6: Commit** `"Plugin: dist/guard.js guards the mesh window; activation needs it alive"`.

---

### Task 10: Reviews, checkouts and the skill's sections

**Files:**
- Create: `plugins/agentmesh/src/window/checkouts.ts`, `plugins/agentmesh/src/window/checkouts.test.ts`
- Create: `plugins/agentmesh/src/tools/task-get.test.ts`
- Modify: `plugins/agentmesh/src/tools/tasks.ts` (`task_get`)
- Modify: `plugins/agentmesh/src/window/rules.ts`, `plugins/agentmesh/src/window/rules.test.ts`
- Modify: `plugins/agentmesh/skills/mesh-collaboration/SKILL.md`

**Interfaces:**
- **Consumes:** `parseRemote` (`src/git.ts`) and `ToolDeps.window` (Task 3).
- **Produces:**
  - `originRepo(dir: string): string | null`. It reads `<dir>/.git/config` only when `<dir>/.git`
    is a folder, takes the `url` of `[remote "origin"]`, and returns `parseRemote(url)`.
  - `findCheckout(repo: string, folder: string): { path: string } | { problem: string }`. It
    searches the folder itself and its direct subfolders, matching case-insensitively with no
    `.git`.
  - `checkoutLine(repo: string | null, folder: string): string`:
    - one match: `` `checkout: ${path}` ``;
    - none: `` `checkout: no git checkout in ${folder} has origin ${repo}. Ask your human for its path; never clone it.` ``;
    - several: `` `checkout: ${n} checkouts in ${folder} have origin ${repo} (${paths.join(', ')}). Ask your human which one to use.` ``;
    - no repo: `'checkout: this task names no repo. Ask your human which checkout to use.'`.
  - `task_get` in a verified mesh window appends `\n` plus `checkoutLine(task.repo, window.folder)`.
  - `windowRules` gains these lines, after the worktree line:
    - `"- task_get names the task's checkout: the one git checkout in this folder whose origin matches the task's repo."`
    - `"- Reviews: read the diff without asking (git fetch origin, then git diff origin/<base>...origin/<branch>). Before you run the tests of a branch that isn't yours, reply in the task thread with status \"working\": \"Running the tests on <branch> needs my human's approval; my verdict waits for it.\" Then run them in a review worktree (git worktree add .claude/worktrees/mesh-review-<task> origin/<branch>) as cd <worktree> && <test command>; your human approves the prompt. Remove the review worktree after review_submit."`
    - `` `- Tests on your own branches (${prefix}…) run without asking.` ``, or with a null prefix
      `"- Every test run asks your human: the branch template doesn't name you."`

- [ ] **Step 1: Write the failing tests**
  - `checkouts.test.ts` (temp folder):
    - `git@github.com:Acme/Web.git` in `web/.git/config` gives `originRepo` `'Acme/Web'`;
    - `findCheckout('acme/web', folder)` finds `web`;
    - the folder itself being the checkout is found;
    - two matches, and none, give the problems above;
    - a subfolder whose `.git` is a file (a worktree) is skipped.
  - `task-get.test.ts`:
    - in a verified window, a task with `repo: 'acme/web'` ends with `checkout: <path>`;
    - an unmarked session's output is unchanged (no `checkout:`);
    - a task with `repo: null` ends with the no-repo line.
  - `rules.test.ts`: the three new lines, with `agent/bob/`.
- [ ] **Step 2: Run** `pnpm vitest run plugins/agentmesh/src`. Expected: FAIL.
- [ ] **Step 3: Implement**, then add a section to the skill after "Tasks", "## Which session you
  are" (about 20 lines):
  - **Your mesh window** follows its session-start rules: one task at a time, each in its own
    `.claude/worktrees/mesh-*` worktree, diffs read freely, and a `working` reply in the task
    thread before running a branch's tests waits for the human.
  - **A private session** (any other) is the human's own work.
    - It may `ask` teammates. If it needs the answer it says so and keeps working on what doesn't
      depend on it.
    - The answer waits for it: it reads with `thread` or `inbox`.
    - Tasks it hands out are followed up by the mesh window.
    - `take` and replies into team threads would move team work into it, so it doesn't do them.
  - **An `ask` that requests work** ("fix this bug") is handled like a task: decide now (accept,
    decline, or `task_create` it), finish your step, then work in its own worktree.

  Also add a red flag: "Running a teammate's branch's tests in the mesh window without telling
  them it waits for your human".
- [ ] **Step 4: Run** `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `"Plugin: the mesh window finds checkouts, reads diffs freely and tells authors when tests wait"`.

---

### Task 11: Docs: ADR 0009, the threat note, and every guide

**Files:**
- Modify: `docs/adr/0009-mesh-window.md`
- Modify: `docs/security.md`
- Modify: `docs/protocol.md`
- Modify: `docs/configuration.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/deploy.md`
- Modify: `plugins/agentmesh/README.md`, `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/specs/2026-11-01-mesh-window-design.md` (the status line)

- [ ] **Step 1: ADR 0009.**
  - **Status:** "part 2 of 3 built (the mesh window)".
  - **A "Decision, part 2" section:**
    - the marker and hello flag;
    - routing order;
    - the launcher and its settings file;
    - the two layers (allow rules and guard) and fail-closed;
    - the test policy (decision 5) and the `working` reply;
    - rules from the plugin;
    - the session-start hint;
    - layered settings accepted;
    - the sandbox deferred.
  - **Consequences:**
    - team work goes to the window even when another session is in the task's repo;
    - private sessions stay private;
    - commits, pushes and PRs prompt;
    - the guard costs a `node` start per edit or shell call in every session.
- [ ] **Step 2: `docs/security.md`.** A new section, "## The mesh window", after "Sessions and
  per-session delivery". It holds spec §8's plan-2 parts with §13's corrections:
  - **What runs without asking:** the exact allow list from Task 4. Never the bundled CLI, `ssh`,
    `scp`, `gh pr merge`, `git push --force`, or a fetch from an arbitrary URL.
  - **The guard:**
    - it denies and asks as in Tasks 7–9;
    - it fails closed, with `onFailure: "block"`;
    - `EnterWorktree` is denied;
    - a marker spoofed by a repo only turns the guard on.
  - **Tests (decision 5).**
    - Others' branches ask, and the author's agent is told.
    - On the window's own branches tests run unprompted. The residual risk is restated: they "read
      **and write** as you, including persistence in `.git/hooks` (shared by every worktree),
      `~/.agentmesh/` and the guard itself, and switching the guard off".
  - **The corrected claims:**
    - "Bash writes prompt": not for allow-listed test commands;
    - "the window can't loosen its own rules": only Claude's own edits are stopped;
    - "no teammate text passes through the window's model": false. The window reads every ask and
      task, and injection can make it act within its permissions. It can't approve prompts.
  - **Tampering:**
    - the settings file is Claude Code–protected as a `--settings` file, and the guard denies
      `~/.agentmesh/`;
    - `disableAllHooks: false`;
    - bypass and auto mode are disabled;
    - the token.
  - **Git:** the `GIT_CONFIG_*` environment turns off repo hooks and fsmonitor and refuses implicit
    bare repos.
  - **Layered settings:** the human's own allow rules for other tools apply in the window. An
    installed mod can approve what the guard asked about under API-key auth (permissions.md).
  - **Launcher input:**
    - the agent pattern;
    - the quoted folder;
    - the refused characters;
    - the PATH walk;
    - `NoDefaultCurrentDirectoryInExePath`, with Task 4's live-check result.
  - **`meshWindow` in hello:** a client-asserted routing hint that grants nothing.

  Next to "Permission prompts stay local", add: "In the mesh window, test commands on a branch you
  didn't write ask before they run; on its own branches they run without a prompt."
- [ ] **Step 3: The other docs.**
  - **`protocol.md`:**
    - the hello `meshWindow` and `SessionSummary.meshWindow`;
    - Routing gains rule 3 "The agent's mesh window" (`mesh window`), and the list is renumbered;
    - the `; skipped inactive …` suffix.
  - **`configuration.md`:** a short "## Laptop (plugin)" section. Plugin options and env knobs are
    in the plugin README: `AGENTMESH_MESH_WINDOW` (set only by the launcher) and
    `AGENTMESH_MESH_WINDOW_HINT=off`. The files are listed there too.
  - **`getting-started.md`:** a "### Your mesh window" section after "Join with an invite". It
    covers:
    - setting it up with `/agentmesh:window`;
    - the daily start;
    - what it does without asking and what prompts;
    - private sessions;
    - Desktop users (Aheen): start the window in a terminal and turn off the inbox poll;
    - adding `.claude/worktrees/` to each repo's `.gitignore`.

    It replaces "Then run `/agentmesh:activate` in each session…".
  - **`deploy.md`:** the upgrade notes (about line 438) point to the mesh window.
  - **The plugin README:**
    - "## Your mesh window" replaces most of "## Activate a session", which keeps the private and
      take notes;
    - `/agentmesh:window`;
    - the hint knob;
    - the guard hook and its per-call cost;
    - Claude Code 2.1.295+.
  - **The root README:** `/agentmesh:window` in the commands table.
  - **`CLAUDE.md`:**
    - Status: the plugin gains `/agentmesh:window`, the guard and `dist/guard.js`;
    - the layout line `src/{inbox,tools,join,window,guard}/`;
    - a gotcha: `onFailure` needs 2.1.295.
  - **The design doc:** "Status: Plans 1 and 2 built".
- [ ] **Step 4: Verify.** Run `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `"Docs: the mesh window: ADR 0009 part 2, threat note and guides"`.

---

### Task 12: Release 0.5.0, end-to-end tests, and the live checks

**Files:**
- Modify: `packages/common/src/version.ts`, the 9 workspace `package.json` files and
  `plugins/agentmesh/.claude-plugin/plugin.json`: `0.4.4` becomes `0.5.0`
- Modify: `tests/integration/support.ts`
  - `spawnAgent` takes `extraEnv?: Record<string, string>`.
  - It strips `AGENTMESH_MESH_WINDOW` and `AGENTMESH_MESH_WINDOW_HINT` from the inherited
    environment.
  - It sets `CLAUDE_PLUGIN_DATA` to a fresh temp dir unless one is given.
  - `activate` returns the final result text.
- Create: `tests/integration/mesh-window.e2e.test.ts`
- Modify: the rebuilt `plugins/agentmesh/dist/{server,cli,hook,guard}.js`

- [ ] **Step 1: Write the e2e test** (`mesh-window.e2e.test.ts`, in the style of
  `sessions.e2e.test.ts`):
  - `it('team work goes to the mesh window, not the session activated first')`:
    1. Activate plain `bob-agent` session `b1`.
    2. Spawn `b2` with a temp `home` holding `.agentmesh/mesh-window.json` (bob-agent, token `T`),
       `extraEnv: { AGENTMESH_MESH_WINDOW: T, CLAUDE_PLUGIN_DATA: d }`, and a fresh
       `writeGuardStamp(d, new Date())`.
    3. Activate `b2`. Its text contains `It is your mesh window.`
    4. Alice asks bob. `b2` receives it, and `b1.events` stays `[]` after `quiet()`.
    5. Alice's `peers` contains `[mesh window]`.
  - `it('a marked session without its guard refuses to activate')`: no stamp, so `activate`
    rejects with `worktree guard did not run`.
- [ ] **Step 2: Bump and rebuild.**
  1. Set `0.5.0` in all 11 files.
  2. Run `pnpm --filter @agentmesh/plugin build`.
  3. Check that `plugins/agentmesh/dist/guard.js` exists.
  4. Run `node -e "for (const f of ['hook','guard']) { const t = require('fs').readFileSync('plugins/agentmesh/dist/'+f+'.js','utf8'); if (/ZodError|from 'zod'/.test(t)) throw new Error(f+' bundles zod'); }"`.
     Expected: no output.
- [ ] **Step 3: Smoke the built guard.** Pipe
  `{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"C:/x.ts"},"cwd":"C:/"}`
  into `node plugins/agentmesh/dist/guard.js`:
  - with no marker: exit `0`, no output;
  - with `AGENTMESH_MESH_WINDOW=x`: exit `2`, stderr `mesh window: work only inside a task worktree (not inside .claude/worktrees/mesh-*)`.
- [ ] **Step 4: Verify everything.**
  1. Run `pnpm check`. Expected: PASS, including `version.test.ts`.
  2. Run every integration test with nats-server, as described in the Global Constraints. Expected:
     every file runs and passes, with none skipped.
  3. Report the counts.
  4. `git status` shows the rebuilt dist files.
- [ ] **Step 5: Hand Pratik the live checks** that Tasks 4, 6 and 9 couldn't run, in the commit body
  and the final report, each with its fallback:
  - the slash command as the first prompt;
  - the worktree edit with no prompt;
  - the PowerShell daily command;
  - the planted `node.exe`;
  - the hint in the terminal;
  - the hook's `cwd` after `cd`.
- [ ] **Step 6: Commit** `"Plugin 0.5.0: the mesh window"`.
