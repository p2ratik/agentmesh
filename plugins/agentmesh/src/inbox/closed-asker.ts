import type { MeshMessage, ReleasedMarker } from '@agentmesh/protocol';
import { closedAsker } from './render';

/** A message as the hub delivers it to a mesh window: `released` when its private asker closed. */
export type Released = MeshMessage & { released?: ReleasedMarker };

/**
 * What the mesh window shows with a thread whose private asker closed: the three choices it asks
 * its human about. The hub has already posted its own notice in the thread.
 */
export function closedAskerNotice(
  threadId: string,
  released: ReleasedMarker,
  minutes: number,
): string {
  const reopen = released.claudeSessionId
    ? `- Reopen that session: they run claude --resume ${released.claudeSessionId} in that project's folder, and the thread goes back to it.`
    : '- Reopen that session: not possible, its conversation id is unknown.';
  return [
    `AgentMesh: the session that asked this (${released.bySession}) has closed. Don't act on this answer: ask your human which they want.`,
    `- Continue it here: take(thread_id: "${threadId}"), say in one line in the thread that your human continues it here, then work on it in a fresh worktree.`,
    reopen,
    `- Drop it: take(thread_id: "${threadId}") and say in one line in the thread that your human dropped it.`,
    `If they don't answer within ${minutes} minutes, the hub pings them on Discord.`,
  ].join('\n');
}

/**
 * The notice for one pushed thread, from its last released message (`closedAsker`); undefined if
 * none was, or if `selfId`'s owner sent the whole push: that reply is the decision.
 */
export function threadNotice(
  thread: readonly Released[],
  minutes: number,
  selfId: string,
): string | undefined {
  const last = closedAsker(thread, selfId);
  return last?.released && closedAskerNotice(last.threadId, last.released, minutes);
}
