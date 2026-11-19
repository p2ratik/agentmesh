# Cosmicwave Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename AgentMesh to Cosmicwave in one release (0.8.0) so that existing laptops keep their
keys, existing servers keep their data, and nothing on the wire changes.

**Architecture:** Task 1 renames everything mechanically and leaves the repo green. Tasks 2–7 then
add back, on purpose and in named places, the few old-name strings that existing installs depend
on (the laptop folder, the shim marker, Discord names, Docker volumes, server installs). Task 8
adds a check that keeps the old name out of everywhere else. Task 9 writes the docs and proves the
whole branch.

**Tech Stack:** Node 24, pnpm 10, TypeScript 7, zod 4, Biome 2, vitest 5, tsup, bash (deploy
scripts), Docker Compose.

**Spec:** `docs/specs/2026-11-19-cosmicwave-rename-design.md`. Read it first; this plan argues
from it.

## Global Constraints

- **Branch:** `agent/pratik/cosmicwave-rename`. Commit there after each task. Never push, never
  merge, never touch the server or GitHub settings: those are Pratik's steps (last section).
- **Commit messages** end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- **Names** (exact): plugin `cmw`; marketplace `cosmicwave`; repository `p2ratik/cosmicwave`;
  install `cmw@cosmicwave`; tool prefix `mcp__plugin_cmw_mesh__`; channel `plugin:cmw@cosmicwave`;
  channel source `plugin:cmw:mesh`; laptop folder `~/.cosmicwave`; CLI `cmw`; binaries
  `cosmicwave-hub`, `cosmicwave-discord`; images `cosmicwave-hub`, `cosmicwave-discord-bridge`;
  packages `@cosmicwave/*`; environment variables `COSMICWAVE_*`; scripts `cosmicwave-deploy`,
  `cosmicwave-backup`; server folder `/opt/cosmicwave`; compose project `cosmicwave`; setup state
  file `.cosmicwave-setup.json`; version `0.8.0`.
- **Unchanged:** `claude-mesh`, the MCP server key `mesh`, every tool name, subject, stream, RPC
  method, migration and schema, `hub.sqlite`, the invite format, and the reason code
  `path.agentmesh_dir`.
- **Copy rule:** Cosmicwave is the product. A team's own instance is "a mesh", "your team's
  mesh" or "the mesh "opzami"", never "a Cosmicwave" or "your team's Cosmicwave".
- **Repo rules** (`CLAUDE.md`): no source file over 300 lines; the hook and guard bundles import
  only `node:*` and the built-ins-only modules; secrets never appear in output or tests.
- **Verify commands** (this laptop has untracked folders that break `biome check .`):
  - `pnpm typecheck`
  - `pnpm exec biome check apps packages plugins tests scripts`
  - `pnpm check:size`
  - `pnpm test`
- **Windows dev box:** write files with the Write/Edit tools, never bash heredocs; use `node`,
  not `python3`.

## Review Focus

Each line names its owning task, which carries the test.

1. **A seed path saved in another spelling.** `agent.json` may hold the seed as
   `C:\Users\x\.agentmesh\a.nk`, `C:/Users/x/.agentmesh/a.nk`, `c:/users/X/.AgentMesh/a.nk` or
   `~/.agentmesh/a.nk`. All must resolve to the file in `~/.cosmicwave` after the move. (Task 2)
2. **Both folders exist.** A member made `~/.cosmicwave` by hand (for an invite or the backup
   key) before switching, so the move cannot happen. The plugin must still find the identity in
   `~/.agentmesh` and say what to do, not report "not joined". (Task 2)
3. **A session on a laptop that never set up a window** must not be told to run `/cmw:window`
   because of the rename. (Task 3)
4. **A converted workspace whose `.env` already sets `COMPOSE_PROJECT_NAME`** to something else
   keeps that value. (Task 6)
5. **An `authorized_keys` file with the admin's own key and the old deploy line** keeps the
   admin's line byte for byte and ends with exactly one deploy line. (Task 7)

---

### Task 1: Mechanical rename to 0.8.0

**Files:**
- Move: `plugins/agentmesh` → `plugins/cmw`; `deploy/auto-deploy/agentmesh-deploy.sh` →
  `cosmicwave-deploy.sh`; `deploy/backup/agentmesh-backup.sh` → `cosmicwave-backup.sh`;
  `tests/deploy/agentmesh-deploy.test.ts` → `cosmicwave-deploy.test.ts`;
  `tests/deploy/agentmesh-backup.test.ts` → `cosmicwave-backup.test.ts`.
- Modify: about 520 tracked files, by script.
- Not committed: the replace script itself (keep it in the session's scratchpad).

**Interfaces:**
- Produces: every name in Global Constraints. `agentmeshDir` becomes `cosmicwaveDir` here and is
  removed in Task 2.

- [ ] **Step 1: Move the paths** with `git mv` (the five moves above).

- [ ] **Step 2: Write and run the replace script.** A Node script over `git ls-files`, skipping
  `plugins/cmw/dist/**`, `pnpm-lock.yaml`, the two `docs/specs/2026-11-19-cosmicwave-rename-*.md`
  files and any file that is not valid UTF-8. Case-sensitive, in this order:

  | # | Find (regex) | Replace |
  | --- | --- | --- |
  | 0 | protect, restore at the end: `path\.agentmesh_dir`; `Projects[-\\/]+AgentMesh[A-Za-z-]*` | unchanged |
  | 1 | `plugin:agentmesh@agentmesh` | `plugin:cmw@cosmicwave` |
  | 2 | `agentmesh@agentmesh` | `cmw@cosmicwave` |
  | 3 | `plugin:agentmesh:mesh` | `plugin:cmw:mesh` |
  | 4 | `mcp__plugin_agentmesh_mesh__` | `mcp__plugin_cmw_mesh__` |
  | 5 | `plugins/cache/agentmesh/agentmesh` | `plugins/cache/cosmicwave/cmw` |
  | 6 | `plugins/agentmesh` | `plugins/cmw` |
  | 7 | `/agentmesh:(?=[a-z])` | `/cmw:` |
  | 8 | `\bagentmesh:(?=[a-z])` | `cmw:` |
  | 9 | `\bagentmesh (init\|validate\|keys\|nats-config\|agent-setup\|setup\|doctor\|upgrade\|autoupdate\|window\|timeline)\b` | `cmw $1` |
  | 10 | `Usage: agentmesh\b` | `Usage: cmw` |
  | 11 | `AGENTMESH` | `COSMICWAVE` |
  | 12 | `AgentMesh` | `Cosmicwave` |
  | 13 | `agentmesh` | `cosmicwave` |
  | 14 | `\b([Aa])n Cosmicwave\b` | `$1 Cosmicwave` |

- [ ] **Step 3: Hand edits the script cannot decide.**
  - `plugins/cmw/.claude-plugin/plugin.json`: `"name": "cmw"`, `"displayName": "Cosmicwave"`.
  - `.claude-plugin/marketplace.json`: `"name": "cosmicwave"`; the plugin entry `"name": "cmw"`,
    `"source": "./plugins/cmw"`.
  - `apps/cli/package.json`: `"bin": { "cmw": "./dist/main.js" }`. `apps/cli/src/main.ts` usage:
    first line `cmw — set up and manage a Cosmicwave mesh`, last line
    ``Run `cmw <command> --help` for details.``
  - Every prose mention of the CLI as a bare word (`` `cosmicwave` CLI``, "the cosmicwave CLI")
    becomes `cmw`. Find them with `git grep -n -w cosmicwave -- '*.ts' '*.md' ':!plugins/cmw/dist'`
    and read each hit.
  - The Discord category default, ten places found with
    `git grep -n "Agent Mesh"`: change the value to `Cosmicwave` in
    `packages/config/src/schema/integrations.ts`, `apps/cli/src/setup/render/mesh-yaml.ts`,
    `config/examples/mesh.yaml`, `docs/configuration.md`, `docs/discord.md`,
    `docs/getting-started.md` and the two CLI test fixtures. Leave
    `docs/specs/2026-10-16-agent-mesh-design.md` and `apps/hub/src/testing/services.ts` alone.
  - `apps/hub/src/modules/sessions/handlers.ts` and `apps/hub/src/rpc/router.ts`: the two
    "plugin too old" messages end with: `It has been renamed: remove it and install
    cmw@cosmicwave (see docs/getting-started.md), then restart Claude Code.` The old name stays
    out of the hub's source. Update the tests that quote them.
  - Apply the copy rule: `git grep -n -E "(an?|the|your|team's) Cosmicwave\b" -- ':!plugins/cmw/dist'`
    and rewrite each hit where the name stands for a team's instance.
  - Version: `packages/common/src/version.ts`, the 9 workspace `package.json` files and
    `plugins/cmw/.claude-plugin/plugin.json` all say `0.8.0`.

- [ ] **Step 4: Regenerate.** `pnpm install` (rewrites the lockfile), then
  `pnpm exec biome check --write apps packages plugins tests scripts`, then
  `pnpm --filter @cosmicwave/plugin build`.

- [ ] **Step 5: Verify.** Run the four verify commands. Expected: all pass, with the same test
  count as before the rename (about 1,660). If `pnpm check:size` names a file, split it by
  responsibility. Then:

  Run: `git grep -n -i agentmesh -- . ':!plugins/cmw/dist' ':!docs/specs/2026-11-19-cosmicwave-rename-*'`
  Expected: only `path.agentmesh_dir` (code and tests) and the protected local paths in old specs.

- [ ] **Step 6: Commit** `Rename AgentMesh to Cosmicwave (0.8.0): names only`.

### Task 2: The laptop folder moves, and the keys with it

**Files:**
- Create: `packages/common/src/mesh-home.ts`, `packages/common/src/mesh-home.test.ts`
- Modify: `packages/common/package.json` (export `./mesh-home`), `packages/common/src/index.ts`,
  `packages/common/src/agent-files.ts`, `packages/common/src/window.ts`,
  `packages/common/src/secret-paths.ts`, `plugins/cmw/src/main.ts`, `plugins/cmw/src/config.ts`,
  `plugins/cmw/src/agent-id.ts`, `plugins/cmw/src/hook.ts`, `plugins/cmw/src/pull/state.ts`,
  `plugins/cmw/src/guard/paths.ts`, `plugins/cmw/src/join/files.ts`, `apps/cli/src/main.ts`,
  `apps/cli/src/commands/agent-setup.ts`, `apps/cli/src/commands/setup/admin.ts`,
  `apps/cli/src/commands/window.ts`, `apps/cli/src/setup/workspace.ts`, `docs/security.md`
- Test: `packages/common/src/mesh-home.test.ts`, plus cases in the existing guard, secret-path,
  config and window tests.

**Interfaces:**
- Produces, from `@cosmicwave/common/mesh-home` (built-ins only, `node:*` imports only):

  ```ts
  export const HOME_DIR = '.cosmicwave';
  export const LEGACY_HOME_DIR = '.agentmesh';
  export type HomeDirName = typeof HOME_DIR | typeof LEGACY_HOME_DIR;
  export type MoveResult = 'moved' | 'nothing' | 'failed' | 'both';
  export interface HomeFs {
    existsSync(path: string): boolean;
    renameSync(from: string, to: string): void;
    readFileSync(path: string, encoding: 'utf8'): string;
    writeFileSync(path: string, text: string): void;
  }
  export function homeDirName(home: string, exists?: (p: string) => boolean): HomeDirName;
  export function meshHome(home?: string, exists?: (p: string) => boolean): string;
  export function moveLegacyHome(home?: string, fs?: HomeFs): MoveResult;
  export function mapLegacyPath(
    file: string, home: string, exists?: (p: string) => boolean, platform?: NodeJS.Platform,
  ): string;
  export const BOTH_FOLDERS =
    'Both ~/.cosmicwave and ~/.agentmesh exist. Move what you need into ~/.cosmicwave, then delete ~/.agentmesh.';
  ```

- Removes: `cosmicwaveDir` from `agent-files.ts`. Callers use `meshHome`.

- [ ] **Step 1: Write the failing tests** in `mesh-home.test.ts`, each against a real temp home
  (`mkdtempSync`) unless it says "fake fs":

  ```ts
  describe('homeDirName', () => {
    it('is .cosmicwave on a fresh laptop', …);            // neither folder
    it('is .agentmesh on a laptop not moved yet', …);     // only legacy
    it('is .cosmicwave once it holds agent.json', …);     // both, identity in new
    it('is .agentmesh when both exist and only it holds agent.json', …); // Review Focus 2
  });
  describe('moveLegacyHome', () => {
    it('moves the folder with everything in it', …);
    // legacy has agent.json, a.nk, backup-age-key.txt, teammates/x.nk → 'moved'; all four exist
    // under .cosmicwave; .agentmesh is gone
    it('rewrites a seed path that pointed into the old folder', …);
    // agent.json nkeySeed `${home}/.agentmesh/a.nk` → `${home}/.cosmicwave/a.nk`; other fields equal
    it('leaves a seed literal and an outside path alone', …);
    it('returns "nothing" with no legacy folder, and when already moved', …);
    it('returns "both" and moves nothing when both folders exist', …);
    it('returns "failed" and changes nothing when the rename throws', …);        // fake fs
    it('returns "moved" when the rename throws because another process won', …); // fake fs
  });
  describe('mapLegacyPath', () => {                       // Review Focus 1
    it.each([
      ['C:\\Users\\x\\.agentmesh\\a.nk', 'win32'],
      ['C:/Users/x/.agentmesh/a.nk', 'win32'],
      ['c:/users/X/.AgentMesh/a.nk', 'win32'],
      ['~/.agentmesh/a.nk', 'win32'],
      ['/home/x/.agentmesh/a.nk', 'linux'],
      ['~/.agentmesh/a.nk', 'linux'],
    ])('maps %s when the old file is gone', …);           // → <home>/.cosmicwave/a.nk
    it('does not fold case on linux', …);
    it('returns the path unchanged while the old file exists', …);
    it('returns a seed literal and an outside path unchanged', …);
  });
  ```

- [ ] **Step 2: Run** `pnpm exec vitest run packages/common/src/mesh-home.test.ts`. Expected: FAIL,
  module not found.

- [ ] **Step 3: Implement `mesh-home.ts`.**
  - `homeDirName`: `.cosmicwave` if `<home>/.cosmicwave/agent.json` exists; else `.agentmesh` if
    `<home>/.agentmesh/agent.json` exists; else `.agentmesh` if only that folder exists; else
    `.cosmicwave`.
  - `moveLegacyHome`: `'both'` if both folders exist; `'nothing'` if the legacy one is missing;
    otherwise `renameSync`. On a throw, `'moved'` if the new folder now exists, else `'failed'`.
    After a move, rewrite `nkeySeed` in the new `agent.json` through `mapLegacyPath` (write a
    temp file beside it, then rename; keep 2-space JSON; swallow errors, the reader maps too).
  - `mapLegacyPath`: compare with `\` as `/`, case-insensitively only on `win32`. Never throws.

- [ ] **Step 4: Run it.** Expected: PASS.

- [ ] **Step 5: Route every reader through it.**
  - `packages/common/package.json`: add `"./mesh-home": "./src/mesh-home.ts"`; re-export from
    `index.ts`.
  - `agent-files.ts`: `existingMesh` reads `join(meshHome(home), 'agent.json')` and returns
    `nkeySeed` through `mapLegacyPath`.
  - `window.ts`: `windowFiles` uses `join(home, homeDirName(home))` with its platform's `join`.
    `launcherDisplay` and `LAUNCHER_CMD` stay `.cosmicwave`.
  - `secret-paths.ts`: `SECRET_HOME_PATHS` has `'.cosmicwave/**'` followed by `'.agentmesh/**'`.
  - `plugins/cmw/src/config.ts`: replace the constant `DEFAULT_CONFIG_FILE` with
    `export const defaultConfigFile = (): string => join(meshHome(), 'agent.json')`, used as
    `resolveConfig`'s default; `readFileConfig` returns `nkeySeed` through `mapLegacyPath`.
  - `agent-id.ts` (`hookAgentId`), `hook.ts` (the `enrolled` check), `pull/state.ts` (the `run`
    fallback), `join/files.ts`, `agent-setup.ts`, `setup/admin.ts`, `setup/workspace.ts`: use
    `meshHome(home)`.
  - `guard/paths.ts` `editTarget`: refuse a target inside `<home>/.cosmicwave` **or**
    `<home>/.agentmesh`. The refusal text is `~/.cosmicwave is off limits`; its code stays
    `path.agentmesh_dir`.

- [ ] **Step 6: Move at the two entry points.**
  - `plugins/cmw/src/main.ts`: first statement of `main()` is
    `const moved = moveLegacyHome();`. After the logger exists, `logger.info` for `'moved'`
    (`moved ~/.agentmesh to ~/.cosmicwave`), `logger.warn` for `'failed'`
    (`could not move ~/.agentmesh yet; using it in place`) and for `'both'` (`BOTH_FOLDERS`).
    It also runs before `runJoinCli`.
  - `apps/cli/src/main.ts`: call `moveLegacyHome(ctx.homeDir)` before the command runs; print
    `BOTH_FOLDERS` on stderr for `'both'`.
  - `apps/cli/src/commands/window.ts`: before writing anything, if `<home>/.agentmesh` still
    exists, throw a `MeshError('invalid_request', …)`: with `BOTH_FOLDERS` when
    `<home>/.cosmicwave` exists too, otherwise with
    `~/.agentmesh could not be moved to ~/.cosmicwave. Close every Claude Code session and any terminal inside that folder, then run this again.`
    A window is never written into the old folder.

- [ ] **Step 7: Add the cases to existing tests.**
  - Guard paths: an edit to `<home>/.agentmesh/agent.json` and to `<home>/.cosmicwave/agent.json`
    is refused with code `path.agentmesh_dir`.
  - Guard secrets: `cat ~/.agentmesh/agent.json` and `cat ~/.cosmicwave/agent.json` are denied
    (`secret.path`).
  - Window settings render: the deny list has `Read(~/.cosmicwave/**)` and `Read(~/.agentmesh/**)`.
  - Plugin config: with only `<home>/.agentmesh/agent.json` (not moved), `resolveConfig` finds
    the agent; with both folders and the identity in the old one, it still does (Review Focus 2).
  - `windowInitCommand.run` called directly (so no move ran) with a home where only `.agentmesh`
    exists throws the "could not be moved" message; with both folders it throws `BOTH_FOLDERS`.
    Both write nothing.

- [ ] **Step 8: Threat note.** In `docs/security.md`, add "The laptop folder after the rename":
  the move is one rename and deletes nothing; both folders are denied to reads, commands and
  edits in every mode; the guard and hook never move anything.

- [ ] **Step 9: Verify** with the four verify commands, then
  `pnpm --filter @cosmicwave/plugin build`. Expected: all pass, and the hook and guard bundles
  contain no `zod` (`git grep -c "zod" -- plugins/cmw/dist/hook.js plugins/cmw/dist/guard.js`
  prints nothing).

- [ ] **Step 10: Commit** `Laptop folder: ~/.agentmesh moves to ~/.cosmicwave on first start`.

### Task 3: The mesh window on a moved laptop

**Files:**
- Modify: `packages/common/src/window.ts`, `apps/cli/src/render/window.ts`,
  `plugins/cmw/src/window/start-state.ts`, `plugins/cmw/src/window/session-start.ts`,
  `plugins/cmw/src/hook.ts`
- Test: `apps/cli/src/commands/window-shim.test.ts`, `plugins/cmw/src/window/session-start.test.ts`

**Interfaces:**
- Consumes: `windowFiles` from Task 2.
- Produces:
  - `export const PLUGIN_CHANNEL = 'plugin:cmw@cosmicwave'` in `common/window.ts`; `CHANNEL_FLAG`
    is built from it.
  - `windowStartState(env, agentId, home, platform, readPolicy?, readLauncher?)` returns
    `{ policy, setUp, stale }`. `readLauncher: (home, platform) => string | null` defaults to
    reading `windowFiles(home, platform).launcher`.
  - `SessionStartInput` gains `stale: boolean`.
  - `export const HINT_RENAMED = "This laptop's mesh window was set up when Cosmicwave was called AgentMesh, so claude-mesh no longer starts it. Run /cmw:window once to set it up again."`

- [ ] **Step 1: Write the failing tests.**

  ```ts
  // window-shim.test.ts
  it('overwrites a claude-mesh written under the old name', …);
  // a shim whose marker line is `rem agentmesh claude-mesh` (and `# agentmesh claude-mesh`)
  // is replaced; the new file carries `cosmicwave claude-mesh`
  // (the existing "foreign file is left alone" test must still pass)

  // session-start.test.ts
  it('tells a laptop with a stale window to run /cmw:window', …);
  // source 'startup', enrolled, setUp, stale, not marked → systemMessage === HINT_RENAMED
  it('says nothing about the rename when no window was ever set up', …);   // Review Focus 3
  // setUp false, stale false → HINT_SETUP, as today
  it('says nothing about the rename when the hint is off', …);
  it('windowStartState is stale when the launcher lacks the new channel', …);
  // launcher text contains 'plugin:agentmesh@agentmesh' → stale true;
  // contains PLUGIN_CHANNEL → false; setUp false → false whatever the launcher says
  ```

- [ ] **Step 2: Run both files.** Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `apps/cli/src/render/window.ts`: `SHIM_MARK = 'cosmicwave claude-mesh'`,
    `LEGACY_SHIM_MARK = 'agentmesh claude-mesh'`; `isOurShim` accepts either after `rem ` or `# `.
  - `start-state.ts`: `stale = setUp && !(readLauncher(home, platform) ?? '').includes(PLUGIN_CHANNEL)`.
  - `session-start.ts`: for an unmarked session at `startup`, enrolled and hint on, `stale` wins
    over `HINT_START`.
  - `hook.ts`: pass `stale` through.

- [ ] **Step 4: Run both files.** Expected: PASS. Run the four verify commands and rebuild the
  plugin bundles.

- [ ] **Step 5: Commit** `Mesh window: a window set up as AgentMesh is replaced by /cmw:window`.

### Task 4: The Discord bridge keeps its webhooks and category

**Files:**
- Modify: `apps/discord-bridge/src/discord/webhooks.ts`,
  `apps/discord-bridge/src/discord/provision.ts`, `packages/config/src/schema/integrations.ts`
- Create: `apps/discord-bridge/src/discord/webhooks.test.ts`,
  `apps/discord-bridge/src/discord/provision.test.ts`

**Interfaces:**
- Produces:
  - `export const DEFAULT_CATEGORY = 'Cosmicwave'` in `integrations.ts`, used as the schema default.
  - `export function pickWebhook<T extends { name: string; token: string | null }>(hooks: Iterable<T>): T | undefined`
  - `export function pickCategory<T extends { name: string }>(categories: Iterable<T>, wanted: string): T | undefined`

- [ ] **Step 1: Write the failing tests.**

  ```ts
  // webhooks.test.ts
  it('reuses a webhook named Cosmicwave', …);
  it('reuses a webhook named AgentMesh when there is no Cosmicwave one', …);
  it('prefers Cosmicwave when both exist', …);
  it('ignores a webhook without a token, and other names', …);   // → undefined
  // provision.test.ts
  it('finds the configured category by name', …);
  it('uses an existing "Agent Mesh" category when the wanted name is the default', …);
  it('does not fall back for a name the team chose', …);  // wanted 'Robots', only 'Agent Mesh' → undefined
  ```

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement.** `findOrCreate` uses `pickWebhook` and creates with the name
  `Cosmicwave`. `ensureCategory` uses `pickCategory` over the guild's category channels and
  creates only when it returns `undefined`. The old names live in two constants:
  `LEGACY_WEBHOOK_NAME = 'AgentMesh'`, `LEGACY_CATEGORY = 'Agent Mesh'`.

- [ ] **Step 4: Run them.** Expected: PASS. Run the four verify commands.

- [ ] **Step 5: Commit** `Bridge: reuse webhooks and the category made under the old name`.

### Task 5: A server never starts on empty volumes

**Files:**
- Modify: `deploy/auto-deploy/cosmicwave-deploy.sh`, `apps/cli/src/setup/deploy.ts`
- Test: `tests/deploy/cosmicwave-deploy.test.ts`, `apps/cli/src/commands/setup/deploy.test.ts`
  (it already covers `remoteCommands`)

**Interfaces:**
- Produces: `export const VOLUME_GUARD: string` in `apps/cli/src/setup/deploy.ts`, a shell
  fragment with no apostrophes, placed in `remoteCommands(dir).finish` after `cd ${dir}/deploy`
  and before `docker compose … pull`.

The check, in both places:

```sh
if docker volume inspect agentmesh_hub-data >/dev/null 2>&1 &&
   [ "$(docker compose config 2>/dev/null | sed -n "s/^name: //p" | head -n 1)" != agentmesh ]; then
  echo "This server keeps its data in Docker volumes named agentmesh_*. Add COMPOSE_PROJECT_NAME=agentmesh to deploy/.env and deploy again. Nothing was started." >&2
  exit 1
fi
```

- [ ] **Step 1: Write the failing tests.**

  ```ts
  // cosmicwave-deploy.test.ts, in the suite that already stubs docker and git
  it('refuses to deploy over agentmesh volumes under another project name', …);
  // docker stub: `volume inspect agentmesh_hub-data` exits 0, `compose config` prints
  // "name: cosmicwave" → exit 1, stderr has "COMPOSE_PROJECT_NAME=agentmesh",
  // and the stub's call log has no `pull` and no `compose up`
  it('deploys when the project name is agentmesh', …);       // compose config prints "name: agentmesh"
  it('deploys on a server with no agentmesh volumes', …);    // volume inspect exits 1
  // apps/cli/src/commands/setup/deploy.test.ts
  it('checks the volumes before pulling', …);
  // finish contains VOLUME_GUARD, and it comes before "docker compose --profile discord pull"
  it('has no apostrophe in the guard', …);
  ```

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement.** In the script, a function `refuse_orphaned_volumes`, called in
  `deploy()` after the tag checks and before the image pull, prefixed `cosmicwave-deploy: `.

- [ ] **Step 4: Run them.** Expected: PASS. Run the four verify commands.

- [ ] **Step 5: Commit** `Deploy: refuse to start over data kept under the old project name`.

### Task 6: A setup workspace made before the rename

**Files:**
- Create: `apps/cli/src/setup/legacy-workspace.ts`, `apps/cli/src/setup/legacy-workspace.test.ts`
- Modify: `apps/cli/src/setup/workspace.ts` (`workspaceFrom`)

**Interfaces:**
- Consumes: `readEnvFile`, `updateEnvFile` (`env-file.ts`); `renderCompose`
  (`render/deploy-files.ts`); `writeRendered` (`workspace.ts`).
- Produces: `export function convertLegacyWorkspace(root: string): string[]`. It returns one
  line per change, for printing, and `[]` when there is nothing to do. `workspaceFrom` calls it
  and prints each line with `ctx.stdout`, so every workspace command converts first.

Rules:
- **Legacy** means `<root>/.agentmesh-setup.json` exists, or `deploy/.env` has
  `AGENTMESH_VERSION` and no `COSMICWAVE_VERSION`.
- Rename the state file to `.cosmicwave-setup.json` (never over an existing one).
- For each of `CONFIG_DIR`, `LOG_LEVEL`, `IMAGE_REGISTRY`, `VERSION`: if `AGENTMESH_<k>` is set
  and `COSMICWAVE_<k>` is not, add `COSMICWAVE_<k>` with the same value. Keep the old key.
- Add `COMPOSE_PROJECT_NAME=agentmesh` only when the key is absent.
- In `setup-answers.json`, when `hosting.mode` is `server` and `hosting.remoteDir` is absent, set
  it to `/opt/agentmesh`. Edit the raw JSON; keep 2-space formatting.
- Render `deploy/docker-compose.yml` again (`writeRendered(…, true)`).
- Lines name keys and files, never values.

- [ ] **Step 1: Write the failing tests** against a temp workspace:

  ```ts
  it('does nothing to a workspace made after the rename', …);              // → []
  it('renames the state file and keeps the finished steps', …);
  it('adds the COSMICWAVE_ keys beside the old ones', …);
  it('sets COMPOSE_PROJECT_NAME=agentmesh', …);
  it('keeps a COMPOSE_PROJECT_NAME the admin already set', …);             // Review Focus 4
  it('pins remoteDir to /opt/agentmesh for a server without one', …);
  it('leaves a remoteDir the admin chose, and a trial, alone', …);
  it('renders the compose file again', …);   // old file had "name: agentmesh" → now "name: cosmicwave"
  it('is a no-op the second time', …);       // → []
  it('never prints a value from .env', …);   // .env holds DISCORD_BOT_TOKEN=secret-xyz; no line has it
  ```

- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** `convertLegacyWorkspace` and call it from `workspaceFrom`.
- [ ] **Step 4: Run** the file, then the four verify commands. Expected: PASS.
- [ ] **Step 5: Commit** `Setup: a workspace made as AgentMesh is converted in place`.

### Task 7: Server installs made before the rename

**Files:**
- Create: `deploy/legacy-names.sh`, `tests/deploy/legacy-names.test.ts`
- Modify: `deploy/auto-deploy/install.sh`, `deploy/backup/install.sh`,
  `apps/cli/src/setup/render/host-hardening.ts`, `apps/cli/src/setup/render/host-script.ts`,
  `docs/security.md`
- Test: `tests/deploy/legacy-names.test.ts`, `tests/deploy/cosmicwave-deploy.test.ts` (the
  `bash -n` list), `apps/cli/src/setup/render/host-hardening.test.ts`

**Interfaces:**
- Produces, in `deploy/legacy-names.sh` (sourced, defines functions only, no side effects):
  - `carry_settings <old-file> <new-file>`: when the new file is missing and the old exists,
    writes the new one with `AGENTMESH_DIR` renamed to `COSMICWAVE_DIR` (commented or not), mode
    644, and removes the old one.
  - `carry_path <old> <new>`: `mv` when the new path is missing and the old exists.
  - `without_deploy_lines <authorized_keys>`: prints the file without lines ending in
    ` cosmicwave-github-deploy` or ` agentmesh-github-deploy`.

- [ ] **Step 1: Write the failing tests** (`describe.skipIf(!hasBash)`, sourcing the file in
  `bash -c` against temp files):

  ```ts
  it('carries the settings and renames the folder key', …);
  // old: "AGENTMESH_DIR=/opt/agentmesh\n#GIT_REMOTE=origin\n" →
  // new: "COSMICWAVE_DIR=/opt/agentmesh\n#GIT_REMOTE=origin\n"; old file gone
  it('keeps settings that already exist under the new name', …);   // both exist → new untouched
  it('carries a folder only when the new one is missing', …);
  it('drops both deploy lines and keeps every other key byte for byte', …);   // Review Focus 5
  // input: an admin key line, an old-marker deploy line, a new-marker deploy line, a comment
  // → output: the admin line and the comment, in order, unchanged
  it('defines functions only', …);   // sourcing it prints nothing and changes no file
  ```

  Add `deploy/legacy-names.sh` and `deploy/backup/install.sh` to the `bash -n` list. In
  `host-hardening.test.ts`, expect the rendered host script to contain, before the new unit is
  installed: `systemctl disable --now agentmesh-firewall.service`, `iptables -F AGENTMESH-NATS`,
  `iptables -X AGENTMESH-NATS`, and `rm -f /etc/letsencrypt/renewal-hooks/deploy/agentmesh-nats.sh`.

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `deploy/auto-deploy/install.sh` sources `$HERE/../legacy-names.sh`. Before it writes the
    settings: `carry_settings /etc/default/agentmesh-deploy /etc/default/cosmicwave-deploy` and
    `rm -f /usr/local/sbin/agentmesh-deploy`. Once `HOME_DIR` is known:
    `carry_path "$HOME_DIR/.local/state/agentmesh-deploy" "$HOME_DIR/.local/state/cosmicwave-deploy"`.
    The `authorized_keys` rewrite uses `without_deploy_lines` in place of its `grep -v`.
  - `deploy/backup/install.sh` sources `$HERE/../legacy-names.sh`, then carries
    `/etc/default/agentmesh-backup`, `$HOME_DIR/.ssh/agentmesh-backup` and its `.pub` and
    known-hosts files, and `/var/lib/agentmesh-backup`; disables and removes
    `agentmesh-backup.timer` and `.service`; removes `/usr/local/sbin/agentmesh-backup`.
  - The host script (`host-hardening.ts`, `host-script.ts`): a block, run only when
    `/etc/systemd/system/agentmesh-firewall.service` exists, that disables and removes that unit
    and `/usr/local/sbin/agentmesh-firewall`, carries `/etc/default/agentmesh-firewall`, deletes
    every `DOCKER-USER` rule that jumps to `AGENTMESH-NATS`, then flushes and deletes the chain.
    After the new certbot hook and apt file are written, remove
    `/etc/letsencrypt/renewal-hooks/deploy/agentmesh-nats.sh` and
    `/etc/apt/apt.conf.d/90agentmesh-auto-upgrades`.

- [ ] **Step 4: Threat note.** In `docs/security.md`, under automatic deploys: the installer
  removes the deploy-key line with either marker, so a server never keeps a second valid deploy
  key; the old forced-command script is deleted.

- [ ] **Step 5: Run them,** then the four verify commands. Expected: PASS.
- [ ] **Step 6: Commit** `Server installers: take over an install made as AgentMesh`.

### Task 8: The old name stays out

**Files:**
- Create: `scripts/check-legacy-name.mjs`, `tests/repo/legacy-name.test.ts`
- Modify: `package.json` (`"check:name": "node scripts/check-legacy-name.mjs"`, and `check`
  becomes `pnpm typecheck && pnpm lint && pnpm check:size && pnpm check:name && pnpm test`)

**Interfaces:**
- Produces: a script that lists tracked files (`git ls-files`), skips files that are not UTF-8,
  removes the protected local paths (`Projects[-\\/]+AgentMesh[A-Za-z-]*`) from each line, and
  fails when `/agentmesh/i` still matches in a file that is not in `ALLOWED`. It prints
  `<file>:<line>` for each hit and exits 1; otherwise it prints
  `The old name appears only where it is meant to.` It takes an optional root folder as its
  first argument (default: the current folder).

- [ ] **Step 1: Write the failing test.**

  ```ts
  it('passes on this repository', …);              // exit 0
  it('names a file that brings the old name back', …);
  // a temp git repo with one tracked file "x.md" containing "AgentMesh" → exit 1, stdout "x.md:1"
  it('ignores the protected local paths', …);      // "G:\\Projects\\AgentMesh-relay" → exit 0
  ```

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement.** `ALLOWED` is a list of exact paths, each with a comment saying why,
  plus the one folder `plugins/cmw/dist/`. Build it from what `git grep -il agentmesh` prints
  after Tasks 1–7; every entry must be one of: the folder fallback, the secret deny list, the
  reason code, the shim marker, the Discord names, the volume guard, the workspace conversion,
  the server installers and host script, their tests and fixtures, the name check itself, ADR
  0014, the two rename documents, the "moving from AgentMesh" sections of
  `docs/getting-started.md`, `docs/deploy.md` and `docs/security.md`, and the one-line notes in
  `README.md`, `plugins/cmw/README.md` and `CLAUDE.md` (Task 9 adds those). A hit in any other
  file is a miss from Task 1: fix the file, do not allow it.

- [ ] **Step 4: Run it,** then `pnpm check:name`. Expected: PASS.
- [ ] **Step 5: Commit** `Check: the old name appears only where it is meant to`.

### Task 9: Docs, and proof of the whole branch

**Files:**
- Create: `docs/adr/0014-rename-to-cosmicwave.md`
- Modify: `docs/getting-started.md`, `docs/deploy.md`, `docs/configuration.md`, `README.md`,
  `CLAUDE.md`, `plugins/cmw/README.md`, `scripts/check-legacy-name.mjs` (allow the new sections)

- [ ] **Step 1: ADR 0014,** in the format of ADR 0013 (Status, Context, Decision, Consequences,
  Alternatives): why the name changed; names only; the folder is renamed, not copied; the one
  wire value kept; the compose project name; documents dated before 2026-11-19 were written
  under the name AgentMesh.

- [ ] **Step 2: `docs/getting-started.md`, a section "Moving from AgentMesh"** (anchor
  `#moving-from-agentmesh`) with the member's steps from the spec, section 3: the `agent.json`
  check, the five steps, what is lost (local session records) and what is not (the key, the
  role, every message). Say that both Claude accounts on one laptop switch together.

- [ ] **Step 3: `docs/deploy.md`, a section "Moving a server from AgentMesh"** with, in order:
  add `COMPOSE_PROJECT_NAME=agentmesh` and the `COSMICWAVE_*` keys to `deploy/.env`; rename the
  repository and run the cloud setup script again with the existing `IAM_NAME` and `SG_NAME`;
  make the two new packages public; run `deploy/auto-deploy/install.sh`; deploy; what the volume
  guard says and why; that the host's firewall unit and certbot hook keep their old names unless
  `cmw setup host` is run again.

- [ ] **Step 4: `docs/configuration.md`:** the renamed environment variables and the new
  `discord.provision.category` default. `README.md` and `plugins/cmw/README.md`: one line
  "Cosmicwave was called AgentMesh until 0.8.0", linking the two sections.

- [ ] **Step 5: `CLAUDE.md`:** a Status entry "Renamed to Cosmicwave (0.8.0)" listing what was
  built and, under "Not yet verified", the three gates below. Fix the stale lines the rename
  touches (ADRs 0001–0014; the built-ins-only list gains `packages/common/src/mesh-home.ts`).

- [ ] **Step 6: Rebuild and prove.**
  - `pnpm --filter @cosmicwave/plugin build`, then `git status --short plugins/cmw/dist` must
    show the bundles as changed and nothing untracked.
  - `pnpm build`. Expected: hub, bridge, CLI and plugin all build.
  - The four verify commands, and `pnpm check:name`.
  - `claude plugin validate plugins/cmw`. Expected: valid.
  - Integration tests. They skip silently without both variables, so check the count:
    start `nats-server -js -p 4333 -sd <scratch dir>` in the background (the binary's cached
    path is in the memory note `agentmesh-local-integration-tests`; CI downloads 2.15.1), then
    run `pnpm test:integration` with `COSMICWAVE_TEST_NATS=nats://127.0.0.1:4333` and
    `COSMICWAVE_TEST_NATS_BIN=<path>`. Expected: every test passes and none is skipped.

- [ ] **Step 7: Commit** `Docs: ADR 0014 and the guides for moving from AgentMesh`.

---

## Release gates (with Pratik, not part of the build)

These need a person, a live server or GitHub settings. None is done by the tasks above.

1. **Staging:** a 0.7.2 plugin against the 0.8.0 hub, and a 0.8.0 plugin against a 0.7.2 hub
   (ask, reply, a task, a review).
2. **Windows:** a real uninstall and reinstall on Pratik's laptop: the folder moves, the agent
   connects with the same key, `/cmw:window` then `claude-mesh` starts the window.
3. **Scratch marketplace:** what a 0.7.2 install does when its marketplace becomes the renamed
   one, with auto-update on and off. If it stops working or its guard blocks, stop and decide.
4. Then the rollout, in the spec's order (section 7).
