import { createLogger } from '@agentmesh/common';
import type { MeshMessage, SessionAck } from '@agentmesh/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { HubClient } from '../hub';
import type { ChannelEvent } from './render';
import { runSessionInbox } from './session-inbox';

const message = (id: string, threadId: string): MeshMessage => ({
  id,
  threadId,
  kind: 'ask',
  from: { id: 'bob-agent', kind: 'agent', displayName: "Bob's agent" },
  to: ['alice-agent'],
  subject: 'Render queue',
  body: `body ${id}`,
  status: null,
  trust: 'team',
  depth: 1,
  refs: {},
  createdAt: '2026-10-21T09:00:00.000Z',
});

type Callback = (err: Error | null, msg: unknown) => void;

/** A hub whose connection records subscriptions, and an inbox running on it. */
function harness(failThread?: string) {
  const subs: Array<{ subject: string; callback: Callback; closed: boolean }> = [];
  const nc = {
    subscribe: (subject: string, opts: { callback: Callback }) => {
      const sub = { subject, callback: opts.callback, closed: false };
      subs.push(sub);
      return {
        unsubscribe: () => {
          sub.closed = true;
        },
      };
    },
  };
  const hub = {
    config: { prefix: 'mesh', agentId: 'alice-agent' },
    sessionId: 's-aaaaaaaaaaaa',
    connection: nc,
  } as unknown as HubClient;
  const logger = createLogger('test', { level: 'silent', destination: 'stderr' });
  const warn = vi.spyOn(logger, 'warn');
  const pushed: ChannelEvent[] = [];
  const onExpired = vi.fn();
  const inbox = runSessionInbox({
    hub,
    logger,
    signal: new AbortController().signal,
    push: async (event) => {
      if (event.meta.thread_id === failThread) throw new Error('transport closed');
      pushed.push(event);
    },
    onExpired,
  });
  /** Hands the live subscription one inbound NATS message; resolves with its ack, if any. */
  const send = (payload: unknown) => {
    const respond = vi.fn((_data: string) => true);
    const acked = new Promise<SessionAck>((resolve) =>
      respond.mockImplementation((data: string) => {
        resolve(JSON.parse(data));
        return true;
      }),
    );
    const live = subs.filter((s) => !s.closed).at(-1);
    const json = () => (typeof payload === 'string' ? JSON.parse(payload) : payload);
    live?.callback(null, { subject: live.subject, json, respond });
    return { acked, respond };
  };
  return { hub, inbox, subs, pushed, onExpired, warn, send };
}

describe('runSessionInbox', () => {
  it('pushes one event per thread and acks every pushed id', async () => {
    const h = harness();
    expect(h.subs[0]?.subject).toBe('mesh.session.alice-agent.s-aaaaaaaaaaaa');
    const batch = [message('m1', 'thr-1'), message('m2', 'thr-2'), message('m3', 'thr-1')];
    const ack = await h.send({ type: 'deliver', messages: batch }).acked;
    expect(h.pushed.map((e) => [e.meta.thread_id, e.meta.count])).toEqual([
      ['thr-1', '2'],
      ['thr-2', undefined],
    ]);
    expect([...ack.delivered].sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('does not ack messages whose push failed', async () => {
    const h = harness('thr-2');
    const batch = [message('m1', 'thr-1'), message('m2', 'thr-2'), message('m3', 'thr-2')];
    const ack = await h.send({ type: 'deliver', messages: batch }).acked;
    expect(ack.delivered).toEqual(['m1']);
  });

  it('acks a redelivered id without pushing it again', async () => {
    const h = harness();
    await h.send({ type: 'deliver', messages: [message('m1', 'thr-1')] }).acked;
    const ack = await h.send({
      type: 'deliver',
      messages: [message('m1', 'thr-1'), message('m2', 'thr-1')],
    }).acked;
    expect(h.pushed.map((e) => e.meta.message_id)).toEqual(['m1', 'm2']);
    expect(h.pushed[1]?.content).toBe('body m2');
    expect(ack.delivered).toEqual(['m1', 'm2']);
  });

  it('calls onExpired for an expiry notice', async () => {
    const h = harness();
    const { respond } = h.send({ type: 'expired' });
    await vi.waitFor(() => expect(h.onExpired).toHaveBeenCalledOnce());
    expect(respond).not.toHaveBeenCalled();
  });

  it('ignores malformed payloads', async () => {
    const h = harness();
    const bad = [h.send('not json'), h.send({ type: 'deliver', messages: [] })];
    await vi.waitFor(() => expect(h.warn).toHaveBeenCalledTimes(2));
    for (const { respond } of bad) expect(respond).not.toHaveBeenCalled();
    expect(h.pushed).toEqual([]);
  });

  it('moves to the current session on resubscribe and lets go on stop', () => {
    const h = harness();
    (h.hub as { sessionId: string }).sessionId = 's-bbbbbbbbbbbb';
    h.inbox.resubscribe();
    expect(h.subs.map((s) => [s.subject, s.closed])).toEqual([
      ['mesh.session.alice-agent.s-aaaaaaaaaaaa', true],
      ['mesh.session.alice-agent.s-bbbbbbbbbbbb', false],
    ]);
    h.inbox.stop();
    h.inbox.resubscribe();
    expect(h.subs.map((s) => s.closed)).toEqual([true, true]);
  });
});
