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

const UDS = `uds:\\\\.\\pipe\\LOCAL\\cc-msg-${'a'.repeat(32)}`;
const SESS = 'sess-mesh-alice-agent-s-aaaaaaaaaaaa.json';

function setup({
  meshWindow = false,
  marked = meshWindow,
  relay = true,
}: {
  meshWindow?: boolean;
  marked?: boolean;
  relay?: boolean;
} = {}) {
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
  const conversation = { id: null as string | null };
  const watcher = new PullWatcher({
    hub,
    activation,
    agentId: 'alice-agent',
    prefix: 'mesh',
    dir,
    projectDir: '/work/api',
    meshWindow,
    marked,
    uds: UDS,
    claudePid: 4242,
    claudeSessionId: () => conversation.id,
    relay,
    logger: createLogger('test', { level: 'silent', destination: 'stderr' }),
  });
  const file = join(dir, 'pull-mesh-alice-agent-s-aaaaaaaaaaaa.json');
  const beat = join(dir, 'push-mesh-alice-agent-s-aaaaaaaaaaaa.json');
  const sess = join(dir, SESS);
  return { beat, dir, hub, activation, watcher, calls, file, sess, conversation };
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

  it('writes a private record only after a mesh call, with the peek counts', async () => {
    const { watcher, calls, sess } = setup();
    await watcher.refresh();
    expect(existsSync(sess)).toBe(false);
    expect(calls).toEqual([]);
    watcher.markUsed();
    await watcher.refresh();
    const written = JSON.parse(readFileSync(sess, 'utf8'));
    expect(written).toEqual({
      agentId: 'alice-agent',
      prefix: 'mesh',
      hubSessionId: 's-aaaaaaaaaaaa',
      uds: UDS,
      claudePid: 4242,
      claudeSessionId: null,
      projectDir: '/work/api',
      relay: true,
      threads: 2,
      from: ['bob-agent'],
      updatedAt: expect.any(String),
    });
    expect(calls).toContain('inbox.peek');
    watcher.stop();
    expect(existsSync(sess)).toBe(false);
  });

  it('drops the record when the session activates; the mesh window never writes one', async () => {
    const { activation, watcher, sess, beat } = setup();
    watcher.markUsed();
    await watcher.refresh();
    expect(existsSync(sess)).toBe(true);
    activation.lastDescription = 'api work';
    await watcher.refresh();
    expect(existsSync(sess)).toBe(false);
    expect(existsSync(beat)).toBe(true);

    const win = setup({ meshWindow: true });
    win.watcher.markUsed();
    await win.watcher.refresh();
    expect(readdirSync(win.dir)).toEqual([]);
    expect(win.calls).toEqual([]);
  });

  it('a marked but unverified session never writes a record, so the window never forwards to it', async () => {
    const { watcher, dir, calls } = setup({ meshWindow: false, marked: true });
    watcher.markUsed();
    await watcher.refresh();
    expect(readdirSync(dir)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("the record's claudeSessionId follows the session's conversation", async () => {
    const { watcher, sess, conversation } = setup();
    watcher.markUsed();
    await watcher.refresh();
    expect(JSON.parse(readFileSync(sess, 'utf8'))).toMatchObject({ claudeSessionId: null });
    conversation.id = '0b6c1a52-3e9f-4d2a-9c11-5f2e8a7d4b10';
    await watcher.refresh();
    expect(JSON.parse(readFileSync(sess, 'utf8'))).toMatchObject({
      claudeSessionId: conversation.id,
    });
  });

  it('records relay off', async () => {
    const { watcher, sess } = setup({ relay: false });
    watcher.markUsed();
    await watcher.refresh();
    expect(JSON.parse(readFileSync(sess, 'utf8'))).toMatchObject({ relay: false });
  });

  it("the mesh window's heartbeat carries its prefix and address", async () => {
    for (const meshWindow of [true, false]) {
      const { activation, watcher, beat } = setup({ meshWindow });
      activation.lastDescription = 'team work';
      await watcher.refresh();
      expect(JSON.parse(readFileSync(beat, 'utf8'))).toMatchObject({
        agentId: 'alice-agent',
        prefix: 'mesh',
        meshWindow,
        uds: meshWindow ? UDS : null,
      });
    }
  });
});
