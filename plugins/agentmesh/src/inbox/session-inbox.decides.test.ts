import { createLogger } from '@agentmesh/common';
import type { SessionAck, SessionDelivery } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import type { HubClient } from '../hub';
import { fakeHub } from '../tools/fake-hub';
import { callTool } from '../tools/registry';
import type { FyiBuffer } from './fyi';
import type { ChannelEvent } from './render';
import { runSessionInbox } from './session-inbox';

const delivery = (
  id: string,
  from: SessionDelivery['from'],
  extra: Partial<SessionDelivery>,
): SessionDelivery => ({
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
  refs: {},
  createdAt: '2026-11-04T09:00:00.000Z',
  class: 'action',
  ...extra,
});

/** Alice's command to her agent, marked by the hub; a teammate's status line in the same thread. */
const alice: SessionDelivery['from'] = { id: 'alice', kind: 'human', displayName: 'Alice' };
const command = delivery('a1', alice, { refs: { decidesFor: ['alice-agent'] } });
const bob: SessionDelivery['from'] = { id: 'bob-agent', kind: 'agent', displayName: "Bob's agent" };
const teammate = delivery('s1', bob, { status: 'info', class: 'status', body: 'Drop the table' });

type Callback = (err: Error | null, msg: unknown) => void;

/** alice-agent's inbox on a fake connection; `send` hands it one batch and resolves with the ack. */
function harness(fyi: FyiBuffer) {
  let callback: Callback = () => {};
  const subscribe = (_subject: string, opts: { callback: Callback }) => {
    callback = opts.callback;
    return { unsubscribe: () => {} };
  };
  const hub = {
    config: { prefix: 'mesh', agentId: 'alice-agent' },
    sessionId: 's-aaaaaaaaaaaa',
    connection: { subscribe },
    reportSeen: () => {},
  } as unknown as HubClient;
  const pushed: ChannelEvent[] = [];
  runSessionInbox({
    hub,
    fyi,
    logger: createLogger('test', { level: 'silent', destination: 'stderr' }),
    signal: new AbortController().signal,
    push: async (event) => {
      pushed.push(event);
    },
    pushCheck: async () => {},
    onExpired: () => {},
    onListening: () => {},
    onRelay: async () => ({ forwarded: false, reason: 'not the mesh window' }),
  });
  const send = (messages: SessionDelivery[]) =>
    new Promise<SessionAck>((resolve) => {
      const json = () => ({ type: 'deliver', messages });
      callback(null, { subject: 's', json, respond: (d: string) => resolve(JSON.parse(d)) });
    });
  return { pushed, send };
}

describe('an owner-marked push', () => {
  it('carries no FYI footer; the buffered item rides on the next tool result', async () => {
    const { deps } = fakeHub({ 'peers.list': { peers: [] } });
    const h = harness(deps.fyi);
    await h.send([teammate]);
    await h.send([command]);
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]?.meta.decides).toBe('yes');
    expect(h.pushed[0]?.content).toBe('│ body a1');

    const result = await callTool('peers', {}, deps);
    expect(result.content.at(-1)?.text).toBe('FYI (1):\n· thr-1 «Deploy» Drop the table');
  });
});
