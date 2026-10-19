import { createLogger } from '@agentmesh/common';
import { ConfigIndex, configFromObject } from '@agentmesh/config';
import { describe, expect, it } from 'vitest';
import { suggest } from './commands/autocomplete';
import {
  askParams,
  planStartParams,
  splitIds,
  taskCancelParams,
  taskCreateParams,
} from './commands/params';
import { meshStatus } from './commands/replies';
import { parsePlanButtonId, planButtonId } from './custom-ids';
import { chunkMessage } from './discord/chunk';
import { ChannelDirectory, resolvePurpose } from './discord/directory';
import { EchoGuard } from './echo';
import { handleFeedMessage } from './feed/consumer';
import type { Executor } from './feed/executor';
import type { PostIntent } from './render/intents';

const index = new ConfigIndex(
  configFromObject({
    version: 1,
    mesh: { name: 'acme' },
    humans: [{ id: 'alice', displayName: 'Alice' }],
    agents: [
      { id: 'alice-agent', owner: 'alice' },
      { id: 'bob-agent', owner: 'alice' },
    ],
    areas: [{ id: 'api', description: 'Render API', owners: ['alice-agent'] }],
  }).config,
);

describe('chunkMessage', () => {
  it('respects the 2000 limit on line boundaries and keeps code fences balanced', () => {
    const text = [
      '```ts',
      ...Array.from({ length: 300 }, (_, i) => `const line${i} = ${i};`),
      '```',
    ].join('\n');
    const chunks = chunkMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
      expect((chunk.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
    expect(chunkMessage('   ')).toEqual([]);
    expect(chunkMessage('x'.repeat(4500)).every((c) => c.length <= 2000)).toBe(true);
  });
});

describe('command plumbing', () => {
  it('maps options to RPC params', () => {
    expect(splitIds('a, b,,c')).toEqual(['a', 'b', 'c']);
    expect(
      planStartParams({ topic: 'T', participants: null, facilitator: 'bob-agent', minutes: 15 }),
    ).toEqual({
      topic: 'T',
      facilitator: 'bob-agent',
      roundMinutes: 15,
    });
    expect(
      taskCreateParams({
        title: 'X',
        description: null,
        area: 'api',
        repo: null,
        assignee: null,
        priority: 'high',
      }),
    ).toEqual({ title: 'X', description: '', area: 'api', priority: 'high' });
    expect(taskCancelParams('task-1', null)).toEqual({ taskId: 'task-1', action: 'cancel' });
    expect(askParams('bob-agent', 'q?')).toEqual({ kind: 'ask', to: ['bob-agent'], body: 'q?' });
  });

  it('autocompletes agents, areas and the board', () => {
    expect(suggest(index, 'ask', null, 'agent', 'bo').map((c) => c.value)).toEqual(['bob-agent']);
    expect(suggest(index, 'task', 'list', 'assignee', '')[0]?.value).toBe('unassigned');
    expect(suggest(index, 'task', 'create', 'area', 'render')).toEqual([
      { name: 'api — Render API', value: 'api' },
    ]);
  });

  it('round-trips plan button ids and rejects foreign ones', () => {
    expect(parsePlanButtonId(planButtonId('approve', 'plan-7'))).toEqual({
      action: 'approve',
      planId: 'plan-7',
    });
    expect(parsePlanButtonId('perm:allow:abcde')).toBeNull();
  });

  it('falls back to configured purposes', () => {
    const available = new Set(['council', 'tasks', 'events']);
    expect(resolvePurpose('reviews', available)).toBe('tasks');
    expect(resolvePurpose('alerts', available)).toBe('events');
    expect(resolvePurpose('custom', available)).toBe('events');
    expect(new ChannelDirectory(new Map([['events', '42']])).channelFor('alerts')).toBe('42');
  });

  it('renders mesh status', () => {
    const text = meshStatus({
      name: 'acme',
      paused: true,
      pausedReason: 'incident',
      peers: [
        {
          id: 'bob-agent',
          kind: 'agent',
          displayName: 'Bob',
          owner: 'alice',
          status: 'busy',
          statusNote: 'deploy',
          lastSeen: null,
          repo: 'acme/api',
          branch: 'main',
          skills: [],
          areas: [],
          activeTasks: 2,
        },
      ],
      counts: { openThreads: 3, openTasks: 2, activePlans: 1, heldDeliveries: 4 },
    });
    expect(text).toContain('PAUSED (incident)');
    expect(text).toContain('🟠 **bob-agent** busy — deploy · 2 task(s) · acme/api@main');
  });
});

describe('feed handling', () => {
  const logger = createLogger('test', { level: 'silent', destination: 'stderr' });
  const feedMessage = (event: unknown) => ({ subject: 'mesh.evt.x', json: <T>() => event as T });
  const setup = () => {
    const performed: PostIntent[] = [];
    const executor = {
      perform: async (i: PostIntent) => void performed.push(i),
    } as unknown as Executor;
    const echo = new EchoGuard();
    const refreshes = { count: 0 };
    const options = {
      js: null as never,
      prefix: 'mesh',
      serviceId: 'discord-bridge',
      index: () => index,
      onMembersChanged: async () => {
        refreshes.count += 1;
      },
      executor,
      echo,
      logger,
      signal: new AbortController().signal,
    };
    return { performed, echo, options, refreshes };
  };

  it('performs routed intents, skips echoes and drops garbage', async () => {
    const { performed, echo, options } = setup();
    const event = {
      id: 'evt-1',
      type: 'mesh.resumed',
      at: '2026-10-16T09:00:00Z',
      data: { by: 'alice', released: 2 },
    };
    expect(await handleFeedMessage(feedMessage(event), options)).toBe('ack');
    expect(performed[0]?.content).toContain('released 2 held deliveries');
    expect(await handleFeedMessage(feedMessage({ nope: true }), options)).toBe('drop');

    echo.remember('msg-echo');
    const echoed = {
      id: 'evt-2',
      type: 'message.created',
      at: '',
      data: { message: { id: 'msg-echo' }, thread: {} },
    };
    expect(await echo.isEcho('msg-echo')).toBe(true);
    expect(await handleFeedMessage(feedMessage(echoed), options)).toBe('drop');
  });

  it('re-reads the team on member events and posts nothing for them', async () => {
    const { performed, options, refreshes } = setup();
    const member = {
      humanId: 'dana',
      agentId: 'dana-agent',
      displayName: 'Dana',
      discordUserId: '100000000000000009',
      roles: [],
      skills: [],
      nkey: `U${'A'.repeat(55)}`,
      status: 'revoked',
      invitedBy: 'alice',
      joinedAt: '2026-10-19T09:00:00.000Z',
      removedAt: '2026-10-19T10:00:00.000Z',
    };
    const event = {
      id: 'evt-3',
      type: 'member.removed',
      at: '2026-10-19T10:00:00.000Z',
      data: { member, by: 'alice' },
    };
    expect(await handleFeedMessage(feedMessage(event), options)).toBe('ack');
    expect(refreshes.count).toBe(1);
    expect(performed).toEqual([]);
  });

  it('waits for in-flight relays before deciding an event is not an echo', async () => {
    const echo = new EchoGuard();
    let resolveRelay: (id: string) => void = () => undefined;
    void echo.track(new Promise<string>((r) => (resolveRelay = r)));
    const decision = echo.isEcho('msg-9');
    resolveRelay('msg-9');
    expect(await decision).toBe(true);
  });
});
