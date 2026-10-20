import { describe, expect, it } from 'vitest';
import { permissionsFor } from './permissions';

describe('NATS permissions', () => {
  it('scopes each kind of participant to its own subjects', () => {
    expect(permissionsFor({ id: 'a', kind: 'agent' }, 'mesh')).toEqual({
      publish: [
        'mesh.rpc.a.>',
        'mesh.presence.a',
        '$JS.API.INFO',
        '$JS.API.STREAM.INFO.MESH_DELIVERY',
        '$JS.API.CONSUMER.INFO.MESH_DELIVERY.inbox-a',
        '$JS.API.CONSUMER.MSG.NEXT.MESH_DELIVERY.inbox-a',
        '$JS.ACK.MESH_DELIVERY.inbox-a.>',
      ],
      subscribe: ['_INBOX_a.>'],
    });
    expect(permissionsFor({ id: 'h', kind: 'ingest' }, 'acme').publish).toEqual([
      'acme.ingest.h',
      '$JS.API.INFO',
    ]);
    expect(permissionsFor({ id: 'b', kind: 'bridge' }, 'mesh').publish).toContain(
      '$JS.API.CONSUMER.MSG.NEXT.MESH_EVENTS.feed-b',
    );
  });
});
