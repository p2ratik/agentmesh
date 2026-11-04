import type { RpcParams } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import type { CallContext } from '../../contracts';
import { internalId } from '../../core/ids';
import { createServiceHarness } from '../../testing/services';
import type { MessagingServiceImpl } from './messaging.service';
import { sendHandlers } from './send.handlers';

const agent = (id: string): CallContext => {
  const actor = { id, kind: 'agent' as const, roles: [] };
  return { actor, caller: actor, method: 'escalate', session: null, notes: [] };
};

/** An alice-agent and bob-agent conversation, and an escalate call into it. */
async function escalateInThread(actorId: string, to?: string) {
  const h = createServiceHarness();
  const { escalate } = sendHandlers(h.messaging as MessagingServiceImpl);
  const thread = h.messaging.createThread({
    kind: 'conversation',
    subject: 'x',
    createdBy: 'alice-agent',
    participants: ['bob-agent'],
  });
  await h.drain();
  const params = {
    question: 'Ship it?',
    threadId: `thr-${thread.id}`,
    ...(to ? { to } : {}),
  } as RpcParams<'escalate'>;
  const { threadId } = await escalate(params, agent(actorId));
  const delivered = await h.drain();
  const created = h.ports.events.flatMap((e) => (e.type === 'message.created' ? [e.data] : []));
  return { h, threadId, delivered, last: created[created.length - 1] };
}

describe('escalate into an existing thread', () => {
  it('an escalation into an existing thread reaches only its target', async () => {
    const { h, threadId, delivered, last } = await escalateInThread('alice-agent', 'carol');
    expect(last?.message.to).toEqual(['carol']);
    expect(delivered.get('bob-agent')).toBeUndefined();
    expect(h.messaging.participants(internalId('thread', threadId))).toContain('carol');
  });

  it("defaults to the agent's owner inside a thread too", async () => {
    const { last } = await escalateInThread('bob-agent');
    expect(last?.message.to).toEqual(['bob']);
  });
});
