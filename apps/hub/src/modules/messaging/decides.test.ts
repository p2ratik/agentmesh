import type { MessageRefs, RpcParams } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import type { CallContext } from '../../contracts';
import { createServiceHarness } from '../../testing/services';
import type { MessagingServiceImpl } from './messaging.service';
import { sendHandlers } from './send.handlers';

const agent = (id: string): CallContext => {
  const actor = { id, kind: 'agent' as const, roles: [] };
  return { actor, caller: actor, method: 'escalate', session: null, notes: [] };
};

/** An alice-agent and bob-agent conversation; `post` replies into a thread and returns its mark. */
function setup() {
  const h = createServiceHarness();
  const thread = h.messaging.createThread({
    kind: 'conversation',
    subject: 'x',
    createdBy: 'alice-agent',
    participants: ['alice-agent', 'bob-agent'],
  });
  let n = 0;
  const post = (senderId: string, refs?: MessageRefs, threadId = thread.id) =>
    h.messaging.post({
      threadId,
      senderId,
      kind: 'reply',
      body: `m${n++}`,
      ...(refs ? { refs } : {}),
    }).message.refs.decidesFor;
  return { h, thread, post };
}

describe('the owner mark (refs.decidesFor)', () => {
  it('marks the recipient agents whose owner sent the message', () => {
    const { post } = setup();
    expect(post('bob')).toEqual(['bob-agent']);
  });

  it("another human's or an agent's message marks nobody", () => {
    const { post } = setup();
    expect(post('carol')).toBeUndefined();
    expect(post('alice-agent')).toBeUndefined();
  });

  it('drops a decidesFor the caller passed', () => {
    const { post } = setup();
    expect(post('alice-agent', { decidesFor: ['bob-agent'] })).toBeUndefined();
    expect(post('carol', { decidesFor: ['bob-agent'] })).toBeUndefined();
    expect(post('bob', { decidesFor: ['alice-agent'] })).toEqual(['bob-agent']);
  });

  it('an old escalation row, or the human the agent escalated to, grants nothing', async () => {
    const { h, thread, post } = setup();
    // Before escalations named their target, one reached every participant.
    const old = h.messaging.createThread({
      kind: 'escalation',
      subject: 'y',
      createdBy: 'bob-agent',
      participants: ['bob-agent', 'carol'],
    });
    h.messaging.post({ threadId: old.id, senderId: 'bob-agent', kind: 'escalation', body: 'Ok?' });
    expect(post('carol', undefined, old.id)).toBeUndefined();

    const { escalate } = sendHandlers(h.messaging as MessagingServiceImpl);
    const params = { question: 'Ship it?', to: 'carol', threadId: `thr-${thread.id}` };
    await escalate(params as RpcParams<'escalate'>, agent('bob-agent'));
    expect(post('carol')).toBeUndefined();
  });
});
