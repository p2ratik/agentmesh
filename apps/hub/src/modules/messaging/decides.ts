import type { ConfigIndex } from '@agentmesh/config';

/**
 * The recipient agents whose owner sent this message: a human's word is a decision only for their
 * own agents. Anyone else's (another human, an agent, a service) is information or a request.
 */
export function decidesFor(
  index: ConfigIndex,
  senderId: string,
  recipients: readonly string[],
): string[] {
  if (index.kindOf(senderId) !== 'human') return [];
  return recipients.filter((a) => index.agent(a)?.owner === senderId);
}
