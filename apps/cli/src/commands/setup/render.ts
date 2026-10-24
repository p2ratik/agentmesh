import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { VERSION } from '@agentmesh/common';
import { loadConfig } from '@agentmesh/config';
import { parseCommandArgs, usageError } from '../../args';
import { type Command, cliOf } from '../../context';
import { SECRET_PLACEHOLDER } from '../../lib/config-files';
import { writePrivateFile } from '../../lib/files';
import { addKey } from '../../lib/keys';
import {
  findKeyHolder,
  humanDiscordId,
  listKeyHolders,
  setHumanDiscordId,
  setPublicKey,
} from '../../lib/mesh-document';
import { writeNatsConfig } from '../../lib/nats-config-file';
import type { SetupAnswers } from '../../setup/answers';
import { DEFAULT_IMAGE_REGISTRY, IMAGE_REGISTRY } from '../../setup/defaults';
import { parseEnv, readEnvFile, updateEnvFile } from '../../setup/env-file';
import {
  renderClaudeSettings,
  renderCompose,
  renderEnv,
  withSecretLines,
} from '../../setup/render/deploy-files';
import { renderMeshYaml } from '../../setup/render/mesh-yaml';
import { renderPolicy } from '../../setup/render/policy';
import { renderAnswersSummary } from '../../setup/render/summary';
import { renderWorkspaceClaudeMd } from '../../setup/render/workspace-claude-md';
import {
  agentSeedFile,
  loadAnswers,
  markCreated,
  markRendered,
  readState,
  type SetupState,
  type WorkspacePaths,
  workspaceFrom,
  writeRendered,
} from '../../setup/workspace';

const OPTIONS = {
  dir: { type: 'string' },
  registry: { type: 'string' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
} as const;

/** Only `setup discord` learns these; until then the config is checked with stand-ins. */
const DISCORD_ENV = ['DISCORD_BOT_TOKEN', 'DISCORD_APP_ID', 'DISCORD_GUILD_ID'];
/** Later steps change these on purpose (setup discord, upgrade), so a kept .env may differ. */
const ENV_SET_LATER = [...DISCORD_ENV, 'AGENTMESH_VERSION'];
/** Not secret, and they follow the hosting mode, so --force sets them in a kept .env. */
const ENV_OF_MODE = ['NATS_BIND', 'NATS_PUBLIC_HOST'];
const CALLOUT_KEYS = ['hub-issuer', 'hub-xkey', 'hub-sys'];

/**
 * .env holds the bot token, so it is written once and never replaced, even with --force.
 * A kept one is compared with the answers instead, because the hub reads NATS_PUBLIC_HOST
 * and NATS_BIND there: --force sets those two in place, and the report names the other
 * settings that differ, never their values.
 */
function writeEnv(p: WorkspacePaths, a: SetupAnswers, force: boolean, registryFlag?: string) {
  const kept = existsSync(p.envFile) ? readEnvFile(p.envFile) : null;
  const registry = registryFlag || kept?.get('AGENTMESH_IMAGE_REGISTRY') || DEFAULT_IMAGE_REGISTRY;
  const text = renderEnv({ hosting: a.hosting, version: VERSION, registry });
  const file = relative(p.root, p.envFile);
  if (!kept) {
    writePrivateFile(p.envFile, text, false);
    return `  ${'created'.padEnd(10)}${file}`;
  }
  const differ = [...parseEnv(text)].filter(
    ([key, value]) => !ENV_SET_LATER.includes(key) && kept.get(key) !== value,
  );
  const set = force ? differ.filter(([key]) => ENV_OF_MODE.includes(key)) : [];
  if (set.length > 0) updateEnvFile(p.envFile, Object.fromEntries(set));
  const stale = differ.filter((entry) => !set.includes(entry)).map(([key]) => key);
  const notes = [
    ...(set.length > 0 ? [`set ${set.map(([key]) => key).join(', ')}`] : []),
    ...(stale.length > 0 ? [`kept; edit ${stale.join(', ')} by hand`] : []),
  ];
  const outcome = stale.length > 0 ? 'differs' : set.length > 0 ? 'updated' : 'kept';
  return `  ${outcome.padEnd(10)}${file}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`;
}

interface KeyTarget {
  id: string;
  seedFile: string;
  /** In ~/.agentmesh, which other meshes and `/agentmesh:join` use too. */
  shared: boolean;
}

/**
 * Who gets a key, in the order they get it: the hub and the bridge (both modes), the
 * callout keys (a server), then the admin's agents, whose seeds go to ~/.agentmesh.
 */
function keyTargets(
  meshText: string,
  a: SetupAnswers,
  p: WorkspacePaths,
  home: string,
): KeyTarget[] {
  const holders = listKeyHolders(meshText);
  const services = holders.filter((h) => h.kind !== 'agent').map((h) => h.id);
  const agents = holders.filter((h) => h.kind === 'agent').map((h) => h.id);
  const server = a.hosting.mode === 'server' ? CALLOUT_KEYS : [];
  return [
    ...[...services, ...server].map((id) => ({
      id,
      seedFile: join(p.secretsDir, `${id}.nk`),
      shared: false,
    })),
    ...agents.map((id) => ({
      id,
      seedFile: agentSeedFile(home, a.team.meshName, id),
      shared: true,
    })),
  ];
}

/**
 * A fresh render keeps what the previous mesh.yaml learned since: the public keys of
 * holders that still exist and the admin's Discord id. Applied in key order, so an
 * unchanged workspace renders byte for byte the same.
 */
function carryOver(fresh: string, previous: string, targets: KeyTarget[], adminId: string) {
  const keys = new Map(listKeyHolders(previous).map((h) => [h.id, h.nkey]));
  let text = fresh;
  for (const { id } of targets) {
    const key = keys.get(id);
    if (key) text = setPublicKey(text, id, key);
  }
  const discordId = humanDiscordId(previous, adminId);
  return discordId ? setHumanDiscordId(text, adminId, discordId) : text;
}

/**
 * Writes the rendered files and reports each. Until a render finishes nothing is confirmed or
 * deployed, and nobody edits its files by hand, so a re-run (say, with another person id after
 * a seed collision) replaces the files that render created itself, as --force would. A file
 * there before setup is kept. They are recorded before the keys, which may stop the render.
 */
function writeFiles(
  p: WorkspacePaths,
  state: SetupState,
  force: boolean,
  files: Array<[path: string, content: string]>,
): string[] {
  const own = new Set(state.done.render ? [] : (state.created ?? []));
  const created: string[] = [];
  const report = files.map(([path, content]) => {
    const file = relative(p.root, path);
    // A .gitignore already there (the workspace may be a repo) only gains the missing lines.
    const merged = path === p.gitignore;
    const outcome = writeRendered(path, content, force || merged || own.has(file));
    if (outcome === 'created' || own.has(file)) created.push(file);
    const note = outcome === 'differs' ? ' (kept; --force replaces it)' : '';
    const label = merged && outcome === 'replaced' ? 'appended' : outcome;
    return `  ${label.padEnd(10)}${file}${note}`;
  });
  markCreated(p, created);
  return report;
}

/**
 * From a trial to a server: the trial's containers restart with Docker, and a second bridge
 * with the same bot token would answer every Discord interaction too.
 */
function stopTrial(p: WorkspacePaths, from: SetupState['mode'], to: SetupState['mode']) {
  if (from !== 'trial' || to !== 'server') return [];
  return [
    'The trial still runs on this machine with the same bot token. Before setup deploy, stop ' +
      `it: run \`docker compose --profile discord down\` in ${p.deployDir}.`,
  ];
}

export const setupRenderCommand: Command = {
  name: 'setup render',
  summary: 'Write the workspace config, keys and NATS config from setup-answers.json',
  help: `Usage: agentmesh setup render --dir <workspace> [--registry <r>] [--dry-run] [--force]

Renders config/mesh.yaml, the team policy, deploy/docker-compose.yml, deploy/.env,
.gitignore, .claude/settings.json and CLAUDE.md from <workspace>/setup-answers.json,
generates the keys and writes deploy/nats/nats.conf. --dry-run prints the summary and
writes nothing. A rendered file that differs is kept unless --force (until a render
finishes, a re-run also replaces the files it created), and an existing .gitignore only
gains the secret lines it lacks. deploy/.env and existing keys are always kept: --force
sets only NATS_BIND and NATS_PUBLIC_HOST in deploy/.env, and the other settings in which
it differs are named. A render for another hosting mode than the last one marks host,
deploy and admin as to do again, and from a trial to a server it says to stop the
trial's containers first. Your agents' seeds go to ~/.agentmesh/<meshName>-<agent>.nk.
--registry sets the image registry (default ${DEFAULT_IMAGE_REGISTRY}).`,
  run(argv, ctx) {
    const { values } = parseCommandArgs(argv, OPTIONS, { min: 0, max: 0, names: '' });
    if (values.registry !== undefined && !IMAGE_REGISTRY.test(values.registry)) {
      throw usageError(
        `Invalid --registry: give a lowercase image registry such as ${DEFAULT_IMAGE_REGISTRY} ` +
          'or registry.example.com:5000/team',
      );
    }
    const p = workspaceFrom(ctx, values.dir);
    const a = loadAnswers(p);
    if (values['dry-run']) {
      ctx.stdout(renderAnswersSummary(a));
      return 0;
    }
    const force = values.force ?? false;
    const state = readState(p);
    const renderedAt = state.done.render;
    if (renderedAt && !force) {
      ctx.stdout(
        `Already rendered on ${renderedAt.slice(0, 10)}. The files in ${p.root} are now the ` +
          'source of truth; edit them, or re-render with --force.',
      );
      return 0;
    }

    const fresh = renderMeshYaml(a);
    const targets = keyTargets(fresh, a, p, ctx.homeDir);
    const previous = existsSync(p.meshFile) ? readFileSync(p.meshFile, 'utf8') : null;
    const policy = renderPolicy(a);
    for (const warning of policy.warnings) ctx.stderr(`warning: ${warning}`);
    const gitignore = existsSync(p.gitignore) ? readFileSync(p.gitignore, 'utf8') : '';
    const report = writeFiles(p, state, force, [
      [p.meshFile, previous ? carryOver(fresh, previous, targets, a.admin.id) : fresh],
      [p.policyFile, policy.text],
      [p.compose, renderCompose()],
      [p.gitignore, withSecretLines(gitignore)],
      [p.claudeSettings, renderClaudeSettings()],
      [p.claudeMd, renderWorkspaceClaudeMd(cliOf(ctx))],
    ]);
    report.push(writeEnv(p, a, force || !renderedAt, values.registry));

    for (const { id, seedFile: file, shared } of targets) {
      if (findKeyHolder(readFileSync(p.meshFile, 'utf8'), id).nkey) continue;
      const { seedFile } = addKey(p.meshFile, file, id, { force: false, cli: cliOf(ctx), shared });
      report.push(`  ${'key'.padEnd(10)}${id} (seed ${seedFile})`);
    }

    const env: Record<string, string> = Object.fromEntries(readEnvFile(p.envFile));
    for (const name of DISCORD_ENV) env[name] ||= SECRET_PLACEHOLDER;
    const server = a.hosting.mode === 'server';
    writeNatsConfig({
      configPath: p.configDir,
      env,
      out: p.natsConf,
      tls: server,
      callout: server,
    });
    report.push(`  ${'written'.padEnd(10)}${relative(p.root, p.natsConf)}`);
    loadConfig(p.meshFile, { env });
    markRendered(p, a.hosting.mode, new Date());

    ctx.stdout(
      [
        `Rendered ${p.root}:`,
        ...report,
        '',
        ...stopTrial(p, state.mode, a.hosting.mode),
        `Next: paste your Discord bot token into ${p.envFile} after DISCORD_BOT_TOKEN=, save it, ` +
          'then run setup discord. Never paste the token into the chat.',
      ].join('\n'),
    );
    return 0;
  },
};
