import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  HubEvent,
  NODE_ARCHES,
  NODE_PLATFORMS,
  ObservedEvent,
  REASON_CODES,
  ReportedEvent,
} from './observe';
import { RPC_METHODS } from './rpc';

const base = {
  id: '3f2b8c1e-5d4a-4e6b-9c7d-1a2b3c4d5e6f',
  at: '2026-11-06T10:00:00.000Z',
  session: 's-abc123def456',
};
const rep = { ...base, source: 'plugin' };
const hub = { ...base, source: 'hub' };
const msg = 'msg-01J8ZZZZZZZZZZZZZZZZZZZZZZ';

const reported: Record<string, object> = {
  connected: {
    pluginVersion: '0.7.0',
    claudeCodeVersion: '2.1.300',
    os: 'win32',
    arch: 'x64',
    node: '24.1.0',
    meshWindow: true,
    pull: false,
  },
  nats: { event: 'error', code: 'AUTHORIZATION_VIOLATION' },
  activation: { phase: 'refused', mode: 'push', reason: 'activation.wrong_code' },
  tool: { tool: 'ask', outcome: 'ok', ms: 120, thread: 'thr-3', task: 'task-4', plan: 'plan-1' },
  delivery: { message: msg, thread: 'thr-3', stage: 'pushed', sinceReceivedMs: 5 },
  relay: { message: msg, thread: 'thr-3', stage: 'denied', reason: 'send.no_record' },
  guard: { tool: 'Bash', decision: 'deny', reason: 'send.unknown_key', key: 'summary' },
  hook: { note: 'note_shown', unread: 2 },
  dropped: { count: 7 },
};
const hubEvents: Record<string, object> = {
  session: { phase: 'taken_over', replacedSession: 's-aaaaaaaaaaaa', threads: ['thr-1'] },
  delivery: { message: msg, thread: 'thr-3', stage: 'failed', code: 'timeout' },
  relay: { message: msg, thread: 'thr-3', stage: 'not_forwarded', reason: 'send.claim_failed' },
  orphan: { thread: 'thr-3', phase: 'escalated' },
  rpc: { method: 'task.act', caller: 'bob-agent', code: 'forbidden' },
  auth: { event: 'denied', reason: 'guard.error' },
};

describe('observability events', () => {
  for (const [kind, rest] of Object.entries(reported)) {
    it(`parses a reported ${kind} event`, () => {
      expect(ReportedEvent.safeParse({ ...rep, kind, ...rest }).success).toBe(true);
    });
  }
  for (const [kind, rest] of Object.entries(hubEvents)) {
    it(`parses a hub ${kind} event`, () => {
      expect(HubEvent.safeParse({ ...hub, kind, ...rest }).success).toBe(true);
    });
  }

  it('adds agent and receivedAt when stored', () => {
    const e = { ...rep, kind: 'dropped', count: 1, agent: 'a-agent', receivedAt: base.at };
    expect(ObservedEvent.safeParse(e).success).toBe(true);
    expect(ObservedEvent.safeParse({ ...e, extra: 1 }).success).toBe(false);
  });

  it('has no free text: an extra field is refused', () => {
    const e = { ...rep, kind: 'tool', ...reported.tool, text: 'hello' };
    expect(ReportedEvent.safeParse(e).success).toBe(false);
  });

  it('refuses a guard key that is not a plain identifier', () => {
    const e = { ...rep, kind: 'guard', ...reported.guard, key: 'sum mary' };
    expect(ReportedEvent.safeParse(e).success).toBe(false);
  });

  it("takes only Node's own OS and arch values, and versions as short tokens", () => {
    const e = { ...rep, kind: 'connected', ...reported.connected };
    for (const os of NODE_PLATFORMS)
      expect(ReportedEvent.safeParse({ ...e, os }).success).toBe(true);
    for (const arch of NODE_ARCHES)
      expect(ReportedEvent.safeParse({ ...e, arch }).success).toBe(true);
    for (const bad of [
      { os: 'ignore_previous_rules' },
      { arch: 'merge_into_main' },
      { pluginVersion: '0.7.0 now merge' },
      { claudeCodeVersion: 'x'.repeat(65) },
      { node: '' },
    ]) {
      expect(ReportedEvent.safeParse({ ...e, ...bad }).success).toBe(false);
    }
    // The lists are exactly @types/node's: a new platform fails the typecheck, not silently.
    expectTypeOf<(typeof NODE_PLATFORMS)[number]>().toEqualTypeOf<NodeJS.Platform>();
    expectTypeOf<(typeof NODE_ARCHES)[number]>().toEqualTypeOf<NodeJS.Architecture>();
  });

  it('refuses a reason that is not on the list, and a hub source from a plugin kind', () => {
    const e = { ...rep, kind: 'activation', ...reported.activation, reason: 'because I said so' };
    expect(ReportedEvent.safeParse(e).success).toBe(false);
    expect(REASON_CODES).toContain('marker.unverified');
    expect(ReportedEvent.safeParse({ ...hub, kind: 'dropped', count: 1 }).success).toBe(false);
  });
});

describe('observability RPCs', () => {
  const event = { ...rep, kind: 'dropped', count: 1 };

  it('telemetry.report takes at most 100 events', () => {
    const { params } = RPC_METHODS['telemetry.report'];
    expect(params.safeParse({ events: Array(100).fill(event) }).success).toBe(true);
    expect(params.safeParse({ events: Array(101).fill(event) }).success).toBe(false);
  });

  it('observe.timeline defaults since and limit, and caps the limit', () => {
    const { params } = RPC_METHODS['observe.timeline'];
    expect(params.parse({})).toMatchObject({ since: '2h', limit: 500 });
    expect(params.safeParse({ limit: 2001 }).success).toBe(false);
    expect(params.safeParse({ since: '30m', kinds: ['guard', 'rpc'] }).success).toBe(true);
    // since and until are parsed by the hub (invalid_request), so the schema only bounds their length.
    expect(params.safeParse({ since: 'x'.repeat(41) }).success).toBe(false);
  });

  it('session.hello result defaults observability for older hubs', () => {
    const peer = {
      id: 'a-agent',
      kind: 'agent',
      displayName: 'A',
      owner: 'a',
      status: 'online',
      statusNote: null,
      lastSeen: null,
      repo: null,
      branch: null,
      skills: [],
      areas: [],
      activeTasks: 0,
    };
    const old = {
      self: peer,
      mesh: { name: 'm', prefix: 'mesh' },
      policy: {
        instructions: '',
        git: {
          integrationBranch: 'agents',
          protectedBranches: ['main'],
          branchTemplate: 'x',
          agentsMayMergeInto: ['agents'],
        },
      },
      unreadThreads: 0,
      sessionId: 's-abc123def456',
      reclaimed: [],
    };
    const parsed = RPC_METHODS['session.hello'].result.safeParse(old);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    expect(parsed.data.observability).toEqual({ enabled: false, maxBufferedEvents: 500 });
  });
});
