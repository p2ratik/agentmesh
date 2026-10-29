import type { NatsConnection } from '@agentmesh/bus';
import type { Logger } from '@agentmesh/common';
import type { ConfigIndex } from '@agentmesh/config';
import { GitRef, parseTokenAfter, SessionId, subjects } from '@agentmesh/protocol';
import { z } from 'zod';
import type { PresenceService } from '../../contracts';

/** The bus package does not re-export the NATS `Subscription` type. */
export type Subscription = ReturnType<NatsConnection['subscribe']>;

const Heartbeat = z.object({
  repo: GitRef.optional(),
  branch: GitRef.optional(),
  /** A subject token when the hub answers `expired`, so only a hub-issued id. */
  session: SessionId.optional(),
});
export type Heartbeat = z.infer<typeof Heartbeat>;

/**
 * Parses a heartbeat: `{p}.presence.{id}` with an optional JSON body
 * `{ repo?, branch?, session? }`. An empty body is a plain heartbeat; malformed ones
 * (a session that is not a hub-issued id included) yield null.
 */
export function parseHeartbeat(
  prefix: string,
  subject: string,
  body: string,
): { participantId: string; info: Heartbeat } | null {
  const participantId = parseTokenAfter(prefix, 'presence', subject);
  if (!participantId) return null;
  if (body.trim() === '') return { participantId, info: {} };
  try {
    const parsed = Heartbeat.safeParse(JSON.parse(body));
    return parsed.success ? { participantId, info: parsed.data } : null;
  } catch {
    return null;
  }
}

/**
 * Subscribes to agent heartbeats. NATS permissions guarantee the subject's id
 * is the publisher, so only the id's kind is checked: agents on the team now,
 * including members who joined by invite after the hub started.
 */
export function startPresenceListener(
  nc: NatsConnection,
  prefix: string,
  presence: PresenceService,
  /** Read on every heartbeat: enrolled members join and leave without a restart. */
  index: () => ConfigIndex,
  logger: Logger,
  onSession?: (
    agentId: string,
    sessionId: string,
    git: { repo?: string; branch?: string },
  ) => 'ok' | 'unknown',
  onUnknown?: (agentId: string, sessionId: string) => void,
): Subscription {
  return nc.subscribe(subjects(prefix).presenceAll, {
    callback: (err, msg) => {
      if (err) {
        logger.warn({ err }, 'presence subscription error');
        return;
      }
      const beat = parseHeartbeat(prefix, msg.subject, msg.string());
      if (!beat || index().kindOf(beat.participantId) !== 'agent') {
        logger.debug({ subject: msg.subject }, 'ignored presence message');
        return;
      }
      try {
        const { session, ...git } = beat.info;
        presence.touch(beat.participantId, git);
        if (session && onSession?.(beat.participantId, session, git) === 'unknown') {
          onUnknown?.(beat.participantId, session);
        }
      } catch (error) {
        logger.error({ err: error, participant: beat.participantId }, 'presence update failed');
      }
    },
  });
}
