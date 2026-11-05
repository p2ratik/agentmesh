import type { HubClient } from '../hub';
import { POLL_MS } from '../pull/watcher';
import type { Session } from '../session';

/** The longest a goodbye waits on the network. */
export const SHUTDOWN_MS = 250;

/**
 * `session.bye` for `sessionId` (this process's by default), naming it, so it never says hello
 * first and closes a session it just opened; nothing without one. Waits at most SHUTDOWN_MS: a
 * closing session never hangs on the hub.
 */
export async function byeQuietly(
  hub: Pick<HubClient, 'call' | 'sessionId'>,
  sessionId: string | null = hub.sessionId,
): Promise<void> {
  if (!sessionId) return;
  const options = { timeoutMs: SHUTDOWN_MS, session: sessionId };
  await Promise.race([
    hub.call('session.bye', {}, options).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_MS)),
  ]);
}

type Following = Pick<Session, 'claudeSessionId' | 'activation' | 'hub' | 'sayHello'>;

/**
 * Follows this process's conversation (design §4.2). A late id goes to the hub with a hello on the
 * same hub session. A new one (`/clear`, or `/resume` inside the session) in an inactive session
 * ends its hub session and says hello as a new one: the old conversation's threads go back as a
 * closed private asker's, so a relay never wakes a conversation that didn't ask. An active
 * session keeps its hub session and its work.
 */
export async function followConversation(session: Following, next: string | null): Promise<void> {
  const previous = session.claudeSessionId;
  if (next === null || next === previous) return;
  session.claudeSessionId = next;
  const { activation, hub } = session;
  if (previous !== null) {
    if (activation.lastDescription !== null || activation.pull) return;
    // Let go first: a hello while the bye is out (a lost call says one) must not name the old
    // session, or it would reclaim the old conversation's threads.
    const old = hub.sessionId;
    hub.sessionId = null;
    await byeQuietly(hub, old);
  }
  await session.sayHello();
}

/** Reads the record every POLL_MS, so a `/clear` shows within 30 s; returns the stop function. */
export function followEvery(session: Following, read: () => string | null): () => void {
  const timer = setInterval(() => void followConversation(session, read()), POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

type Hello = NonNullable<Session['hello']>;

/**
 * After each hello that landed: the session keeps it (one that missed openSession's wait too, so
 * its policy, such as the closed-asker minutes, holds), notes reclaimed threads and runs onHello.
 */
export function afterHello(
  session: Pick<Session, 'hello' | 'notices' | 'pull' | 'onHello'>,
  landed: { hello: Hello; renewed: boolean } | null,
): Hello | null {
  if (!landed) return null;
  session.hello = landed.hello;
  noteReclaimed(session, landed.hello.reclaimed);
  session.onHello?.(landed.renewed);
  return landed.hello;
}

/**
 * After a hello that gave threads back: Claude reads where after its next tool result, and the
 * session counts as one that used the mesh (it keeps its private record).
 */
export function noteReclaimed(
  session: Pick<Session, 'notices' | 'pull'>,
  reclaimed: readonly string[],
): void {
  if (reclaimed.length === 0) return;
  session.notices.push(reclaimedLines(reclaimed));
  session.pull.markUsed();
}

/** What Claude is told about threads the hub gave back to this session. */
export function reclaimedLines(threads: readonly string[]): string {
  return threads
    .map(
      (t) =>
        `Your earlier question in ${t} has come back to this session; read it with thread ${t} for its answer.`,
    )
    .join('\n');
}
