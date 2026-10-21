import type { PresenceService, RpcHandlerMap } from '../../contracts';

type PresenceHandlers = Pick<RpcHandlerMap, 'presence.set' | 'peers.list'>;

/** `session.hello` and `session.bye` live in the sessions module. */
export function presenceHandlers(presence: PresenceService): PresenceHandlers {
  return {
    'presence.set': (params, call) => {
      presence.touch(call.actor.id, { repo: params.repo, branch: params.branch });
      presence.setDeclared(call.actor.id, params.status, params.note ?? null);
      return presence.peer(call.actor.id);
    },
    'peers.list': (params) => ({ peers: presence.peers(params.kind) }),
  };
}
