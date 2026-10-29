import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCommandArgs } from '../args';
import { type CliContext, type Command, cliOf, configPathFrom, resolveFrom } from '../context';
import { meshFilePath } from '../lib/config-files';
import { addKey } from '../lib/keys';
import { listKeyHolders } from '../lib/mesh-document';
import { renderKeyAdded, renderKeyTable } from '../render/keys';

const OPTIONS = {
  config: { type: 'string' },
  secrets: { type: 'string' },
  force: { type: 'boolean' },
} as const;

function secretsDir(ctx: CliContext, flag: string | undefined): string {
  return resolveFrom(ctx, flag ?? ctx.env.AGENTMESH_SECRETS_DIR ?? 'secrets');
}

export const keysAddCommand: Command = {
  name: 'keys add',
  summary: 'Generate an nkey for an agent, service or the hub',
  help: `Usage: agentmesh keys add <participant-id> [--config <dir>] [--secrets <dir>] [--force]

Writes the private seed to <secrets>/<id>.nk (mode 600; default ./secrets or
$AGENTMESH_SECRETS_DIR) and the public key into mesh.yaml, keeping comments.
Use "hub" (or hub.serviceId) for the hub's own user, and hub-issuer, hub-xkey
and hub-sys for the keys \`nats-config --auth-callout\` needs. --force rotates a key.`,
  run(argv, ctx) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS, {
      min: 1,
      max: 1,
      names: '<participant-id>',
    });
    const meshFile = meshFilePath(configPathFrom(ctx, values.config));
    const id = positionals[0] ?? '';
    const added = addKey(meshFile, join(secretsDir(ctx, values.secrets), `${id}.nk`), id, {
      force: values.force ?? false,
      cli: cliOf(ctx),
    });
    ctx.stdout(renderKeyAdded({ ...added, meshFile }));
    return 0;
  },
};

export const keysListCommand: Command = {
  name: 'keys list',
  summary: 'Show which participants have keys',
  help: `Usage: agentmesh keys list [--config <dir>] [--secrets <dir>]`,
  run(argv, ctx) {
    const { values } = parseCommandArgs(argv, OPTIONS, { min: 0, max: 0, names: '' });
    const meshFile = meshFilePath(configPathFrom(ctx, values.config));
    const dir = secretsDir(ctx, values.secrets);
    const rows = listKeyHolders(readFileSync(meshFile, 'utf8')).map((holder) => ({
      holder,
      seedFound: existsSync(join(dir, `${holder.id}.nk`)),
    }));
    ctx.stdout(renderKeyTable(rows, dir));
    return 0;
  },
};
