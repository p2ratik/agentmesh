# `/agentmesh:setup` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an admin types `/agentmesh:setup` and Claude takes them from "plugin installed" to a live mesh: their own agent active, a checklist proving it, and the team's `/mesh invite` lines ready to run.

**Architecture:**
- **Claude conducts, the CLI does the work.** A plugin skill does the interview and runs `agentmesh` CLI steps. The steps are new subcommands of `apps/cli`:
  - `setup render`, `setup status`, `setup discord`, `setup host`, `setup deploy`, `setup admin` and `setup invites`;
  - `doctor` and `upgrade`.
- **Answers are structured data.** Claude writes the answers to a zod-checked JSON file. Every config file is rendered from it by pure functions.
- **The CLI ships inside the plugin** as a second bundle, `dist/cli.js`.
- **Servers pull images.** CI publishes hub and bridge images to GHCR, and the rendered compose file pulls them.
- **The repo's own `deploy/docker-compose.yml` is not changed.** It keeps building from source, which keeps Opzami's live VM working. Setup renders its own compose file that pulls images. This is how the spec's "contributors build from source" holds without an override file.

**Tech Stack:** Node 24, TypeScript, zod 4, `yaml` 2.9.1, `@nats-io/nkeys`, nats.js v3 (`@agentmesh/bus`), vitest, tsup, GitHub Actions (docker buildx and QEMU).

**Spec:** `docs/specs/2026-10-23-setup-design.md`. Read it first; the section numbers (§) below refer to it.

## Global Constraints

- **File size:** no `.ts`/`.js` file over 300 lines (`pnpm check:size`).
- **Pure logic:** renderers, answer validation and check classification stay free of I/O.
- **Types:** zod at every boundary (the answers file, the state file, Discord API responses).
- **Secrets never printed:**
  - No CLI step prints a seed, the Discord token or any `.env` secret value, in output or in errors.
  - Claude is told never to read `deploy/.env` or `deploy/secrets/`, and never to ask for the token in chat.
- **No allow rules for operator commands.** Setup never adds allow rules for the CLI, `ssh` or `scp`. The skill uses `disable-model-invocation: true`.
- **Platforms:**
  - Windows, macOS and Linux admin machines.
  - Use the system `ssh`/`scp` and `docker` through `child_process.spawn` with `shell: false`.
  - Run `scp` with `cwd` set to the workspace and relative paths, so drive letters such as `G:` never look like a host.
- **Seed files:** mode 600, written with `writePrivateFile`. On the server, seeds are chowned to uid 1000.
- **`--dir` is required** by every `setup …`, `doctor` and `upgrade` command. Setup never writes into the current directory by accident.
- **Constants:**
  - `DEFAULT_IMAGE_REGISTRY = 'ghcr.io/p2ratik'`, `DEFAULT_MARKETPLACE = 'p2ratik/agentmesh'` and `DEFAULT_REMOTE_DIR = '/opt/agentmesh'`, defined once in `apps/cli/src/setup/defaults.ts`.
  - Discord bot permissions `326954470480`, scopes `bot+applications.commands`.
- **Versions:**
  - One version across every `package.json`, `plugin.json` and `VERSION` (Task 1).
  - The final task bumps everything to `0.4.0` and rebuilds `plugins/agentmesh/dist/`.
- **MCP SDK** stays pinned at `1.32.1`.
- **Docs, ADR and threat note** ship in this branch (Task 14).
- **Git:** commit on `agent/pratik/setup` only. Never push or open a PR unless Pratik asks.

## Review Focus

1. **The admin's laptop is already on another mesh** (Pratik's is on Opzami's).
   - Expected: `setup admin` refuses to replace `~/.agentmesh/agent.json` without `--replace`, and `setup render` never overwrites an existing seed.
   - Test in Task 8 and Task 4.
2. **Workspace paths with spaces or a drive letter** (`C:\Users\First Last\agentmesh\acme`).
   - Expected: `scp` and `docker` still get correct arguments.
   - Test in Task 7.
3. **The bot is in no server when the wait runs out, or in several.**
   - Expected: a clear next step, nothing half-written.
   - Test in Task 5.
4. **The token is pasted with quotes, spaces or a trailing newline** (`DISCORD_BOT_TOKEN="abc" `).
   - Expected: it is read correctly and never echoed.
   - Test in Task 3 and Task 5.
5. **A deploy fails half-way** (for example the images are missing).
   - Expected: `deploy` is not marked done, the error names `AGENTMESH_VERSION` and the registry, and a re-run continues.
   - Test in Task 7.

---

### Task 1: One version for every package

**Files:**
- Create: `packages/common/src/version.ts`, `packages/common/src/version.test.ts`
- Modify: `packages/common/src/index.ts` (export it); `plugins/agentmesh/src/server.ts:11`
- Modify: the `"version"` in `apps/{hub,discord-bridge,cli}/package.json` and `packages/{bus,common,config,protocol}/package.json`, set to `0.3.1`
- Also commit: `docs/specs/2026-10-23-setup-design.md`, `docs/specs/2026-10-23-setup-plan.md`

**Interfaces:**
- Produces: `export const VERSION: string` from `@agentmesh/common`. The plugin's `VERSION` re-exports it, and later tasks import it.

- [ ] **Step 1: Write the failing test** `packages/common/src/version.test.ts`
```ts
it('every package.json, the plugin manifest and VERSION agree', () => {
  const root = join(import.meta.dirname, '../../..');
  const files = [
    ...['apps/hub', 'apps/discord-bridge', 'apps/cli', 'packages/bus', 'packages/common',
        'packages/config', 'packages/protocol', 'plugins/agentmesh'].map((d) => `${d}/package.json`),
    'plugins/agentmesh/.claude-plugin/plugin.json',
  ];
  for (const f of files) expect(JSON.parse(readFileSync(join(root, f), 'utf8')).version, f).toBe(VERSION);
});
```
- [ ] **Step 2: Run it and check that it fails:** `pnpm vitest run packages/common/src/version.test.ts`. Expected: FAIL (VERSION is not defined).
- [ ] **Step 3: Implement.**
  - Add `export const VERSION = '0.3.1';` and export it from the index.
  - In `plugins/agentmesh/src/server.ts`, replace the literal with `export { VERSION } from '@agentmesh/common';`.
  - Set every listed `package.json` to `0.3.1`.
- [ ] **Step 4: Run** `pnpm vitest run packages/common plugins/agentmesh` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git add -A && git commit -m "One version for every package; add the setup design and plan"`

### Task 2: Setup answers, summary, mesh.yaml and policy renderers

**Files:**
- Create: `apps/cli/src/setup/defaults.ts`, `apps/cli/src/setup/answers.ts`, `apps/cli/src/setup/render/mesh-yaml.ts`, `apps/cli/src/setup/render/policy.ts`, `apps/cli/src/setup/render/summary.ts`
- Test: `apps/cli/src/setup/answers.test.ts`, `apps/cli/src/setup/render/mesh-yaml.test.ts`

**Interfaces:**
- Produces, in `answers.ts`:
```ts
export const Person = z.object({ id: ParticipantId, name: z.string().min(1).max(80),
  roles: z.array(z.string().min(1).max(40)).max(10).default([]),
  skills: z.array(z.string().min(1).max(40)).max(20).default([]),
  discordUsername: z.string().min(2).max(40) });
export const Hosting = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('server'), ssh: z.string().regex(/^[^@\s]+@[^@\s]+$/),
    publicHost: z.string().regex(/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i),
    remoteDir: z.string().regex(/^\/[A-Za-z0-9._/-]+$/).default(DEFAULT_REMOTE_DIR) }),
  z.object({ mode: z.literal('trial'), testAgent: z.boolean().default(false) }) ]);
export const SetupAnswers = z.object({ version: z.literal(1),
  team: z.object({ name: z.string().min(1).max(60), meshName: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
    overview: z.string().min(1).max(1200), repos: z.array(z.string()).default([]) }),
  admin: Person.extend({ githubUsername: z.string().regex(/^[A-Za-z0-9-]{1,39}$/).optional() }),
  people: z.array(Person).default([]),          // everyone except the admin
  decisions: z.object({ finalSay: ParticipantId, plansNeedApproval: z.boolean().default(true) }),
  areas: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*$/), description: z.string().min(1),
    owners: z.array(ParticipantId).min(1), skills: z.array(z.string()).default([]) })).min(1),
  git: z.object({ integrationBranch: z.string().default('agents'),
    protectedBranches: z.array(z.string()).default(['main']) }).prefault({}),
  hosting: Hosting }).superRefine(/* rules below */);
export type SetupAnswers = z.infer<typeof SetupAnswers>;
export function parseAnswers(raw: unknown): SetupAnswers;   // MeshError('invalid_request'), one "path: message" line per issue
export const agentIdOf = (personId: string): string => `${personId}-agent`;
```
- The `superRefine` rules:
  - person ids are unique across the admin and the people, and so are Discord usernames;
  - `decisions.finalSay` and every area owner is a person id;
  - no person id ends in `-agent`.
- Produces, in the renderers:
  - `renderMeshYaml(a: SetupAnswers): string`
  - `renderPolicy(a: SetupAnswers): { text: string; warnings: string[] }`
  - `renderAnswersSummary(a: SetupAnswers): string`
- Constants in `defaults.ts`: the global constants, plus `MAX_POLICY_CHARS = 2000` and `NATS_PORT = 4222`.

**What `renderMeshYaml` emits** (build a plain object and stringify it with `yaml`, behind a header comment saying the file came from `setup render` and can be edited, then `agentmesh validate` and `agentmesh setup deploy`):
- `mesh: { name: meshName, prefix: 'mesh' }`.
- `nats.servers`: `tls://<publicHost>:4222` for a server, `nats://127.0.0.1:4222` for a trial.
- `enrollment.natsUrl`: `tls://<publicHost>:4222`, on a server only.
- `hub: { dataDir: './data', http: { enabled: true, host: '0.0.0.0', port: 8787 } }`. No keys yet.
- `humans`: the admin only, with `roles: ['admin', ...admin.roles]` (deduplicated) and `displayName: admin.name`.
- `agents`:
  - `<admin>-agent` with the admin's skills, `displayName: "<Name>'s Claude"`, and `avatarUrl: https://github.com/<gh>.png` when a GitHub username is given;
  - for a trial with `testAgent`, also `<admin>-test-agent` with `displayName: "<Name>'s test Claude"`.
- `services`: only `discord-bridge` (`role: bridge, canActAsHumans: true`). No ingest sources (spec §5.5).
- `areas`: owners mapped through `agentIdOf`.
- `git`: from the answers, with `branchTemplate: "agent/{owner}/{task}-{slug}"` and `agentsMayMergeInto: [integrationBranch]`.
- `policy.instructionsFile: policy/team-policy.md`.
- `planning.requireApproval`: from the answers.
- `discord`: `enabled: true`, `token: ${DISCORD_BOT_TOKEN:-}`, `applicationId: ${DISCORD_APP_ID:-}`, `guildId: ${DISCORD_GUILD_ID:-}`, `provision: { enabled: true, category: 'Agent Mesh' }`.

**What `renderPolicy` emits**, in this order:
1. `## About <team>` with the overview, and the repos if any.
2. `## People`: one line per person, `<Name> (<id>-agent): <roles>`.
3. `## Decisions`: who has the final say and that agents escalate crucial decisions to them, plus, when `plansNeedApproval`, that plans wait for `/plan approve`.
4. `## Working rules`: the bullets of `config/examples/policy/team-policy.md` without its heading.

It adds a warning when the text is longer than `MAX_POLICY_CHARS`.

- [ ] **Step 1: Write failing tests.**
  - `answers.test.ts`:
    - `rejects an area owner who is not a person` (the message contains `areas.0.owners.0`);
    - `rejects the admin listed again in people`;
    - `rejects duplicate Discord usernames`;
    - `applies defaults` (`git.integrationBranch === 'agents'`, `remoteDir === '/opt/agentmesh'`).
  - `mesh-yaml.test.ts`: write `renderMeshYaml` and `renderPolicy().text` to a temp dir (`mesh.yaml`, `policy/team-policy.md`), then:
    - `server answers load cleanly`: `loadConfig(dir, { env: { DISCORD_BOT_TOKEN: 't', DISCORD_APP_ID: '1', DISCORD_GUILD_ID: '2' } })` succeeds (validation requires all three while `discord.enabled`, `packages/config/src/validate.ts:151`), `config.enrollment.natsUrl === 'tls://mesh.acme.dev:4222'`, and `config.ingest.sources` is empty;
    - `area owners become agents`: `config.areas[0].owners` equals `['dana-agent']` when the owner is `dana`;
    - `trial answers load cleanly`: there is no `enrollment.natsUrl`, `nats.servers[0] === 'nats://127.0.0.1:4222'`, and with `testAgent` `config.agents.map(a=>a.id)` includes `riya-test-agent`;
    - `the admin is an admin`: `humans[0].roles[0] === 'admin'`;
    - `long overview warns`: `renderPolicy` returns one warning.
- [ ] **Step 2: Run** `pnpm vitest run apps/cli/src/setup`. Expected: FAIL (the modules are missing).
- [ ] **Step 3: Implement** `defaults.ts`, `answers.ts`, the three renderers. `renderAnswersSummary` gives the team, the people with their roles and skills, the areas and owners, the hosting, and the decisions in at most 25 lines.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "CLI: setup answers schema and config renderers"`

### Task 3: Deploy-file renderers, `.env` editing, workspace state

**Files:**
- Create: `apps/cli/src/setup/render/deploy-files.ts`, `apps/cli/src/setup/env-file.ts`, `apps/cli/src/setup/workspace.ts`
- Test: `apps/cli/src/setup/render/deploy-files.test.ts`, `apps/cli/src/setup/env-file.test.ts`, `apps/cli/src/setup/workspace.test.ts`

**Interfaces:**
- Produces:
```ts
// deploy-files.ts (pure)
export function renderCompose(): string;   // repo compose with `image: ${AGENTMESH_IMAGE_REGISTRY}/agentmesh-hub:${AGENTMESH_VERSION}`
                                          // and agentmesh-discord-bridge; no build:
export function renderEnv(i: { hosting: Hosting; version: string; registry: string }): string;
export const WORKSPACE_GITIGNORE: string;  // "deploy/.env\ndeploy/secrets/\ndeploy/nats/nats.conf\n"
export function renderClaudeSettings(): string; // {"permissions":{"deny":["Read(./deploy/.env)","Read(./deploy/secrets/**)"]}}
// env-file.ts
export function parseEnv(text: string): Map<string, string>;   // strips surrounding quotes and whitespace; ignores comments
export function setEnvValues(text: string, values: Record<string, string>): string; // replaces KEY= lines in place, appends missing
export function readEnvFile(path: string): Map<string, string>;
export function updateEnvFile(path: string, values: Record<string, string>): void; // writePrivateFile(…, true)
// workspace.ts
export interface WorkspacePaths { root: string; answers: string; state: string; configDir: string; meshFile: string;
  policyFile: string; deployDir: string; compose: string; envFile: string; natsConf: string; secretsDir: string;
  gitignore: string; claudeSettings: string }
export function workspacePaths(root: string): WorkspacePaths;  // setup-answers.json, .agentmesh-setup.json, config/…, deploy/…
export const STEPS = ['render', 'discord', 'host', 'deploy', 'admin'] as const;
export type StepName = (typeof STEPS)[number];
export const SetupState = z.object({ version: z.literal(1), done: z.partialRecord(z.enum(STEPS), z.string()) });
export type SetupState = z.infer<typeof SetupState>;
export function readState(p: WorkspacePaths): z.infer<typeof SetupState>;  // missing file → { version: 1, done: {} }
export function markDone(p: WorkspacePaths, step: StepName, now: Date): void;
export function loadAnswers(p: WorkspacePaths): SetupAnswers;    // MeshError('not_found') when the file is missing
export type WriteOutcome = 'created' | 'unchanged' | 'differs' | 'replaced';
export function writeRendered(path: string, content: string, force: boolean): WriteOutcome;
```
- **`renderEnv` lines**, each with its comment on the line above (never an inline comment):
  - `DISCORD_BOT_TOKEN=` (empty), `DISCORD_APP_ID=`, `DISCORD_GUILD_ID=`;
  - `AGENTMESH_IMAGE_REGISTRY=<registry>`, `AGENTMESH_VERSION=<version>`, `AGENTMESH_CONFIG_DIR=../config`;
  - on a server: `NATS_BIND=0.0.0.0` and `NATS_PUBLIC_HOST=<publicHost>`; on a trial: `NATS_BIND=127.0.0.1` and `NATS_PUBLIC_HOST=`;
  - `HUB_HTTP_BIND=127.0.0.1` and `AGENTMESH_LOG_LEVEL=info`.
- **`renderCompose`** keeps the volumes, ports, aliases, environment and `profiles: [discord]` of `deploy/docker-compose.yml`.

- [ ] **Step 1: Write failing tests.**
  - `parseEnv` reads `DISCORD_BOT_TOKEN="abc" \n` as `abc`, and `'x'` as `x`.
  - `setEnvValues` keeps comments and the order, replaces `DISCORD_APP_ID=` in place, and appends an unknown key at the end.
  - `writeRendered` returns `created`, then `unchanged`; it returns `differs` and leaves the file untouched when the content changed; it returns `replaced` with `force`.
  - `readState` on an empty dir returns `{ version: 1, done: {} }`; `markDone` round-trips.
  - `renderCompose` contains no `build:`, and does contain `image: ${AGENTMESH_IMAGE_REGISTRY}/agentmesh-hub:${AGENTMESH_VERSION}`.
  - `renderEnv` for a server has the line `NATS_PUBLIC_HOST=mesh.acme.dev`, and no line has text after the value.
- [ ] **Step 2: Run** `pnpm vitest run apps/cli/src/setup`. Expected: FAIL.
- [ ] **Step 3: Implement** the three modules.
- [ ] **Step 4: Run** it again. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "CLI: workspace files, .env editing and setup state"`

### Task 4: `setup render` and `setup status`

**Files:**
- Create: `apps/cli/src/lib/keys.ts`, `apps/cli/src/lib/nats-config-file.ts`, `apps/cli/src/commands/setup/render.ts`, `apps/cli/src/commands/setup/status.ts`, `apps/cli/src/setup/render/status.ts`
- Modify: `apps/cli/src/commands/keys.ts` and `apps/cli/src/commands/nats-config.ts` (call the extracted helpers; behaviour unchanged); `apps/cli/src/main.ts` (register the commands)
- Test: `apps/cli/src/commands/setup/render.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces:
```ts
// lib/keys.ts — extracted from keysAddCommand
export interface AddedKey { holder: KeyHolder; publicKey: string; seedFile: string }
export function addKey(meshFile: string, secretsDir: string, id: string, opts: { force: boolean }): AddedKey;
// lib/nats-config-file.ts — extracted from natsConfigCommand
export function writeNatsConfig(i: { configPath: string; env: Env; out: string; tls: boolean; callout: boolean;
  dev?: boolean; maxFileStore?: string; allowMissing?: boolean }): NatsConfigResult;
export const setupRenderCommand: Command;  // name 'setup render'
export const setupStatusCommand: Command;  // name 'setup status'
export function renderStatus(state: SetupState, answers: SetupAnswers | null): string;  // pure; ends with "Next: …"
```
- `setup render --dir <ws> [--registry <r>] [--dry-run] [--force]`:
  1. `loadAnswers`. With `--dry-run`, print `renderAnswersSummary` and exit 0, writing nothing.
  2. If `state.done.render` and no `--force`, print `Already rendered on <date>. The files in <ws> are now the source of truth; edit them, or re-render with --force.` and exit 0.
  3. `writeRendered` for `mesh.yaml`, the policy, the compose file, `.gitignore` and `.claude/settings.json`.
     - It writes `.env` only when the file is missing, even with `--force`, because `.env` holds the token.
     - It prints each policy warning to stderr.
  4. Keys.
     - **Server:** `hub`, `discord-bridge`, `hub-issuer`, `hub-xkey` and `hub-sys` into `deploy/secrets`.
     - **Always:** `<admin>-agent` (and `<admin>-test-agent` for a trial with `testAgent`) into `<home>/.agentmesh`.
     - A holder that already has a key in `mesh.yaml` is skipped.
     - An existing seed file is never overwritten: `addKey` already uses `wx`, and the error says to use `agentmesh keys add <id> --force` on purpose.
  5. `writeNatsConfig`: `tls` and `callout` for a server; neither for a trial. `out` is `deploy/nats/nats.conf`.
  6. `loadConfig` of `meshFile` must succeed. The env comes from `readEnvFile(.env)` (as a plain object), with each empty `DISCORD_BOT_TOKEN`, `DISCORD_APP_ID` or `DISCORD_GUILD_ID` filled with `SECRET_PLACEHOLDER` from `lib/config-files.ts`. They are only known after `setup discord`, and the full check without placeholders runs in `setup deploy` (Task 7).
  7. `markDone('render')`. Print the files written and `Next: paste your Discord bot token into <envFile> after DISCORD_BOT_TOKEN=, save it, then run setup discord. Never paste the token into the chat.`
- `setup status --dir <ws>` prints `renderStatus`.
  - The next step follows the `STEPS` order. On a trial, `host` is skipped.
  - After `admin`, the next step reads `run doctor, then /agentmesh:activate, then setup invites`.

- [ ] **Step 1: Write failing tests** in `render.test.ts`, using the `harness()` pattern from `cli.test.ts` with `homeDir` inside the temp dir:
  - `renders a server workspace`: exit 0; `deploy/secrets/{hub,discord-bridge,hub-issuer,hub-xkey,hub-sys}.nk` exist; `home/.agentmesh/riya-agent.nk` exists; `nats.conf` contains `tls {` and `auth_callout`; `loadConfig` sees `config.hub.authCallout?.issuer` starting with `A`.
  - `renders a trial workspace`: `nats.conf` contains no `tls {`; the agent keys are in it; there is no `deploy/secrets/hub-issuer.nk`.
  - `--dry-run writes nothing`: the workspace has only `setup-answers.json`.
  - `a second run changes nothing`: the file hashes and the seed contents are identical, and the output contains `Already rendered`.
  - `--force keeps .env and the keys`: write `DISCORD_BOT_TOKEN=tok` into `.env`, re-run with `--force`; `.env` still contains `tok`, and the seeds are unchanged.
  - `an existing admin seed is not overwritten` (Review Focus 1): pre-create `home/.agentmesh/riya-agent.nk`; the exit code is 1, the error mentions `keys add riya-agent --force`, and the file is unchanged.
  - The existing `cli.test.ts` end-to-end test still passes (the extraction keeps behaviour).
- [ ] **Step 2: Run** `pnpm vitest run apps/cli`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the extraction, the commands and `renderStatus`.
- [ ] **Step 4: Run** `pnpm vitest run apps/cli`. Expected: PASS, including `cli.test.ts`.
- [ ] **Step 5: Commit:** `git commit -m "CLI: setup render and setup status"`

### Task 5: Discord API client and `setup discord`

**Files:**
- Create: `apps/cli/src/setup/discord-api.ts`, `apps/cli/src/commands/setup/discord.ts`
- Modify: `apps/cli/src/context.ts` (optional `fetch?: typeof fetch` and `sleep?: (ms: number) => Promise<void>` on `CliContext`); `apps/cli/src/lib/mesh-document.ts`; `apps/cli/src/main.ts`
- Test: `apps/cli/src/setup/discord-api.test.ts`, `apps/cli/src/commands/setup/discord.test.ts`

**Interfaces:**
- Produces:
```ts
export const DISCORD_API = 'https://discord.com/api/v10';
export interface DiscordApi {
  me(): Promise<{ id: string; username: string }>;
  application(): Promise<{ id: string; name: string }>;
  guilds(): Promise<Array<{ id: string; name: string }>>;
  guild(id: string): Promise<{ id: string; name: string; owner_id: string }>;
  user(id: string): Promise<{ id: string; username: string }>;
  channels(guildId: string): Promise<Array<{ id: string; name: string; type: number; parent_id: string | null }>>;
}
export function discordApi(token: string, fetchImpl: typeof fetch): DiscordApi;  // header `Authorization: Bot <token>`; zod-parses bodies
export function botInviteUrl(appId: string): string;
  // https://discord.com/oauth2/authorize?client_id=<id>&scope=bot+applications.commands&permissions=326954470480
export function setHumanDiscordId(text: string, humanId: string, discordUserId: string): string; // mesh-document.ts, Document API
export const setupDiscordCommand: Command;  // 'setup discord'
```
- **API errors:** a 401 or 403 becomes `MeshError('unauthenticated', 'Discord rejected the bot token in deploy/.env (<status>). Reset it in the developer portal, paste the new one into the file and run again.')`. Any other status becomes `MeshError('unavailable', 'Discord API <path> answered <status>')`. No message ever contains the token.
- **`setup discord --dir <ws> [--guild <id>] [--admin-discord-id <id>] [--wait-seconds 300]`:**
  1. Read `DISCORD_BOT_TOKEN` with `readEnvFile`. If it is empty, exit 1 with `Paste your bot token into <envFile> after DISCORD_BOT_TOKEN=, save, and run again. Do not paste it into the chat.`
  2. `me()`, then `application()`, then `updateEnvFile({ DISCORD_APP_ID })`. Print `Bot: <username>` and `Add the bot to your server: <botInviteUrl>`.
  3. Poll `guilds()` every 3 s through `ctx.sleep`, until there is at least one or the wait runs out.
     - None found: exit 1 with `The bot is not in a server yet. Open the link above, add it, and run setup discord again.`
     - More than one, and no `--guild`: exit 1, listing `<name> (<id>)` and `run again with --guild <id>`.
     - `--guild` given but not in the list: exit 1.
  4. Read the chosen guild with `guild(id)`, then `user(owner_id)`, then `updateEnvFile({ DISCORD_GUILD_ID })`.
  5. The admin's Discord id is `--admin-discord-id`, or else `owner_id`. Write it into `mesh.yaml` with `setHumanDiscordId`. Print `Admin Discord account: <username> (<the server owner | given>). If that is not you, run again with --admin-discord-id <your id>.`
  6. `markDone('discord')`.

- [ ] **Step 1: Write failing tests** with a fake `fetch` that routes on the URL path and records requests:
  - `sends the bot token only in the Authorization header`;
  - `401 → unauthenticated, message has no token`: the token `tok-SECRET-123` appears in neither `error.message` nor the CLI output;
  - `fills DISCORD_APP_ID and DISCORD_GUILD_ID and the admin's discordUserId`;
  - `reads a quoted token with trailing spaces` (Review Focus 4);
  - `waits, then gives up when the bot joins no server` (Review Focus 3): fake `sleep` resolves at once, the exit code is 1, `DISCORD_GUILD_ID` stays empty, and state has no `discord`;
  - `several servers without --guild lists them`;
  - `--admin-discord-id wins over the owner`.
- [ ] **Step 2: Run** `pnpm vitest run apps/cli/src`. Expected: FAIL.
- [ ] **Step 3: Implement** it, with real defaults `ctx.fetch ?? fetch` and `ctx.sleep ?? (ms) => setTimeout promise`.
- [ ] **Step 4: Run** it again. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "CLI: setup discord checks the bot and finds the server"`

### Task 6: Process runner, DNS check and `setup host`

**Files:**
- Create: `apps/cli/src/lib/process.ts`, `apps/cli/src/setup/remote.ts`, `apps/cli/src/setup/render/host-script.ts`, `apps/cli/src/setup/checks/result.ts` (`CheckResult`), `apps/cli/src/setup/checks/dns.ts`, `apps/cli/src/commands/setup/host.ts`
- Modify: `apps/cli/src/context.ts` (optional `run?: RunProcess` and `lookup?: (host: string) => Promise<string[]>`); `apps/cli/src/main.ts`
- Test: `apps/cli/src/setup/render/host-script.test.ts`, `apps/cli/src/commands/setup/host.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ProcessResult { code: number; stdout: string; stderr: string }
export type RunProcess = (cmd: string, args: readonly string[], opts?: { input?: string; cwd?: string }) => Promise<ProcessResult>;
export const runProcess: RunProcess;   // spawn, shell:false; ENOENT → { code: 127, stderr: `${cmd} not found on PATH` }
// remote.ts
export const SSH_OPTIONS: readonly string[];   // ['-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new']
export function sshUser(target: string): string;          // 'mesh@host' → 'mesh'
export async function runChecked(run: RunProcess, cmd: string, args: readonly string[],
  opts: { input?: string; cwd?: string } | undefined, what: string): Promise<ProcessResult>;
  // non-zero → MeshError('unavailable', `${what} failed (exit N):\n<last 20 stderr lines>`)
export function renderHostScript(i: { publicHost: string; remoteDir: string; user: string }): string;
export interface CheckResult { ok: boolean; label: string; detail?: string }
export async function checkDns(host: string, lookup: (h: string) => Promise<string[]>): Promise<CheckResult>;
export const setupHostCommand: Command;   // 'setup host'
```
- **`renderHostScript`** is a bash script with the values baked in, single-quoted. It follows `deploy/azure/vm-setup.sh` with these differences:
  - `set -euo pipefail`;
  - it refuses to run without `apt-get` ("Ubuntu 24.04 is the tested target");
  - it does not install `git`;
  - it creates `<dir>`, `<dir>/deploy`, `<dir>/deploy/nats`, `<dir>/deploy/secrets` and `<dir>/config`, owned by `<user>`;
  - it adds `<user>` to the `docker` group;
  - the renewal hook (the same one) uses `<dir>/deploy/docker-compose.yml`;
  - it runs `certbot certonly --standalone` only when `/etc/letsencrypt/live/<host>` is missing, then runs the hook.
- **`setup host --dir <ws>`:**
  - On a trial it prints `Nothing to do on a trial.`, marks `host` done and exits 0.
  - Otherwise it runs `checkDns(publicHost)`. On failure it exits 1 with `DNS for <host> does not resolve yet. Point an A record at the server, wait a minute, and run again.`
  - Then it runs `runChecked(run, 'ssh', [...SSH_OPTIONS, ssh, 'sudo bash -s'], { input: script }, 'Preparing the server')` and marks `host` done.

- [ ] **Step 1: Write failing tests.**
  - The host script contains `certbot certonly --standalone`, `'mesh.acme.dev'` and `/opt/agentmesh/deploy/docker-compose.yml`, and has no `git`. `bash -n` passes on it when bash exists (`it.skipIf(!hasBash)`).
  - `setup host` with a fake `run` records `ssh` with `BatchMode=yes` and `sudo bash -s`, and the script arrives as input.
  - DNS failure means no ssh call and exit 1.
  - On a trial, no ssh call.
  - A non-zero ssh exit means `host` is not marked done, and the output includes the stderr tail.
- [ ] **Step 2: Run** `pnpm vitest run apps/cli/src`. Expected: FAIL.
- [ ] **Step 3: Implement** it. `lookup` defaults to `dns.promises.lookup(host, { all: true })` mapped to its addresses.
- [ ] **Step 4: Run** it again. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "CLI: setup host prepares any Ubuntu server over SSH"`

### Task 7: `setup deploy` and `upgrade`

**Files:**
- Create: `apps/cli/src/setup/deploy.ts`, `apps/cli/src/commands/setup/deploy.ts`, `apps/cli/src/commands/upgrade.ts`
- Modify: `apps/cli/src/main.ts`
- Test: `apps/cli/src/commands/setup/deploy.test.ts`

**Interfaces:**
- Consumes: `RunProcess`, `runChecked`, `SSH_OPTIONS` (Task 6); `workspacePaths`, `readEnvFile`/`updateEnvFile`, `markDone` (Task 3).
- Produces:
```ts
export function remoteCommands(dir: string): { prepare: string; finish: string };   // pure, see below
export async function deployWorkspace(ctx: CliContext, p: WorkspacePaths, a: SetupAnswers): Promise<void>;
export const setupDeployCommand: Command;   // 'setup deploy'
export const upgradeCommand: Command;       // 'upgrade'
```
- `remoteCommands('/opt/agentmesh')`:
  - **prepare:** `sudo chown -R "$(id -u):$(id -g)" /opt/agentmesh/deploy/secrets && mkdir -p /opt/agentmesh/deploy/secrets /opt/agentmesh/deploy/nats /opt/agentmesh/config`
  - **finish:** `chmod 600 /opt/agentmesh/deploy/.env && sudo chown 1000:1000 /opt/agentmesh/deploy/secrets/*.nk && sudo chmod 600 /opt/agentmesh/deploy/secrets/*.nk && cd /opt/agentmesh/deploy && docker compose --profile discord pull && docker compose --profile discord up -d`
- **`deployWorkspace` first checks the config.** `loadConfig` of the workspace config must succeed with the real `.env` values and no placeholders, which catches a missing token, application id or server id. Any issue fails the deploy before anything is copied.
- **`deployWorkspace` on a server.** It needs `discord` and `host` done; otherwise it fails with the step to run. Then, every `scp` with `cwd: p.root` and relative paths:
  1. `ssh prepare`;
  2. `scp -q -r config <t>:<dir>/`;
  3. `scp -q deploy/docker-compose.yml deploy/.env <t>:<dir>/deploy/`;
  4. `scp -q deploy/nats/nats.conf <t>:<dir>/deploy/nats/`;
  5. `scp -q deploy/secrets/<each>.nk … <t>:<dir>/deploy/secrets/`;
  6. `ssh finish`.
- **On a trial**, it needs `discord` done, then runs `docker compose --profile discord pull` and `docker compose --profile discord up -d` with `cwd: p.deployDir`.
- **A failure** in a pull step is rethrown with the extra line `Check that <registry>/agentmesh-hub:<version> exists (AGENTMESH_IMAGE_REGISTRY and AGENTMESH_VERSION in deploy/.env).`
- **Success** calls `markDone('deploy')`.
- **`upgrade --dir <ws> [--to <version>]`** sets `AGENTMESH_VERSION` to `--to ?? VERSION`, prints `Hub version <old> → <new>`, then runs `deployWorkspace`.

- [ ] **Step 1: Write failing tests** with a fake `run` that records `(cmd, args, cwd)`:
  - `server deploy runs prepare, the copies, then finish`: the exact sequence of `cmd`s, and every scp arg that is not a remote target is relative, not absolute.
  - `a workspace path with a space and a drive letter` (Review Focus 2): `p.root = 'C:\\Users\\First Last\\agentmesh\\acme'` (built with `path.win32` in the test); every scp call has `cwd === p.root`, and no arg contains `C:`.
  - `a failed pull is not marked done and names the image` (Review Focus 5): the fake returns code 1 for the finish command; state has no `deploy`; stderr contains `` `ghcr.io/p2ratik/agentmesh-hub:${VERSION}` `` (import `VERSION`; never hard-code it, since Task 14 bumps it); a second run with a passing fake marks it done.
  - `an empty token fails before anything is copied`: `.env` has `DISCORD_BOT_TOKEN=`; the fake `run` is never called and the error names `discord.token`.
  - `trial deploy runs docker compose in deploy/`.
  - `upgrade moves the pin and deploys`: `.env` has `AGENTMESH_VERSION=0.9.0` after `--to 0.9.0`, and the deploy commands ran.
  - `refuses before discord is done`.
- [ ] **Step 2: Run** `pnpm vitest run apps/cli/src`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it again. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "CLI: setup deploy and upgrade with published images"`

### Task 8: `setup admin` and the plugin's `connect` tool

**Files:**
- Create: `packages/common/src/agent-files.ts`; `apps/cli/src/commands/setup/admin.ts`; `plugins/agentmesh/src/join/connect-tool.ts`
- Modify: `packages/common/src/index.ts`; `plugins/agentmesh/src/join/files.ts` (import `agentmeshDir` and `existingMesh` from common and delete the local copies); `plugins/agentmesh/src/main.ts` (unenrolled mode lists and dispatches `connect`); `apps/cli/src/main.ts`
- Test: `apps/cli/src/commands/setup/admin.test.ts`, `plugins/agentmesh/src/join/connect-tool.test.ts`

**Interfaces:**
- Produces:
```ts
// packages/common/src/agent-files.ts — moved unchanged from the plugin
export const agentmeshDir: (home: string) => string;
export function existingMesh(home: string): { agentId?: string; natsUrl?: string } | null;
// apps/cli
export const setupAdminCommand: Command;   // 'setup admin'
// plugins/agentmesh/src/join/connect-tool.ts
export const CONNECT_TOOL = 'connect';
export const connectToolListing: { name: string; description: string; inputSchema: object };
export async function callConnectTool(deps: { resolve: () => ConfigResult;
  onConnected: (agentId: string) => Promise<void> }): Promise<CallToolResult>;
```
- **`setup admin --dir <ws> [--replace]`:**
  - The agent id is `<admin>-agent`. The NATS URL is `tls://<publicHost>:4222` on a server and `nats://127.0.0.1:4222` on a trial. The seed is `<home>/.agentmesh/<agent>.nk` and must exist; otherwise the error says to run `setup render`.
  - If `existingMesh(home)` names another agent id or URL and there is no `--replace`, exit 1 with `This laptop is already set up as <agent> on <url>. Run again with --replace to switch it to <team>; that agent stops working here.`
  - Write `agent.json` with `agentJson(…)` from `render/agent-setup.ts`, using `writePrivateFile(…, true)`.
  - Print `Saved <home>/.agentmesh/agent.json for <agent>. In Claude Code, call the AgentMesh connect tool, or restart Claude Code with the channel flag. Then run /agentmesh:activate.` With `--replace`, it adds `Restart Claude Code: the running plugin is still connected to the old mesh.`
  - On a trial with a test agent, it also prints the `agentmesh agent-setup <admin>-test-agent --config <ws>/config --nats-url nats://127.0.0.1:4222 --seed-file <home>/.agentmesh/<admin>-test-agent.nk` hint.
  - `markDone('admin')`.
- **`connect`:**
  - The description is `Connect this session with the settings that agentmesh setup saved in ~/.agentmesh/agent.json.`
  - If `resolve()` is not ok, it returns `isError` with the problems.
  - Otherwise it awaits `onConnected(config.agentId)` and returns `Connected as <agent>. Run /agentmesh:activate.`
  - In `main.ts` `runUnenrolled`, `onConnected` is the existing `onJoined`.

- [ ] **Step 1: Write failing tests.**
  - `admin.test.ts`:
    - `writes agent.json for a server`: it has `natsUrl === 'tls://mesh.acme.dev:4222'` and `nkeySeed` ends with `riya-agent.nk`.
    - `refuses another mesh without --replace` (Review Focus 1): pre-write `agent.json` for `pratik-agent` on `nats://other:4222`; the exit code is 1 and the file is unchanged. With `--replace`, it is replaced and the output contains `Restart Claude Code`.
    - `missing seed points at setup render`.
  - `connect-tool.test.ts`: an unresolved config gives `isError` with the problems listed; a resolved one calls `onConnected('riya-agent')` once.
  - `files.ts`'s existing tests still pass.
- [ ] **Step 2: Run** `pnpm vitest run apps/cli/src plugins/agentmesh/src packages/common`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it again, plus `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "Setup admin saves the admin's agent; the plugin connects without a restart"`

### Task 9: `doctor`

**Files:**
- Create: `apps/cli/src/setup/checks/nats-tls.ts`, `apps/cli/src/setup/checks/containers.ts`, `apps/cli/src/setup/checks/discord.ts`, `apps/cli/src/setup/checks/agent.ts`, `apps/cli/src/setup/render/checklist.ts`, `apps/cli/src/commands/doctor.ts`
- Modify: `apps/cli/src/main.ts`
- Test: `apps/cli/src/setup/checks/checks.test.ts`, `apps/cli/src/commands/doctor.test.ts`

**Interfaces:**
- Consumes: `CheckResult`, `checkDns` (Task 6); `DiscordApi` (Task 5); `RunProcess`.
- Produces:
```ts
export function classifyCert(c: { authorized: boolean; authorizationError?: string; validTo: string }, host: string, now: Date): CheckResult;
  // ok label: `<host>:4222 answers TLS (cert valid to <d MMM yyyy>)`; < 14 days left → ok:false, detail "renewal is failing…"
export async function checkNatsTls(host: string, port: number, now: Date, timeoutMs?: number): Promise<CheckResult>;
  // net.connect → read first line `INFO {…}`; no tls_required/tls_available → fail; else tls.connect({ socket, servername: host })
export function classifyContainers(psJsonLines: string): CheckResult[];  // `docker compose ps --format json` (one JSON object per line)
  // expects nats, hub, discord-bridge with State "running"; hub Health "healthy"
export function classifyChannels(channels: Array<{ name: string; type: number; parent_id: string | null }>,
  category: string, expected: Record<string, { name: string; type: 'text' | 'forum' }>): CheckResult;
  // category type 4; text 0, forum 15; label `Discord: category, 7 channels and the planning forum exist`
export async function checkAgentConnects(natsUrl: string, seedFile: string, agentId: string): Promise<CheckResult>;
  // connectOnce({ servers:[natsUrl], name:`doctor-${agentId}`, credentials:{ nkeySeed: seedFile } }) then close
export function renderChecklist(team: string, results: CheckResult[]): string;
  // first line "AgentMesh is live for <team>" when all ok, else "AgentMesh for <team>: <n> problem(s)"; ✓ / ✗ lines, ✗ followed by "   → <detail>"
export const doctorCommand: Command;   // 'doctor --dir <ws>'
```
- **What `doctor` runs on a server:** `checkDns`, `checkNatsTls`, then the containers check over `ssh <t> "cd <dir>/deploy && docker compose --profile discord ps --format json"`. Then the Discord channels, using the token from `.env` and the channel defaults from the loaded config (`config.discord.channels`, `config.discord.provision.category`). Last, `checkAgentConnects`.
- **On a trial** it skips DNS and TLS, and runs `docker compose` locally.
- **Exit code:** 0 when every check passes, else 1. Doctor never changes state.

- [ ] **Step 1: Write failing tests.**
  - `classifyCert`: a certificate expiring in 60 days passes, with the date in the label; one expiring in 5 days fails; `authorized: false` fails, with the authorization error in the detail.
  - `checkNatsTls` against a local `net` server that writes `INFO {"tls_required":false}\r\n` fails with the detail `NATS does not offer TLS`.
  - `classifyContainers`: all three running and the hub healthy pass; a hub in `starting` fails with `docker compose logs hub` in the detail; a missing bridge fails.
  - `classifyChannels`: the full set passes; a missing `mesh-alerts` names it.
  - `doctor` on a trial with fakes for `run` and `fetch` prints `AgentMesh is live for Acme`.
- [ ] **Step 2: Run** `pnpm vitest run apps/cli/src`. Expected: FAIL.
- [ ] **Step 3: Implement** it. Every socket gets a 5 s timeout, and every socket is destroyed when done.
- [ ] **Step 4: Run** it again. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "CLI: doctor checks DNS, TLS, containers, Discord and the admin's key"`

### Task 10: `setup invites`

**Files:**
- Create: `apps/cli/src/setup/render/invites.ts`, `apps/cli/src/commands/setup/invites.ts`
- Modify: `apps/cli/src/main.ts`
- Test: `apps/cli/src/setup/render/invites.test.ts`

**Interfaces:**
- Produces:
```ts
export function renderInviteLines(a: SetupAnswers): string[];
export function renderJoinNote(i: { team: string; marketplace: string; publicHost: string }): string;
export const setupInvitesCommand: Command;   // 'setup invites --dir <ws> [--marketplace <src>]'
```
- **One invite line per `people` entry:**
  `/mesh invite user:@<discordUsername> id:<id> name:<name>`, then ` roles:<a,b>` and ` skills:<x,y>` when they are not empty. Admins in `people` get `admin` among their roles.
- **The join note**, as a numbered list:
  1. Join the `<team>` Discord server and allow DMs from its members.
  2. `claude plugin marketplace add <marketplace>` and `claude plugin install agentmesh@agentmesh`.
  3. Add `"mcp__plugin_agentmesh_mesh__*"` to `permissions.allow` in `~/.claude/settings.json`, and leave the plugin options empty.
  4. When the invite DM arrives, save the code to `~/.agentmesh/invite.txt`, never in a chat.
  5. Start `claude --dangerously-load-development-channels plugin:agentmesh@agentmesh`.
  6. Run `/agentmesh:join` and confirm that the hub is `<publicHost>:4222`.
  7. Run `/agentmesh:activate`.

  It ends with `Install first: codes expire 24 hours after the invite.`
- **The command:**
  - On a trial it prints `Teammates cannot join a trial on this machine. Run setup again with a server to invite them.` and exits 0.
  - Otherwise it prints `Run these in Discord (admins only):`, the lines, a blank line, then `Send your teammates:` and the note.
  - The marketplace defaults to `DEFAULT_MARKETPLACE`.

- [ ] **Step 1: Write failing tests.**
  - The exact line for `{ id:'sagar', name:'Sagar', discordUsername:'sagar_c', roles:['product','quality'], skills:['frontend'] }` is `/mesh invite user:@sagar_c id:sagar name:Sagar roles:product,quality skills:frontend`.
  - A person with no roles or skills gets no `roles:` or `skills:`.
  - The note contains `mesh.acme.dev:4222` and `p2ratik/agentmesh`.
  - On a trial the output contains `cannot join a trial`.
- [ ] **Step 2: Run** `pnpm vitest run apps/cli/src/setup`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it again. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "CLI: setup invites prints the invite lines and the join note"`

### Task 11: Secret-leak test over the whole flow

**Files:**
- Test: `apps/cli/src/setup/no-secrets.test.ts`

**Interfaces:**
- Consumes: every command from Tasks 4–10, through `runCli`.

- [ ] **Step 1: Write the test** `no step prints a secret`, for the server answers, with fake `fetch`, `run`, `sleep` and `lookup`. Fake `ssh ps` returns healthy containers, and fake `fetch` returns a guild with every channel.
  1. Run `setup render`, then write `DISCORD_BOT_TOKEN=tok-SECRET-123` into `.env`.
  2. Run `setup discord`, `setup host`, `setup deploy`, `setup admin`, `setup invites`, `doctor` and `setup status`. Also run `setup discord` with a fake 401, so the error path is covered.
  3. Collect every stdout and stderr string, plus every `args` and `input` passed to the fake `run`.
  4. Assert that none contains `tok-SECRET-123` or the content of any `.nk` file under the workspace or the home directory (read them after the run).
- [ ] **Step 2: Run** `pnpm vitest run apps/cli/src/setup/no-secrets.test.ts`. Expected: PASS. If it fails, fix the step that leaks; never weaken the test.
- [ ] **Step 3: Commit:** `git commit -m "Test: no setup step prints a secret"`

### Task 12: Ship the CLI in the plugin, the `/agentmesh:setup` skill, the end-to-end test

**Files:**
- Create: `apps/cli/src/index.ts`; `plugins/agentmesh/src/cli.ts`; `plugins/agentmesh/skills/setup/SKILL.md`; `tests/integration/setup.e2e.test.ts`
- Modify:
  - `apps/cli/package.json`: `"exports": { ".": "./src/index.ts" }`.
  - `apps/cli/src/context.ts`: add `processContext(): CliContext`, moved out of `main.ts`; `main.ts` uses it.
  - `plugins/agentmesh/package.json`: add `"@agentmesh/cli": "workspace:*"`.
  - `plugins/agentmesh/tsup.config.ts`: `entry: { server: 'src/main.ts', cli: 'src/cli.ts' }`.
  - `plugins/agentmesh/README.md`.
  - `tests/integration/support.ts`: `export const PLUGIN_CLI = …/dist/cli.js`.

**Interfaces:**
- Produces: `apps/cli/src/index.ts` exports `runCli`, `processContext` and `COMMANDS`. The plugin entry `src/cli.ts` runs `runCli(process.argv.slice(2), processContext()).then((c) => process.exit(c))`.

**The skill `plugins/agentmesh/skills/setup/SKILL.md`.**
- **Frontmatter:** `name: setup`; `description: Set up AgentMesh for your team: the hub, Discord and your own agent.`; `disable-model-invocation: true`; and no `allowed-tools`.
- **In the body, every CLI call is written exactly** as `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <command> --dir "<workspace>"`.
- **The body must contain these rules verbatim:**
  - "Never ask the user to paste the Discord bot token, an invite code or any key into this chat. If they paste one anyway, do not repeat it; tell them to reset it in the Discord developer portal and to put the new one in the file."
  - "Never open, read, print or search `deploy/.env` or anything in `deploy/secrets/`."
  - "Never add permission allow rules for this CLI, ssh or scp."
  - "Agents cannot run `/mesh` admin commands. You print the invite lines; the admin runs them in Discord."
  - "Create nothing that costs money until the user says yes to the server size you proposed."
- **The body's steps, in order:**
  0. Run `setup status` when a workspace already exists; continue from its `Next`. Otherwise ask where to keep the workspace (default `~/agentmesh/<team>`). Tell the admin that this session must have been started with `claude --dangerously-load-development-channels plugin:agentmesh@agentmesh`, and that if it wasn't, they should restart that way first.
  1. **About you,** one topic at a time, exactly as spec §4 step 1. Propose ids, skills, areas and policy, then write `setup-answers.json` with the Write tool (its schema is listed in the skill as a JSON example). Run `setup render --dry-run`, show the summary, and wait for a yes.
  2. **Where.** Offer the three options from spec §4 step 2.
     - **New cloud server.** Check the CLI with `az account show`, `aws sts get-caller-identity`, `gcloud config get-value account`, `doctl account get` or `hcloud context active`. Propose exactly the server spec in §5.5 and ask for a yes. Run the provider commands one at a time; `deploy/azure/provision.sh` is the reference for Azure.
     - Put the result into `hosting`. AWS needs the admin's own domain.
  3. **Render.** Run `setup render`.
  4. **Discord.** Follow the portal steps from spec §4 step 3, then `setup discord` until it succeeds. Ask the admin to confirm the printed Discord account is theirs; if not, re-run with `--admin-discord-id`.
  5. **Launch.** Run `setup host` (server only), then `setup deploy`.
  6. **You join.** Run `setup admin`, then call the AgentMesh `connect` tool (or ask the admin to restart with the flag), then run `/agentmesh:activate`.
  7. **Proof.**
     - Run `doctor`, then call `peers` and confirm the admin's agent is listed.
     - Call `broadcast` with `AgentMesh is set up for <team>. Hello from <agent>.`
     - Ask the admin whether they see it in `#mesh-council`.
     - Print the combined checklist in the spec §7 format.
  8. **Your team.** Run `setup invites`, show its output, and explain the order: teammates install first, the admin runs the lines.
- **On any failure:** show the CLI's message, fix the cause with the admin, and re-run the same step. Never edit the files by hand to get around a failing step.

**The end-to-end test `tests/integration/setup.e2e.test.ts`** (skip unless `AGENTMESH_TEST_NATS_BIN` exists and `PLUGIN` and `PLUGIN_CLI` are built):
1. `node PLUGIN_CLI --help` exits 0 and lists `setup render`.
2. Write trial answers into a temp workspace, with `HOME`/`USERPROFILE` set to a temp home. Run `node PLUGIN_CLI setup render --dir <ws>`.
3. Patch the rendered `nats.conf` the way `mesh.auth.e2e.test.ts` does (port, monitoring line, JetStream dir), and start nats-server.
4. `loadConfig(<ws>/config)`, then `createHub` with `<ws>/deploy/secrets/hub.nk`. Override `nats.servers` with the test URL.
5. `spawnAgent({ agentId:'', natsUrl:'', prefix:'mesh', home })`, which is unenrolled.
6. Run `setup admin --dir <ws>`, after rewriting `agent.json`'s `natsUrl` to the test URL.
7. Call `connect`, then `peers`. The result lists `riya-agent`.

- [ ] **Step 1: Write the e2e test** and `apps/cli/src/index.ts`.
- [ ] **Step 2: Run** `pnpm --filter @agentmesh/plugin build`, then `pnpm test:integration`. Expected: the setup test FAILs, because `dist/cli.js` is missing or `connect` is not dispatched.
- [ ] **Step 3: Implement** the export, the plugin entry, the tsup entry and the skill. Then rebuild with `pnpm --filter @agentmesh/plugin build`.
- [ ] **Step 4: Run** `pnpm test:integration` (with `AGENTMESH_TEST_NATS_BIN` set) and `pnpm check`. Expected: PASS. Also run `node plugins/agentmesh/dist/cli.js setup status --dir <tmp>` on Windows; it exits 1 with a "not found" message for the answers file, not a stack trace.
- [ ] **Step 5: Commit:** `git add -A && git commit -m "Plugin: ship the setup CLI and the /agentmesh:setup skill"`

### Task 13: Release workflow (images + tag)

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write the workflow.**
  - **Trigger:** `on: push: branches: [main]`. **Permissions:** `contents: write` and `packages: write`.
  - **Steps:**
    1. Check out with `fetch-depth: 0`.
    2. Read `V` from `plugins/agentmesh/.claude-plugin/plugin.json` with `node -p`.
    3. Skip every later step when `git rev-parse "v$V"` succeeds.
    4. `docker/setup-qemu-action@v3`, `docker/setup-buildx-action@v3`, then `docker/login-action@v3` to `ghcr.io` with `GITHUB_TOKEN`.
    5. Run `docker/build-push-action@v6` twice, once with `target: hub` and once with `target: discord-bridge`:
       - `file: deploy/Dockerfile`, `context: .`, `platforms: linux/amd64,linux/arm64`, `push: true`;
       - tags `ghcr.io/<owner-lowercase>/agentmesh-hub:$V` and `…/agentmesh-discord-bridge:$V`;
       - `labels: org.opencontainers.image.source=https://github.com/${{ github.repository }}`.
    6. `git tag "v$V" && git push origin "v$V"`.
  - Take the owner from `github.repository_owner` and lowercase it in a step, so it matches `DEFAULT_IMAGE_REGISTRY`.
- [ ] **Step 2: Check that it parses:** `pnpm --filter @agentmesh/cli exec node --input-type=module -e "import {parse} from 'yaml';import {readFileSync} from 'node:fs';const w=parse(readFileSync('../../.github/workflows/release.yml','utf8'));if(!w.jobs)process.exit(1)"`. Expected: exit 0.
- [ ] **Step 3: Commit:** `git commit -m "CI: publish hub and bridge images and tag each release"`

### Task 14: Docs, ADR 0007, version 0.4.0, final checks

**Files:**
- Create: `docs/adr/0007-claude-run-setup.md`
- Modify:
  - `docs/getting-started.md`: rewritten around `/agentmesh:setup`; the old steps move under "Set up by hand".
  - `docs/deploy.md`:
    - the generic server spec from spec §5.5;
    - published images, `AGENTMESH_IMAGE_REGISTRY`/`AGENTMESH_VERSION`, and `upgrade`;
    - a note that the repo's `deploy/docker-compose.yml` still builds from source for contributors and existing deploys.
  - `docs/security.md`: a threat note covering:
    - the token goes in a file, never the chat;
    - the workspace holds the hub's seeds (stolen laptop; recommend disk encryption);
    - `StrictHostKeyChecking=accept-new` trusts on first use;
    - cloud credentials stay in the admin's own CLI;
    - operator commands versus prompt injection (no allow rules; `disable-model-invocation`);
    - the deny rules apply only to sessions opened in the workspace.
  - `docs/discord.md`: bot creation the way setup does it.
  - `docs/configuration.md`: the new `.env` keys.
  - `README.md` and `plugins/agentmesh/README.md`: install plus `/agentmesh:setup` in three lines.
  - `CLAUDE.md`: status, roadmap (Phase 2), the commands list, and the version-bump rule, which now reads "one VERSION in `packages/common/src/version.ts` plus every package.json and plugin.json; a bump merged to main is a release".
  - Every version to `0.4.0`: `packages/common/src/version.ts`, every `package.json`, `plugin.json`.
  - Rebuild `plugins/agentmesh/dist/`.

- [ ] **Step 1: Write ADR 0007.** Its context is spec §1. Its decision is spec §5.1, §5.4 and §5.7. Its consequences are the image release coupling and the workspace as the source of truth.
- [ ] **Step 2: Update the docs** listed above.
- [ ] **Step 3: Bump to 0.4.0, then run** `pnpm --filter @agentmesh/plugin build && pnpm check && pnpm test:integration`. Expected: all pass. The version test from Task 1 proves the bump is complete.
- [ ] **Step 4: Commit:** `git add -A && git commit -m "Docs, ADR 0007 and release 0.4.0 for /agentmesh:setup"`

**After the plan (Pratik, by hand; not tasks for an agent):**
1. Make the repo public.
2. Merge it to `main`. The release workflow then publishes `0.4.0`.
3. Set both GHCR packages to public.
4. Run the spec §9 acceptance test on a fresh server, and once in trial mode on Windows. Use a machine or OS user that is not already on the Opzami mesh, or expect `setup admin` to ask for `--replace`.
