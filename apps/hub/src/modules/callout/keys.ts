import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MeshError } from '@agentmesh/common';
import type { MeshConfig } from '@agentmesh/config';
import { fromCurveSeed, fromSeed, type KeyPair } from '@nats-io/nkeys';
import type { CalloutKeys } from './callout.service';

export interface LoadedCalloutKeys extends CalloutKeys {
  /** Seed of the hub's kick-only system-account user, for its second connection. */
  sysSeed: string;
}

/**
 * Callout mode is on when `hub.authCallout` names all three public keys. Their
 * seeds are `<hubId>-issuer.nk`, `-xkey.nk` and `-sys.nk` in the secrets dir
 * (what `agentmesh keys add` writes). Returns null when the mode is off.
 */
export function loadCalloutKeys(
  hub: MeshConfig['hub'],
  secretsDir: string | undefined,
): LoadedCalloutKeys | null {
  const expected = hub.authCallout ?? {};
  const set = [expected.issuer, expected.xkey, expected.sysNkey].filter(Boolean).length;
  if (set === 0) return null;
  if (set < 3 || !expected.issuer || !expected.xkey || !expected.sysNkey) {
    throw new MeshError('invalid_request', 'hub.authCallout needs issuer, xkey and sysNkey');
  }
  if (!secretsDir) {
    throw new MeshError('invalid_request', 'Auth callout mode needs AGENTMESH_SECRETS_DIR');
  }
  const read = (role: string, expectedKey: string, load: (seed: Uint8Array) => KeyPair) => {
    const file = join(secretsDir, `${hub.serviceId}-${role}.nk`);
    const seed = readFileSync(file, 'utf8').trim();
    const kp = load(new TextEncoder().encode(seed));
    if (kp.getPublicKey() !== expectedKey) {
      throw new MeshError('invalid_request', `${file} does not match hub.authCallout in mesh.yaml`);
    }
    return { kp, seed };
  };
  return {
    issuer: read('issuer', expected.issuer, fromSeed).kp,
    xkey: read('xkey', expected.xkey, fromCurveSeed).kp,
    sysSeed: read('sys', expected.sysNkey, fromSeed).seed,
  };
}
