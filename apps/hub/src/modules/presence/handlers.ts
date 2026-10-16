import type { HubContext } from '../../context';
import type { PresenceService, RpcHandlerMap } from '../../contracts';

export interface PresenceDeps {
  unreadThreadCount(participantId: string): number;
}

type PresenceHandlers = Pick<
  RpcHandlerMap,
  'session.hello' | 'session.bye' | 'presence.set' | 'peers.list'
>;

export function presenceHandlers(
  ctx: HubContext,
  presence: PresenceService,
  deps: PresenceDeps,
): PresenceHandlers {
  const { config } = ctx.loaded;
  return {
    'session.hello': (params, call) => {
      presence.touch(call.actor.id, { repo: params.repo, branch: params.branch });
      ctx.logger.info(
        { participant: call.actor.id, clientVersion: params.clientVersion },
        'session hello',
      );
      return {
        self: presence.peer(call.actor.id),
        mesh: { name: config.mesh.name, prefix: config.mesh.prefix },
        policy: { instructions: ctx.loaded.policyText, git: config.git },
        unreadThreads: deps.unreadThreadCount(call.actor.id),
      };
    },
    'session.bye': (_params, call) => {
      presence.markOffline(call.actor.id);
      return { ok: true };
    },
    'presence.set': (params, call) => {
      presence.touch(call.actor.id, { repo: params.repo, branch: params.branch });
      presence.setDeclared(call.actor.id, params.status, params.note ?? null);
      return presence.peer(call.actor.id);
    },
    'peers.list': (params) => ({ peers: presence.peers(params.kind) }),
  };
}
