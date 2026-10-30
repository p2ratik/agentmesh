import { MeshError } from '@agentmesh/common';
import type { SessionDelivery } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import type { HubClient } from '../hub';
import { fakeHub, text } from './fake-hub';
import { callTool, listTools } from './registry';

const task = {
  id: 'task-3',
  title: 'Fix login',
  state: 'in_progress',
  assignee: 'alice-agent',
  availableActions: ['block', 'submit'],
};

const sent = { threadId: 'thr-2', messageId: 'msg-1', deliveredTo: ['bob-agent'], held: false };

const fyiItem = (id: string, body: string, threadId = 'thr-5'): SessionDelivery => ({
  id,
  threadId,
  kind: 'reply',
  from: { id: 'bob-agent', kind: 'agent', displayName: "Bob's Claude" },
  to: ['alice-agent'],
  subject: 'Billing v2',
  body,
  status: 'working',
  trust: 'team',
  depth: 1,
  refs: {},
  createdAt: '2026-10-22T09:00:00.000Z',
  class: 'status',
});

const thread = (id: string, subject: string, taskId: string | null) => ({
  id,
  kind: taskId ? 'task' : 'conversation',
  subject,
  createdBy: 'bob-agent',
  createdAt: '2026-10-22T08:00:00.000Z',
  updatedAt: '2026-10-22T09:00:00.000Z',
  depth: 0,
  parentId: null,
  participants: ['alice-agent', 'bob-agent'],
  taskId,
  planId: null,
  status: 'open',
  messageCount: 3,
});

describe('tool registry', () => {
  it('lists every tool with an object JSON schema', () => {
    const tools = listTools();
    expect(tools.length).toBe(25);
    const ask = tools.find((t) => t.name === 'ask');
    expect(ask?.inputSchema.type).toBe('object');
    expect(ask?.inputSchema).not.toHaveProperty('$schema');
    expect(ask?.inputSchema.required).toEqual(['to', 'text']);
  });

  it('maps snake_case arguments to RPC params with an idempotency key', async () => {
    const { deps, calls } = fakeHub({ 'message.send': sent });
    const result = await callTool(
      'ask',
      { to: 'bob-agent', text: 'hi', parent_thread_id: 'thr-1' },
      deps,
    );
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('thr-2');
    expect(calls[0]?.params).toEqual({
      kind: 'ask',
      to: ['bob-agent'],
      body: 'hi',
      parentThreadId: 'thr-1',
    });
    expect(calls[0]?.options).toEqual({ idempotencyKey: expect.any(String) });
  });

  it('ask passes to_session and repo', async () => {
    const { deps, calls } = fakeHub({ 'message.send': sent });
    await callTool(
      'ask',
      { to: 'bob-agent', text: 'hi', to_session: 's-bbbbbbbbbbbb', repo: 'opzami/web' },
      deps,
    );
    expect(calls[0]?.params).toMatchObject({ toSession: 's-bbbbbbbbbbbb', repo: 'opzami/web' });
  });

  it('peers prints active sessions', async () => {
    const bob = {
      id: 'bob-agent',
      kind: 'agent',
      displayName: "Bob's Claude",
      owner: 'bob',
      status: 'online',
      statusNote: null,
      lastSeen: null,
      repo: null,
      branch: null,
      skills: [],
      areas: [],
      activeTasks: 1,
      sessions: [
        {
          id: 's-bbbbbbbbbbbb',
          description: 'checkout redesign',
          repo: 'opzami/web',
          branch: 'agent/bob/task-7-checkout',
          activeSince: '2026-10-21T09:00:00.000Z',
          tasks: ['task-7'],
        },
        {
          id: 's-cccccccccccc',
          delivery: 'pull',
          description: 'reading docs',
          repo: null,
          branch: null,
          activeSince: '2026-10-21T10:00:00.000Z',
          tasks: [],
        },
      ],
    };
    const { deps } = fakeHub({ 'peers.list': { peers: [bob] } });
    const lines = text(await callTool('peers', {}, deps)).split('\n');
    expect(lines[0]).toMatch(/^- bob-agent /);
    expect(lines.slice(1)).toEqual([
      '    · s-bbbbbbbbbbbb — checkout redesign (opzami/web@agent/bob/task-7-checkout) owns task-7',
      '    · s-cccccccccccc — reading docs [pull: reads on its next prompt]',
    ]);
  });

  it('inbox names the unread threads other sessions own, so the human can take them', async () => {
    const otherSessions = [
      { threadId: 'thr-4', sessionId: 's-aaaaaaaaaaaa', liveness: 'away' },
      { threadId: 'thr-9', sessionId: 's-bbbbbbbbbbbb', liveness: 'live' },
    ];
    const inbox = (others: unknown[]) =>
      fakeHub({ 'inbox.get': { threads: [], remainingThreads: 0, otherSessions: others } }).deps;
    expect(text(await callTool('inbox', {}, inbox(otherSessions)))).toBe(
      '(2 unread thread(s) belong to your other sessions: thr-4 (s-aaaaaaaaaaaa, away), ' +
        'thr-9 (s-bbbbbbbbbbbb, live))',
    );
    expect(text(await callTool('inbox', {}, inbox([])))).toBe('Inbox zero — nothing unread.');
  });

  it('tool results end with hub notes', async () => {
    const note = 'thr-2 belongs to your session s-bbbbbbbbbbbb (“billing”); its messages go there.';
    const { deps } = fakeHub({ 'message.send': sent }, { 'message.send': [note] });
    const result = await callTool('reply', { thread_id: 'thr-2', text: 'on it' }, deps);
    expect(result.content).toHaveLength(2);
    expect(text(result, 1)).toBe(note);
    const { deps: quiet } = fakeHub({ 'message.send': sent });
    expect(
      (await callTool('reply', { thread_id: 'thr-2', text: 'ok' }, quiet)).content,
    ).toHaveLength(1);
  });

  it('tool results end with buffered FYIs, which are then reported seen', async () => {
    const note = 'thr-2 belongs to your session s-bbbbbbbbbbbb (“billing”); its messages go there.';
    const { deps, calls } = fakeHub({ 'message.send': sent }, { 'message.send': [note] });
    deps.fyi.add([fyiItem('m7', 'PR is up')]);
    const result = await callTool('reply', { thread_id: 'thr-2', text: 'on it' }, deps);
    expect(result.content.map((c) => c.text)).toEqual([
      'Replied in thr-2 to bob-agent (msg-1).',
      note,
      'FYI (1):\n· thr-5 «Billing v2» PR is up',
    ]);
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ['message.send', expect.anything()],
      ['messages.seen', { messageIds: ['m7'] }],
    ]);
    // Shown once; errors carry FYIs too.
    expect(
      (await callTool('reply', { thread_id: 'thr-2', text: 'ok' }, deps)).content,
    ).toHaveLength(2);
    deps.fyi.add([fyiItem('m8', 'merged')]);
    const refused = await callTool('ask', { text: 'no recipient' }, deps);
    expect(refused.isError).toBe(true);
    expect(text(refused, 1)).toBe('FYI (1):\n· thr-5 «Billing v2» merged');
    expect(calls.filter((c) => c.method === 'messages.seen')).toHaveLength(2);
  });

  // The MCP SDK still runs a cancelled call to the end, then drops its result.
  it('a cancelled call leaves its FYIs buffered and reports nothing', async () => {
    const { deps, calls } = fakeHub({ 'message.send': sent });
    deps.fyi.add([fyiItem('m7', 'PR is up')]);
    const cancel = new AbortController();
    cancel.abort();
    const result = await callTool(
      'reply',
      { thread_id: 'thr-2', text: 'on it' },
      deps,
      cancel.signal,
    );
    expect(result.content).toHaveLength(1);
    expect(calls.map((c) => c.method)).toEqual(['message.send']);
    expect(deps.fyi.take().items.map((m) => m.id)).toEqual(['m7']);
  });

  it('inbox shows Needs you before FYI', async () => {
    const needs = {
      thread: thread('thr-1', 'Login', null),
      unread: 1,
      messages: [fyiItem('m1', 'Does the web client handle 409?', 'thr-1')],
      fyi: false,
    };
    const fyi = {
      thread: thread('thr-5', 'Billing v2', 'task-3'),
      unread: 2,
      messages: [fyiItem('m2', 'started'), fyiItem('m3', 'PR is up\nCI pending')],
      fyi: true,
    };
    const inbox = (threads: unknown[]) =>
      fakeHub({ 'inbox.get': { threads, remainingThreads: 0, otherSessions: [] } }).deps;
    const fyiLine =
      '· 2 unread · thr-5 «Billing v2» · task · open · participants: alice-agent, bob-agent · task-3 — PR is up';
    const both = text(await callTool('inbox', {}, inbox([needs, fyi])));
    expect(both).toMatch(/^Needs you:\n1 unread · thr-1 «Login» /);
    expect(both).toContain('Does the web client handle 409?');
    expect(both.endsWith(`\n\n====\n\nFYI:\n${fyiLine}`)).toBe(true);
    expect(text(await callTool('inbox', {}, inbox([fyi])))).toBe(`FYI:\n${fyiLine}`);
  });

  it('overlapping tool calls each get only their own hub notes', async () => {
    const release: Array<() => void> = [];
    const hub = {
      call: (_method: string, params: { body: string }, _options: unknown, sink?: string[]) =>
        new Promise((resolve) => {
          release.push(() => {
            sink?.push(`note for ${params.body}`);
            resolve(sent);
          });
        }),
    } as unknown as HubClient;
    const { deps } = fakeHub({});
    const scoped = { ...deps, hub };
    const first = callTool('reply', { thread_id: 'thr-1', text: 'one' }, scoped);
    const second = callTool('reply', { thread_id: 'thr-2', text: 'two' }, scoped);
    expect(release).toHaveLength(2);
    for (const answer of release.reverse()) answer();
    expect(text(await first, 1)).toBe('note for one');
    expect(text(await second, 1)).toBe('note for two');
    expect((await first).content).toHaveLength(2);
    expect((await second).content).toHaveLength(2);
  });

  it('maps task actions and reports next steps', async () => {
    const { deps, calls } = fakeHub({ 'task.act': task });
    const result = await callTool(
      'task_act',
      { task_id: 'task-3', action: 'submit', pr_url: 'https://x/pr/1' },
      deps,
    );
    expect(calls[0]?.params).toEqual({
      taskId: 'task-3',
      action: 'submit',
      prUrl: 'https://x/pr/1',
    });
    expect(text(result)).toContain('Next for you: block, submit');
  });

  it('converts plan drafts to camelCase', async () => {
    const { deps, calls } = fakeHub({
      'plan.submit': { id: 'plan-1', state: 'materialized', taskIds: ['task-1'] },
    });
    await callTool(
      'plan_submit',
      {
        plan_id: 'plan-1',
        summary: 's',
        tasks: [{ key: 'a', title: 'Do a', depends_on: [], done_when: 'tests pass' }],
      },
      deps,
    );
    expect(calls[0]?.params).toMatchObject({
      tasks: [{ key: 'a', title: 'Do a', description: '', dependsOn: [], doneWhen: 'tests pass' }],
    });
  });

  it('turns bad arguments, hub errors and missing setup into readable errors', async () => {
    const { deps } = fakeHub({ 'task.get': new MeshError('not_found', 'Task task-9 not found') });
    expect(text(await callTool('ask', { text: 'no recipient' }, deps))).toMatch(
      /Invalid arguments.*\n.*to/,
    );
    const notFound = await callTool('task_get', { task_id: 'task-9' }, deps);
    expect(notFound).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'not_found: Task task-9 not found' }],
    });
    const unconfigured = await callTool('peers', {}, { problems: ['agent_id is not set'] });
    expect(text(unconfigured)).toContain('agent_id is not set');
    expect((await callTool('nope', {}, deps)).isError).toBe(true);
  });
});
