import { createLogger } from '@agentmesh/common';
import {
  CLOSED_ASKER_DEFAULT_MINUTES,
  type SessionAck,
  type SessionDelivery,
} from '@agentmesh/protocol';
import { vi } from 'vitest';
import type { HubClient } from '../hub';
import { Recorder } from '../telemetry/recorder';
import { FyiBuffer } from './fyi';
import type { ChannelEvent } from './render';
import { runSessionInbox, type SessionInboxOptions } from './session-inbox';

export const message = (
  id: string,
  threadId: string,
  kind: SessionDelivery['class'] = 'action',
): SessionDelivery => ({
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
  class: kind,
});
export const status = (id: string, threadId: string) => message(id, threadId, 'status');

type Callback = (err: Error | null, msg: unknown) => void;

/** A hub whose connection records subscriptions, and an inbox running on it. */
export function harness(
  failThread?: string,
  {
    onRelay = async () => ({ forwarded: false, reason: 'not the mesh window' }),
    closedAskerMinutes = () => CLOSED_ASKER_DEFAULT_MINUTES,
  }: Partial<Pick<SessionInboxOptions, 'onRelay' | 'closedAskerMinutes'>> = {},
) {
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
  /** Each `reportSeen` call (the real client skips empty ones). */
  const reported: string[][] = [];
  const hub = {
    config: { prefix: 'mesh', agentId: 'alice-agent' },
    sessionId: 's-aaaaaaaaaaaa',
    connection: nc,
    reportSeen: (ids: string[]) => reported.push(ids),
  } as unknown as HubClient;
  const fyi = new FyiBuffer();
  const logger = createLogger('test', { level: 'silent', destination: 'stderr' });
  const warn = vi.spyOn(logger, 'warn');
  const error = vi.spyOn(logger, 'error');
  const pushed: ChannelEvent[] = [];
  const checks: string[] = [];
  const onExpired = vi.fn();
  const onListening = vi.fn();
  const recorder = new Recorder({ max: () => 500, on: true });
  const inbox = runSessionInbox({
    recorder,
    hub,
    logger,
    signal: new AbortController().signal,
    fyi,
    push: async (event) => {
      if (event.meta.thread_id === failThread) throw new Error('transport closed');
      pushed.push(event);
    },
    pushCheck: async (code) => {
      checks.push(code);
    },
    onExpired,
    onListening,
    onRelay,
    closedAskerMinutes,
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
  return {
    hub,
    inbox,
    subs,
    pushed,
    checks,
    onExpired,
    onListening,
    warn,
    error,
    send,
    fyi,
    reported,
    recorder,
  };
}
