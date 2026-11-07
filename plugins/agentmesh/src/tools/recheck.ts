import type { Logger } from '@agentmesh/common';
import type { Session } from '../session';
import { reactivatePull } from './activation';

/**
 * The hub closed this window's active session (a long sleep, say) and gave it a
 * new, inactive one. The human opted this window in, so the hub sends a fresh
 * check, which this process answers itself with the previous line (`answerCheck`).
 * A pull session gets no check to answer, so it re-activates in pull mode at once.
 */
export function recheck(
  session: Pick<Session, 'activation' | 'hub' | 'pull' | 'recorder'>,
  logger: Logger,
): void {
  const { activation, hub, recorder } = session;
  if (activation.lastDescription === null) return;
  if (activation.pull) {
    void reactivatePull({
      hub,
      activation,
      logger,
      recorder,
      refresh: () => session.pull.refresh(),
    });
    return;
  }
  activation.renewedFrom = activation.lastDescription;
  void session.pull.refresh();
  logger.info({ session: hub.sessionId }, 'new hub session; re-running the activation check');
  void hub
    .call('session.check', {})
    .catch((err) => logger.warn({ err }, 'could not start the activation check'));
}
