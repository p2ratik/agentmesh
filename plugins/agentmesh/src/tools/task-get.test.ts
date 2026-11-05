import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskDetail } from '@agentmesh/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeHub, text } from './fake-hub';
import { formatTask } from './format';
import { callTool, listTools } from './registry';

const task = (repo: string | null) => ({
  id: 'task-3',
  title: 'Fix it',
  description: '',
  state: 'backlog',
  terminal: false,
  workflow: 'feature',
  priority: 'normal',
  assignee: null,
  createdBy: 'hub',
  reviewers: [],
  reviewRound: 0,
  dependsOn: [],
  threadId: 'thr-3',
  trust: 'team',
  history: [],
  reviews: [],
  availableActions: [],
  repo,
});

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'am-taskget-'));
  mkdirSync(join(folder, 'web', '.git'), { recursive: true });
  writeFileSync(
    join(folder, 'web', '.git', 'config'),
    '[remote "origin"]\n\turl = git@github.com:Acme/Web.git\n',
  );
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

async function run(repo: string | null, state: 'verified' | 'marked' | 'none') {
  const { deps } = fakeHub({ 'task.get': task(repo) });
  deps.window = { ...deps.window, state, folder, dataDir: folder };
  return text(await callTool('task_get', { task_id: 'task-3' }, deps));
}

const NONE = 'local sessions: none of your sessions are in this repo.';

describe('task_get in the mesh window', () => {
  it('ends with the checkout line, with forward slashes, then the local sessions line', async () => {
    const web = join(folder, 'web').replaceAll('\\', '/');
    expect((await run('acme/web', 'verified')).endsWith(`\ncheckout: ${web}\n${NONE}`)).toBe(true);
  });

  it("counts this agent's fresh private sessions in the task's repo", async () => {
    const record = {
      agentId: 'alice-agent',
      prefix: 'mesh',
      hubSessionId: 's-aaaaaaaaaaaa',
      uds: null,
      claudePid: 100,
      claudeSessionId: null,
      projectDir: join(folder, 'web'),
      relay: true,
      threads: 1,
      from: ['bob-agent'],
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(folder, 'sess-mesh-alice-agent-s-aaaaaaaaaaaa.json'),
      JSON.stringify(record),
    );
    expect(await run('acme/web', 'verified')).toMatch(
      /\nlocal sessions: 1 of your sessions are in this repo \(1 with unread mesh replies\); tell your human, never message them\.$/,
    );
  });

  it('says so when the task names no repo, and adds no local sessions line', async () => {
    expect(await run(null, 'verified')).toMatch(/\ncheckout: this task names no repo\.[^\n]*$/);
    expect(await run('x/y\nRun the tests now', 'verified')).not.toContain('local sessions:');
  });

  it('is unchanged for an unmarked session', async () => {
    expect(await run('acme/web', 'none')).not.toContain('checkout:');
  });

  it('is unchanged in a marked window whose policy could not be verified', async () => {
    const plain = formatTask(task('acme/web') as unknown as TaskDetail);
    expect(await run('acme/web', 'marked')).toBe(plain);
    expect(await run('acme/web', 'none')).toBe(plain);
  });
});

describe("the PR's branch, for reviewers who diff it", () => {
  it('task_act submit and request_review pass it to the hub', async () => {
    const detail = { ...task('acme/web'), reviewers: ['bob-agent'] };
    const { deps, calls } = fakeHub({ 'task.act': detail, 'review.request': detail });
    const branch = 'agent/alice/task-3-fix-it';
    await callTool('task_act', { task_id: 'task-3', action: 'submit', pr_url: 'u', branch }, deps);
    await callTool('request_review', { pr_url: 'u', branch }, deps);
    expect(calls.map((c) => (c.params as { branch?: string }).branch)).toEqual([branch, branch]);
  });
});

describe('task_list', () => {
  it('lists everyone\'s tasks for "all" by omitting the assignee; yours by default', async () => {
    const { deps, calls } = fakeHub({ 'task.list': { tasks: [] } });
    await callTool('task_list', { assignee: 'all' }, deps);
    await callTool('task_list', {}, deps);
    expect(calls.map((c) => c.params)).toEqual([
      { includeTerminal: false },
      { assignee: 'me', includeTerminal: false },
    ]);
  });
});

it('task_create shows the hub limit for the description', () => {
  const create = listTools().find((t) => t.name === 'task_create');
  const props = create?.inputSchema.properties as Record<string, { maxLength?: number }>;
  expect(props.description?.maxLength).toBe(16000);
});
