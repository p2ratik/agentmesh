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
    meshWindow: false,
    logger: createLogger('test', { level: 'silent', destination: 'stderr' }),
  });
  const file = join(dir, 'pull-mesh-alice-agent-s-aaaaaaaaaaaa.json');
  const beat = join(dir, 'push-mesh-alice-agent-s-aaaaaaaaaaaa.json');
  return { beat, dir, hub, activation, watcher, calls, file };
}

describe('PullWatcher', () => {
  it('an active push session keeps a heartbeat file and drops it when it stops', async () => {
    const { activation, watcher, calls, beat } = setup();
    activation.lastDescription = 'api work';
    await watcher.refresh();
    expect(calls).toEqual([]);
    expect(JSON.parse(readFileSync(beat, 'utf8'))).toMatchObject({
      agentId: 'alice-agent',
      sessionId: 's-aaaaaaaaaaaa',
      meshWindow: false,
    });
    activation.lastDescription = null;
    await watcher.refresh();
    expect(existsSync(beat)).toBe(false);
  });

  it('writes no heartbeat while it waits for its re-check', async () => {
    const { activation, watcher, beat } = setup();
    activation.lastDescription = 'api work';
    activation.renewedFrom = 'api work';
    await watcher.refresh();
    expect(existsSync(beat)).toBe(false);
  });

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
