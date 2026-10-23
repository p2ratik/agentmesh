import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { VERSION } from '@agentmesh/common';
import { loadConfig } from '@agentmesh/config';
import { parseCommandArgs } from '../../args';
import type { Command } from '../../context';
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
import { DEFAULT_IMAGE_REGISTRY } from '../../setup/defaults';
import { readEnvFile } from '../../setup/env-file';
import {
  renderClaudeSettings,
  renderCompose,
  renderEnv,
  WORKSPACE_GITIGNORE,
} from '../../setup/render/deploy-files';
import { renderMeshYaml } from '../../setup/render/mesh-yaml';
import { renderPolicy } from '../../setup/render/policy';
import { renderAnswersSummary } from '../../setup/render/summary';
import {
  loadAnswers,
  markDone,
  readState,
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
const CALLOUT_KEYS = ['hub-issuer', 'hub-xkey', 'hub-sys'];

interface KeyTarget {
  id: string;
  seedDir: string;
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
    ...[...services, ...server].map((id) => ({ id, seedDir: p.secretsDir })),
    ...agents.map((id) => ({ id, seedDir: join(home, '.agentmesh') })),
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

export const setupRenderCommand: Command = {
  name: 'setup render',
  summary: 'Write the workspace config, keys and NATS config from setup-answers.json',
  help: `Usage: agentmesh setup render --dir <workspace> [--registry <r>] [--dry-run] [--force]

Renders config/mesh.yaml, the team policy, deploy/docker-compose.yml, deploy/.env,
.gitignore and .claude/settings.json from <workspace>/setup-answers.json, generates
the keys and writes deploy/nats/nats.conf. --dry-run prints the summary and writes
nothing. A rendered file that differs is kept unless --force; deploy/.env and
existing keys are always kept. --registry sets the image registry (default
${DEFAULT_IMAGE_REGISTRY}).`,
  run(argv, ctx) {
    const { values } = parseCommandArgs(argv, OPTIONS, { min: 0, max: 0, names: '' });
    const p = workspaceFrom(ctx, values.dir);
    const a = loadAnswers(p);
    if (values['dry-run']) {
      ctx.stdout(renderAnswersSummary(a));
      return 0;
    }
    const force = values.force ?? false;
    const renderedAt = readState(p).done.render;
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
    const report = (
      [
        [p.meshFile, previous ? carryOver(fresh, previous, targets, a.admin.id) : fresh],
        [p.policyFile, policy.text],
        [p.compose, renderCompose()],
        [p.gitignore, WORKSPACE_GITIGNORE],
        [p.claudeSettings, renderClaudeSettings()],
      ] as const
    ).map(([path, content]) => {
      const outcome = writeRendered(path, content, force);
      const note = outcome === 'differs' ? ' (kept; --force replaces it)' : '';
      return `  ${outcome.padEnd(10)}${relative(p.root, path)}${note}`;
    });
    // .env holds the bot token, so it is written once and never replaced.
    const envExists = existsSync(p.envFile);
    if (!envExists) {
      const registry = values.registry ?? DEFAULT_IMAGE_REGISTRY;
      writePrivateFile(
        p.envFile,
        renderEnv({ hosting: a.hosting, version: VERSION, registry }),
        false,
      );
    }
    report.push(`  ${(envExists ? 'kept' : 'created').padEnd(10)}${relative(p.root, p.envFile)}`);

    for (const { id, seedDir } of targets) {
      if (findKeyHolder(readFileSync(p.meshFile, 'utf8'), id).nkey) continue;
      const { seedFile } = addKey(p.meshFile, seedDir, id, { force: false });
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
    markDone(p, 'render', new Date());

    ctx.stdout(
      [
        `Rendered ${p.root}:`,
        ...report,
        '',
        `Next: paste your Discord bot token into ${p.envFile} after DISCORD_BOT_TOKEN=, save it, ` +
          'then run setup discord. Never paste the token into the chat.',
      ].join('\n'),
    );
    return 0;
  },
};
