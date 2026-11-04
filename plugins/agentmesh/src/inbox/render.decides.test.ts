import type { MeshMessage } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { formatFyi } from './fyi';
import { renderEvent } from './render';

const reply = (id: string, from: MeshMessage['from'], refs: MeshMessage['refs']): MeshMessage => ({
  id,
  threadId: 'thr-1',
  kind: 'reply',
  from,
  to: ['alice-agent'],
  subject: 'Deploy',
  body: `body ${id}`,
  status: null,
  trust: 'team',
  depth: 0,
  refs,
  createdAt: '2026-11-04T09:00:00.000Z',
});

/** Alice's own word to her agent, marked by the hub; Carol's, unmarked. */
const alice: MeshMessage['from'] = { id: 'alice', kind: 'human', displayName: 'Alice' };
const owner = reply('m2', alice, { decidesFor: ['alice-agent'] });
const other = reply('m1', { id: 'carol', kind: 'human', displayName: 'Carol' }, {});

describe('renderEvent decides', () => {
  it('sets decides=yes only when every message is marked', () => {
    expect(renderEvent([owner], { selfId: 'alice-agent' }).meta.decides).toBe('yes');

    const mixed = renderEvent([other, owner], { selfId: 'alice-agent' });
    expect(mixed.meta.decides).toBeUndefined();
    expect(mixed.content.split('--- Alice (reply, DECIDES, ')).toHaveLength(2);
    expect(mixed.content).toContain('--- Carol (reply, 09:00 UTC) ---');
    expect(mixed.content.match(/DECIDES/g)).toHaveLength(1);

    expect(renderEvent([owner], { selfId: 'bob-agent' }).meta.decides).toBeUndefined();
  });

  it('never tags an FYI item, even an owner-marked one', () => {
    const status = { ...owner, id: 'm3', status: 'info' as const, class: 'status' as const };
    const footer = formatFyi({ items: [status], dropped: [] });
    const event = renderEvent([other], { selfId: 'alice-agent', footer });
    expect(event.content).toBe('│ body m1\n\nFYI (1):\n· thr-1 «Deploy» body m2');
    expect(event.meta.decides).toBeUndefined();
  });
});
