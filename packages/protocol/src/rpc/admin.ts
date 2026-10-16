import { z } from 'zod';
import { PeerInfo } from '../primitives';
import { ANY_CALLER, defineMethod } from './define';

/** Links mesh entities to ids in external systems (e.g. Discord thread ids). */
const RefKey = z.object({
  system: z.string().min(1).max(40),
  entityType: z.enum(['thread', 'task', 'plan', 'participant']),
  entityId: z.string().min(1),
});

export const adminMethods = {
  'mesh.status': defineMethod({
    description: 'Mesh health: pause state, presence and open work counts.',
    callers: ANY_CALLER,
    params: z.object({}),
    result: z.object({
      name: z.string(),
      paused: z.boolean(),
      pausedReason: z.string().nullable(),
      peers: z.array(PeerInfo),
      counts: z.object({
        openThreads: z.number().int(),
        openTasks: z.number().int(),
        activePlans: z.number().int(),
        heldDeliveries: z.number().int(),
      }),
    }),
  }),
  'mesh.pause': defineMethod({
    description: 'Kill switch: hold every delivery until resumed.',
    callers: ['human'],
    requiresRole: 'admin',
    params: z.object({ reason: z.string().max(500).optional() }),
    result: z.object({ paused: z.literal(true) }),
  }),
  'mesh.resume': defineMethod({
    description: 'Resume delivery and release held messages.',
    callers: ['human'],
    requiresRole: 'admin',
    params: z.object({}),
    result: z.object({ paused: z.literal(false), released: z.number().int() }),
  }),
  'refs.set': defineMethod({
    description: 'Bridges only: remember the external id of a mesh entity.',
    callers: ['service'],
    params: RefKey.extend({ ref: z.string().min(1).max(200) }),
    result: z.object({ ok: z.literal(true) }),
  }),
  'refs.get': defineMethod({
    description: 'Bridges only: look up the external id of a mesh entity.',
    callers: ['service'],
    params: RefKey,
    result: z.object({ ref: z.string().nullable() }),
  }),
  'refs.find': defineMethod({
    description: 'Bridges only: find the mesh entity behind an external id.',
    callers: ['service'],
    params: z.object({ system: z.string(), ref: z.string() }),
    result: z.object({
      entity: z.object({ entityType: z.string(), entityId: z.string() }).nullable(),
    }),
  }),
} as const;
