import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskDetail } from '@agentmesh/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeHub, text } from './fake-hub';
import { formatTask } from './format';
import { callTool } from './registry';

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
  deps.window = { ...deps.window, state, folder };
  return text(await callTool('task_get', { task_id: 'task-3' }, deps));
}

describe('task_get in the mesh window', () => {
  it('ends with the checkout line, with forward slashes', async () => {
    const web = join(folder, 'web').replaceAll('\\', '/');
    expect((await run('acme/web', 'verified')).endsWith(`\ncheckout: ${web}`)).toBe(true);
  });

  it('says so when the task names no repo', async () => {
    expect(await run(null, 'verified')).toMatch(/\ncheckout: this task names no repo\./);
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
