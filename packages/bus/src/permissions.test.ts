import { describe, expect, it } from 'vitest';
import { permissionsFor } from './permissions';

describe('NATS permissions', () => {
  it('scopes each kind of participant to its own subjects', () => {
    expect(permissionsFor({ id: 'a', kind: 'agent' }, 'mesh')).toEqual({
      publish: ['mesh.rpc.a.>', 'mesh.presence.a', 'mesh.ack.a.>'],
      subscribe: ['_INBOX_a.>', 'mesh.session.a.*'],
    });
    const alice = permissionsFor({ id: 'alice-agent', kind: 'agent' }, 'mesh');
    expect(alice.publish).toContain('mesh.ack.alice-agent.>');
    expect(alice.subscribe).toContain('mesh.session.alice-agent.*');
    expect(alice.publish).not.toContain(
      '$JS.API.CONSUMER.MSG.NEXT.MESH_DELIVERY.inbox-alice-agent',
    );
    expect(permissionsFor({ id: 'h', kind: 'ingest' }, 'acme').publish).toEqual([
      'acme.ingest.h',
      '$JS.API.INFO',
    ]);
    expect(permissionsFor({ id: 'b', kind: 'bridge' }, 'mesh').publish).toContain(
      '$JS.API.CONSUMER.MSG.NEXT.MESH_EVENTS.feed-b',
    );
  });
});
