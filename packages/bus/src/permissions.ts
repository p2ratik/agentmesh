import type { MeshConfig } from '@agentmesh/config';
import { consumerNames, inboxPrefix, streamNames, subjects } from '@agentmesh/protocol';

/** How a NATS user is scoped. Service roles map 1:1 to kinds. */
export type NatsUserKind = 'hub' | 'agent' | 'bridge' | 'ingest' | 'custom';

export interface NatsUser {
  id: string;
  kind: NatsUserKind;
  nkey: string | null;
}

export interface Permissions {
  publish: string[];
  subscribe: string[];
}

/**
 * Auth-callout mode: the account every mesh participant lives in (the callout's
 * user JWTs use it as `aud`) and the system account the hub kicks through.
 */
export const APP_ACCOUNT = 'APP';
export const SYS_ACCOUNT = 'SYS';

/** The hub's system-account user may only kick connections; `CONNZ` and the rest are refused. */
export const SYS_USER_PERMISSIONS: Permissions = {
  publish: ['$SYS.REQ.SERVER.*.KICK'],
  subscribe: ['_INBOX.>'],
};

/** The hub first, then agents, then services, in config order. */
export function natsUsersFromConfig(config: MeshConfig): NatsUser[] {
  return [
    { id: config.hub.serviceId, kind: 'hub', nkey: config.hub.nkey ?? null },
    ...config.agents.map((a) => ({ id: a.id, kind: 'agent' as const, nkey: a.nkey ?? null })),
    ...config.services.map((s) => ({ id: s.id, kind: s.role, nkey: s.nkey ?? null })),
  ];
}

/** JetStream API subjects a pull consumer needs to look itself up, fetch and ack. */
function pullConsumerApi(stream: string, consumer: string): string[] {
  return [
    '$JS.API.INFO',
    `$JS.API.STREAM.INFO.${stream}`,
    `$JS.API.CONSUMER.INFO.${stream}.${consumer}`,
    `$JS.API.CONSUMER.MSG.NEXT.${stream}.${consumer}`,
    `$JS.ACK.${stream}.${consumer}.>`,
  ];
}

/**
 * Least-privilege subjects per participant. Because a participant can only
 * publish RPCs under its own id, the hub can trust the caller in the subject.
 */
export function permissionsFor(user: Pick<NatsUser, 'id' | 'kind'>, prefix: string): Permissions {
  const subs = subjects(prefix);
  const streams = streamNames(prefix);
  const replies = [`${inboxPrefix(user.id)}.>`];
  switch (user.kind) {
    case 'hub':
      return { publish: ['>'], subscribe: ['>'] };
    case 'agent':
      return {
        publish: [
          subs.rpc(user.id, '>'),
          subs.presence(user.id),
          ...pullConsumerApi(streams.delivery, consumerNames.inbox(user.id)),
        ],
        subscribe: replies,
      };
    case 'bridge':
      return {
        publish: [
          subs.rpc(user.id, '>'),
          ...pullConsumerApi(streams.events, consumerNames.feed(user.id)),
        ],
        subscribe: replies,
      };
    case 'ingest':
      return { publish: [subs.ingest(user.id), '$JS.API.INFO'], subscribe: replies };
    case 'custom':
      return { publish: [subs.rpc(user.id, '>')], subscribe: replies };
  }
}
