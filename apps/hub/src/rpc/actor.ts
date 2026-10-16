import { MeshError } from '@agentmesh/common';
import type { ConfigIndex } from '@agentmesh/config';
import type { Actor } from '../contracts';

/** Builds the actor for an authenticated NATS identity. */
export function resolveCaller(index: ConfigIndex, callerId: string): Actor {
  const agent = index.agent(callerId);
  if (agent) return { id: agent.id, kind: 'agent', roles: [] };
  const service = index.service(callerId);
  if (service) return { id: service.id, kind: 'service', roles: ['service', service.role] };
  const human = index.human(callerId);
  if (human) return { id: human.id, kind: 'human', roles: human.roles };
  throw new MeshError('unauthenticated', `Unknown participant "${callerId}"`);
}

/** Services with `canActAsHumans` may relay calls for configured humans. */
export function resolveActAs(index: ConfigIndex, caller: Actor, humanId: string): Actor {
  const service = caller.kind === 'service' ? index.service(caller.id) : undefined;
  if (!service?.canActAsHumans) {
    throw new MeshError('forbidden', `${caller.id} may not act on behalf of humans`);
  }
  const human = index.human(humanId);
  if (!human) throw new MeshError('forbidden', `Unknown human "${humanId}"`);
  return { id: human.id, kind: 'human', roles: human.roles, viaService: caller.id };
}

/** The hub itself, for workflow transitions and notices it originates. */
export function systemActor(hubId: string): Actor {
  return { id: hubId, kind: 'service', roles: ['system'] };
}
