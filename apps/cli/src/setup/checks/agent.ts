import { type ConnectWords, connectOnce, refusedOrUnreachable } from '@agentmesh/bus';
import type { CheckResult } from './result';

export type ConnectNats = (
  servers: string[],
  seedFile: string,
  name: string,
) => Promise<{ close(): Promise<void> }>;

/** One NATS connection with a seed file, no reconnects, a 5 s timeout. */
export const connectNats: ConnectNats = (servers, seedFile, name) =>
  connectOnce({ servers, name, credentials: { nkeySeed: seedFile } });

/** What a failed connect with an agent's own key says (`refusedOrUnreachable`), as join does. */
export const keyWords = (agentId: string, hub: string): ConnectWords => ({
  refused: `The hub refused ${agentId}'s key: the agent was removed, or the hub doesn't know this key.`,
  dropped: `The connection to ${hub} dropped before the hub answered: it may have refused ${agentId}'s key, or the network failed.`,
});

/** Connects as the agent with its seed, then closes: NATS (and the auth callout) accept the key. */
export async function checkAgentConnects(
  natsUrl: string,
  seedFile: string,
  agentId: string,
  connect: ConnectNats = connectNats,
): Promise<CheckResult> {
  let connection: Awaited<ReturnType<ConnectNats>>;
  try {
    connection = await connect([natsUrl], seedFile, `doctor-${agentId}`);
  } catch (error) {
    const reason = refusedOrUnreachable(error, natsUrl, keyWords(agentId, natsUrl)).message;
    return {
      ok: false,
      label: `${agentId} cannot connect to ${natsUrl}`,
      detail: `${reason} Its key is ${seedFile}; setup render makes it and setup deploy gives the hub its public key.`,
    };
  }
  await connection.close();
  return { ok: true, label: `${agentId} connects to ${natsUrl}` };
}
