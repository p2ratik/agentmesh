import { randomUUID } from 'node:crypto';
import type { ReportedEvent } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { testTeamConfig } from '../../testing/fixtures';
import { createTestHarness } from '../../testing/harness';
import { ObserveService } from './observe.service';

const tool = (over: Partial<ReportedEvent> = {}, at = '2026-10-16T09:00:00.000Z') =>
  ({
    id: randomUUID(),
    at,
    session: null,
    source: 'plugin',
    kind: 'tool',
    tool: 'ask',
    outcome: 'ok',
    ms: 5,
    ...over,
  }) as ReportedEvent;
const SESSION = 's-ab12cd34ef56';
const count = (ctx: ReturnType<typeof createTestHarness>['ctx']) =>
  ctx.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM events')[0]?.n;

describe('ObserveService (review fixes)', () => {
  it("another agent reusing an event id cannot hide this agent's event", () => {
    const { ctx } = createTestHarness();
    const service = new ObserveService(ctx, () => true);
    const event = tool();
    service.report('alice-agent', [event]);
    service.report('bob-agent', [event]);
    expect(count(ctx)).toBe(2);
    expect(service.query({ agent: 'alice-agent' })).toHaveLength(1);
  });

  it("forgets an agent's budget entry once its window is empty", () => {
    const { ctx, clock } = createTestHarness();
    const service = new ObserveService(ctx, () => true);
    service.report('alice-agent', [tool()]);
    expect(service.trackedAgents).toBe(1);
    clock.advance(61_000);
    service.report('alice-agent', []);
    expect(service.trackedAgents).toBe(0);
  });

  it('a replayed event still costs budget, so replays are not free', () => {
    const { ctx } = createTestHarness(testTeamConfig({ observability: { maxEventsPerMinute: 3 } }));
    const service = new ObserveService(ctx, () => true);
    const event = tool();
    expect(service.report('alice-agent', [event, event, event, event, event])).toEqual({
      accepted: 3,
      dropped: 2,
    });
    expect(count(ctx)).toBe(1);
  });

  it("stores session null when the session is not the caller's own", () => {
    const { ctx } = createTestHarness();
    const owns = (agent: string, session: string) => agent === 'alice-agent' && session === SESSION;
    const service = new ObserveService(ctx, owns);
    service.report('alice-agent', [
      tool({ session: SESSION }),
      tool({ session: 's-ffffffffffff' }),
    ]);
    service.report('bob-agent', [tool({ session: SESSION })]);
    const bySession = (agent: string) => service.query({ agent }).map((e) => e.session);
    expect(bySession('alice-agent').sort()).toEqual([null, SESSION]);
    expect(bySession('bob-agent')).toEqual([null]);
    const body = ctx.db.all<{ body: string }>("SELECT body FROM events WHERE agent = 'bob-agent'");
    expect(JSON.parse(body[0]?.body ?? '{}').session).toBeNull();
  });

  it('query returns the newest events first, up to the limit', () => {
    const { ctx, clock } = createTestHarness();
    const service = new ObserveService(ctx, () => true);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = tool();
      ids.push(e.id);
      service.report('alice-agent', [e]);
      clock.advance(1000);
    }
    expect(service.query({ limit: 2 }).map((e) => e.id)).toEqual([ids[2], ids[1]]);
  });
});
