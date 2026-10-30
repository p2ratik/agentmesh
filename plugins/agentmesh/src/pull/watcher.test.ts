import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@agentmesh/common';
import { afterEach, describe, expect, it } from 'vitest';
import type { HubClient } from '../hub';
import { newActivationState } from '../tools/activation';
import { PullWatcher } from './watcher';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmesh-pull-'));
  dirs.push(dir);
  const calls: string[] = [];
  const peek = { threads: 2, actions: 1, from: ['bob-agent'], external: false };
  const hub = {
    sessionId: 's-aaaaaaaaaaaa' as string | null,
    call: async (method: string) => {
      calls.push(method);
      return peek;
    },
  } as unknown as Pick<HubClient, 'call' | 'sessionId'>;
  const activation = newActivationState();
  const watcher = new PullWatcher({
    hub,
    activation,
    agentId: 'alice-agent',
    prefix: 'mesh',
    dir,
    projectDir: '/work/api',
    logger: createLogger('test', { level: 'silent', destination: 'stderr' }),
  });
  const file = join(dir, 'pull-mesh-alice-agent-s-aaaaaaaaaaaa.json');
  return { dir, hub, activation, watcher, calls, file };
}

describe('PullWatcher', () => {
  it('writes counts and ids only while the session is active in pull mode', async () => {
    const { activation, watcher, calls, file } = setup();
    await watcher.refresh();
    expect(calls).toEqual([]); // not pull-active: no poll, no file
    expect(existsSync(file)).toBe(false);

    activation.pull = true;
    await watcher.refresh();
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(written).sort()).toEqual([
      'actions',
      'agentId',
      'external',
      'from',
      'projectDir',
      'sessionId',
      'threads',
      'updatedAt',
    ]);
    expect(written).toMatchObject({ agentId: 'alice-agent', threads: 2, from: ['bob-agent'] });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);

    activation.pull = false; // deactivate
    await watcher.refresh();
    expect(existsSync(file)).toBe(false);
  });

  it('moves the file with a new hub session and removes it on stop', async () => {
    const { dir, hub, activation, watcher } = setup();
    activation.pull = true;
    await watcher.refresh();
    hub.sessionId = 's-bbbbbbbbbbbb';
    await watcher.refresh();
    expect(readdirSync(dir)).toEqual(['pull-mesh-alice-agent-s-bbbbbbbbbbbb.json']);
    watcher.stop();
    expect(readdirSync(dir)).toEqual([]);
  });
});
