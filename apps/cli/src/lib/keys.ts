import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MeshError } from '@agentmesh/common';
import { createAccount, createCurve, createUser, type KeyPair } from '@nats-io/nkeys';
import { writeFileAtomic, writePrivateFile } from './files';
import { findKeyHolder, type KeyHolder, setPublicKey } from './mesh-document';

export interface AddedKey {
  holder: KeyHolder;
  publicKey: string;
  seedFile: string;
}

/** The callout issuer is an account key and the xkey a curve key; everyone else is a user. */
function createKey(holder: KeyHolder): KeyPair {
  if (holder.role === 'issuer' && holder.kind === 'callout') return createAccount();
  if (holder.role === 'xkey' && holder.kind === 'callout') return createCurve();
  return createUser();
}

/**
 * Generates an nkey: the seed goes to `<secretsDir>/<id>.nk` (mode 600) and the public
 * key into mesh.yaml. Without `force` it never replaces a key or an existing seed file.
 */
export function addKey(
  meshFile: string,
  secretsDir: string,
  id: string,
  opts: { force: boolean },
): AddedKey {
  const text = readFileSync(meshFile, 'utf8');
  const holder = findKeyHolder(text, id);
  if (holder.nkey && !opts.force) {
    throw new MeshError(
      'conflict',
      `${id} already has a key in ${holder.path}. Pass --force to rotate it.`,
    );
  }
  const key = createKey(holder);
  const publicKey = key.getPublicKey();
  const seedFile = join(secretsDir, `${id}.nk`);
  try {
    writePrivateFile(seedFile, `${new TextDecoder().decode(key.getSeed())}\n`, opts.force);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Perhaps another mesh's key: replacing it must be a deliberate step.
    throw new MeshError(
      'conflict',
      `${seedFile} already exists, but mesh.yaml has no key for ${id}. It may belong to ` +
        `another mesh, so it is never replaced by accident. To replace it, run \`agentmesh keys add ` +
        `${id} --force --config "${dirname(meshFile)}" --secrets "${secretsDir}"\`.`,
    );
  }
  writeFileAtomic(meshFile, setPublicKey(text, id, publicKey));
  return { holder, publicKey, seedFile };
}
