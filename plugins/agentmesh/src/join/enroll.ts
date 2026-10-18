import { connectOnce, generateUserKey, RpcClient } from '@agentmesh/bus';
import { MeshError } from '@agentmesh/common';
import { inboxPrefix, type RpcResult } from '@agentmesh/protocol';
import type { InviteSummary } from './invite';

export interface Enrolled {
  seed: string;
  publicKey: string;
  hello: RpcResult<'session.hello'>;
}

/** Same words for every refusal: the hub never says why, so neither can we. */
export const REFUSED =
  'The hub did not accept this invite. It may be used, expired or cancelled, or not meant for this hub. Ask your admin for a new one.';

/**
 * Redeems an invite: generates the key here, then connects once with the key
 * and the invite code in the same CONNECT. The hub's auth callout checks the
 * key signature, redeems the invite and admits this agent. A `session.hello`
 * proves the hub now knows us. Later connects use the key alone.
 */
export async function enroll(
  summary: InviteSummary,
  code: string,
  clientVersion: string,
): Promise<Enrolled> {
  const { payload } = summary;
  const key = generateUserKey();
  let nc: Awaited<ReturnType<typeof connectOnce>>;
  try {
    nc = await connectOnce({
      servers: [payload.natsUrl],
      name: `agentmesh-join:${payload.agentId}`,
      inboxPrefix: inboxPrefix(payload.agentId),
      credentials: { nkeySeed: key.seed, token: code.trim() },
    });
  } catch (error) {
    throw refusedOrUnreachable(error, summary.hub);
  }
  try {
    const rpc = new RpcClient(nc, payload.prefix, payload.agentId, 10_000);
    const hello = await rpc.call('session.hello', { clientVersion });
    return { seed: key.seed, publicKey: key.publicKey, hello };
  } finally {
    await nc.close().catch(() => undefined);
  }
}

/** Auth failures show up as `Authorization Violation` or a reset; never echo the server text. */
function refusedOrUnreachable(error: unknown, hub: string): MeshError {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/authori[sz]ation|ECONNRESET|auth/i.test(text))
    return new MeshError('unauthenticated', REFUSED);
  if (/tls/i.test(text)) {
    return new MeshError(
      'unavailable',
      `${hub} did not offer TLS, so nothing was sent. Check the hub URL with your admin.`,
    );
  }
  return new MeshError(
    'unavailable',
    `Could not reach the hub at ${hub}. Check your network and try again.`,
  );
}
