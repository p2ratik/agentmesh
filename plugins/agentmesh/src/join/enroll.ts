import { type ConnectWords, connectOnce, RpcClient, refusedOrUnreachable } from '@agentmesh/bus';
import { inboxPrefix, type RpcResult } from '@agentmesh/protocol';
import type { InviteSummary } from './invite';

/** The hub's greeting, or null if it was slow: the connect alone already enrolled us. */
export type Greeting = RpcResult<'session.hello'> | null;

/** Same words for every refusal: the hub never says why, so neither can we. */
export const REFUSED =
  'The hub did not accept this invite. It may be used, expired or cancelled, or not meant for this hub. Ask your admin for a new one.';

const JOIN_WORDS: ConnectWords = {
  refused: REFUSED,
  dropped: `${REFUSED} (The connection dropped, so this is not certain; the new key was kept in ~/.agentmesh in case the hub did accept it.)`,
};

/**
 * Redeems an invite: connects once with the locally generated key and the
 * invite code in the same CONNECT. The hub's auth callout checks the key
 * signature, redeems the invite and admits this agent, so a successful
 * connect means enrolled; it throws only when the connect fails. Later
 * connects use the key alone.
 */
export async function enroll(
  summary: InviteSummary,
  code: string,
  seed: string,
  clientVersion: string,
): Promise<Greeting> {
  const { payload } = summary;
  let nc: Awaited<ReturnType<typeof connectOnce>>;
  try {
    nc = await connectOnce({
      servers: [payload.natsUrl],
      name: `agentmesh-join:${payload.agentId}`,
      inboxPrefix: inboxPrefix(payload.agentId),
      credentials: { nkeySeed: seed, token: code.trim() },
    });
  } catch (error) {
    // A reset or a timeout can come after the hub admitted the key: those carry
    // `details.mayBeEnrolled`, so the caller keeps the staged key.
    throw refusedOrUnreachable(error, summary.hub, JOIN_WORDS, { mayBeEnrolled: true });
  }
  try {
    const rpc = new RpcClient(nc, payload.prefix, payload.agentId, 10_000);
    return await rpc.call('session.hello', { clientVersion }).catch(() => null);
  } finally {
    await nc.close().catch(() => undefined);
  }
}
