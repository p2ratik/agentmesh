import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MeshError } from '@agentmesh/common';
import { createAccount, createCurve, createUser, type KeyPair } from '@nats-io/nkeys';
import { parseCommandArgs } from '../args';
import { type CliContext, type Command, configPathFrom, resolveFrom } from '../context';
import { meshFilePath } from '../lib/config-files';
import { writeFileAtomic, writePrivateFile } from '../lib/files';
import { findKeyHolder, type KeyHolder, listKeyHolders, setPublicKey } from '../lib/mesh-document';
import { renderKeyAdded, renderKeyTable } from '../render/keys';

const OPTIONS = {
  config: { type: 'string' },
  secrets: { type: 'string' },
  force: { type: 'boolean' },
} as const;

/** The callout issuer is an account key and the xkey a curve key; everyone else is a user. */
function createKey(holder: KeyHolder): KeyPair {
  if (holder.role === 'issuer' && holder.kind === 'callout') return createAccount();
  if (holder.role === 'xkey' && holder.kind === 'callout') return createCurve();
  return createUser();
}

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
    const id = positionals[0] ?? '';
    const meshFile = meshFilePath(configPathFrom(ctx, values.config));
    const text = readFileSync(meshFile, 'utf8');
    const holder = findKeyHolder(text, id);
    const force = values.force ?? false;
    if (holder.nkey && !force) {
      throw new MeshError(
        'conflict',
        `${id} already has a key in ${holder.path}. Pass --force to rotate it.`,
      );
    }
    const user = createKey(holder);
    const publicKey = user.getPublicKey();
    const seedFile = join(secretsDir(ctx, values.secrets), `${id}.nk`);
    writePrivateFile(seedFile, `${new TextDecoder().decode(user.getSeed())}\n`, force);
    writeFileAtomic(meshFile, setPublicKey(text, id, publicKey));
    ctx.stdout(renderKeyAdded({ holder, publicKey, seedFile, meshFile }));
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
