import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, type Logger } from '@agentmesh/common';
import type { SessionRelay } from '@agentmesh/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelEvent } from '../inbox/render';
import { newActivationState } from '../tools/activation';
import { fakeHub } from '../tools/fake-hub';
import { callTool } from '../tools/registry';
import { GUARD_STAMP } from '../window/guard-stamp';
import { readForwards } from './forward-record';
import type { LocalSession } from './local-session';
import { pointerText } from './pointer';
import { forwardRelay, type WindowRelayDeps } from './window-relay';

const HEX = 'a'.repeat(32);
const PRIVATE = `uds:\\\\.\\pipe\\LOCAL\\cc-msg-${HEX}`;
const WINDOW = `uds:\\\\.\\pipe\\LOCAL\\cc-msg-${'b'.repeat(32)}`;
const ID = 'msg-01JC9Z8Q4W6Y7X5V3T2R1P0N9M';
const FIELDS = { from: 'alice-agent', threadId: 'thr-12', messageId: ID };
const RELAY: SessionRelay = { type: 'relay', ...FIELDS, forSession: 's-aaaaaaaaaaaa' };
const now = Date.parse('2026-11-04T10:00:00Z');
const GUARD_OLD = 'the guard is older than 0.6.0 or not running';
const NO_RECORD = 'no fresh record for that session';

let dataDir: string;
let pushed: ChannelEvent[];
let logger: Logger;

function writeRecord(over: Partial<LocalSession> = {}, at = now): void {
  const record: LocalSession = {
    agentId: 'bob-agent',
    prefix: 'mesh',
    hubSessionId: 's-aaaaaaaaaaaa',
    uds: PRIVATE,
    claudePid: 100,
    claudeSessionId: null,
    projectDir: '/work/api',
    relay: true,
    threads: 1,
    from: ['alice-agent'],
    updatedAt: new Date(at - 10_000).toISOString(),
    ...over,
  };
  writeFileSync(join(dataDir, 'sess-mesh-bob-agent-s-aaaaaaaaaaaa.json'), JSON.stringify(record));
}

function deps(over: Partial<WindowRelayDeps> = {}): WindowRelayDeps {
  return {
    window: { state: 'verified', policy: null, setUp: true, dataDir, folder: '.' },
    agentId: 'bob-agent',
    prefix: 'mesh',
    ownUds: WINDOW,
    ownSession: 's-wwwwwwwwwwww',
    guardVersion: '0.6.0',
    platform: 'win32',
    now,
    push: async (event) => {
      pushed.push(event);
    },
    logger,
    ...over,
  };
}

const forwards = () => readdirSync(dataDir).filter((f) => f.startsWith('fwd-'));

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'am-relay-'));
  pushed = [];
  logger = createLogger('test', { level: 'silent', destination: 'stderr' });
  writeRecord();
});

afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe('the mesh window forwarding a relay', () => {
  it('writes the guard record, pushes the pointer and answers forwarded', async () => {
    expect(await forwardRelay(RELAY, deps())).toEqual({ forwarded: true, reason: 'forwarded' });
    expect(pushed).toEqual([
      {
        content: pointerText(FIELDS),
        meta: { kind: 'relay', thread_id: 'thr-12', message_id: ID, forward_to: PRIVATE },
      },
    ]);
    expect(readForwards(dataDir, HEX, now)).toEqual([
      { name: `fwd-${HEX}-${ID}.json`, fields: FIELDS },
    ]);
  });

  it('refuses, with its reason, and writes nothing', async () => {
    const rows: Array<[string, () => Partial<WindowRelayDeps> | undefined, SessionRelay?]> = [
      ['not the mesh window', () => ({ window: { ...deps().window, state: 'marked' } })],
      ['relay is off on linux', () => ({ platform: 'linux' })],
      // Activation recorded a 0.5.0 stamp, a version-less one (a 0.5.0 guard), or none.
      [GUARD_OLD, () => ({ guardVersion: '0.5.0' })],
      [GUARD_OLD, () => ({ guardVersion: null })],
      [NO_RECORD, () => void writeRecord({ updatedAt: new Date(now - 180_000).toISOString() })],
      [NO_RECORD, () => ({ ownSession: 's-aaaaaaaaaaaa' })],
      ['that session turned relay off', () => void writeRecord({ relay: false })],
      ['its address is not a valid local address', () => void writeRecord({ uds: 'uds:/tmp/x' })],
      ['that session is this window', () => ({ ownUds: PRIVATE })],
      ['the pointer fields are invalid', () => undefined, { ...RELAY, from: 'Bob' }],
    ];
    for (const [reason, arrange, relay = RELAY] of rows) {
      writeRecord();
      const over = arrange();
      expect(await forwardRelay(relay, deps(over)), reason).toEqual({ forwarded: false, reason });
      expect(reason.length).toBeLessThanOrEqual(200);
    }
    expect(pushed).toEqual([]);
    expect(forwards()).toEqual([]);
  });

  it('removes the guard record when the push fails, and logs ids only', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const push = async () => {
      expect(forwards()).toHaveLength(1);
      throw new Error('transport closed');
    };
    const answer = await forwardRelay(RELAY, deps({ push }));
    expect(answer).toEqual({ forwarded: false, reason: 'the push failed' });
    expect(forwards()).toEqual([]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { err: expect.any(Error), thread: 'thr-12', message: ID },
      expect.any(String),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(HEX);
  });

  // Final review M1: a hub restart or a slow ack resends the relay; the window pushes it once.
  it('pushes a pointer once: a fresh or claimed record answers already forwarded', async () => {
    const again = { forwarded: true, reason: 'already forwarded' };
    expect(await forwardRelay(RELAY, deps())).toEqual({ forwarded: true, reason: 'forwarded' });
    expect(await forwardRelay(RELAY, deps())).toEqual(again);
    writeFileSync(join(dataDir, `fwd-${HEX}-${ID}.json.claimed`), '');
    rmSync(join(dataDir, `fwd-${HEX}-${ID}.json`));
    expect(await forwardRelay(RELAY, deps())).toEqual(again);
    expect(pushed).toHaveLength(1);
    expect(forwards()).toEqual([`fwd-${HEX}-${ID}.json.claimed`]);
  });

  it('pushes again once the unclaimed record has expired', async () => {
    await forwardRelay(RELAY, deps());
    const later = now + 600_001;
    writeRecord({}, later);
    expect(await forwardRelay(RELAY, deps({ now: later }))).toMatchObject({ forwarded: true });
    expect(pushed).toHaveLength(2);
  });

  it('answers, and pushes nothing, when the guard record cannot be written', async () => {
    // Renaming the staged file onto a folder fails on Windows and POSIX alike.
    mkdirSync(join(dataDir, `fwd-${HEX}-${ID}.json`));
    const answer = await forwardRelay(RELAY, deps());
    expect(answer).toEqual({ forwarded: false, reason: 'could not write the guard record' });
    expect(pushed).toEqual([]);
  });
});

describe('the guard version recorded at activation', () => {
  const view = { id: 's-wwwwwwwwwwww', active: true, delivery: 'push', description: 'mesh window' };
  function windowTool() {
    const { deps: tool } = fakeHub({
      'session.activate': { ...view, repo: null, branch: null, owns: [] },
      'session.deactivate': { ok: true },
    });
    tool.window = { state: 'verified', policy: null, setUp: true, dataDir, folder: '.' };
    return tool;
  }
  /** Activates the verified window over this stamp; resolves with the version it recorded. */
  async function activate(stamp: object | null, tool = windowTool()): Promise<string | null> {
    const file = join(dataDir, GUARD_STAMP);
    rmSync(file, { force: true });
    if (stamp) writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...stamp }));
    await callTool('activate', { code: 'c-1', description: 'mesh window' }, tool);
    return tool.activation.guardVersion;
  }

  it('forwards behind a 0.6.0 guard though its stamp is 10 minutes old', async () => {
    const guardVersion = await activate({ version: '0.6.0' });
    const later = Date.now() + 600_000;
    writeRecord({}, later);
    const answer = await forwardRelay(RELAY, deps({ guardVersion, now: later }));
    expect(answer).toEqual({ forwarded: true, reason: 'forwarded' });
  });

  it('refuses after activating over a version-less or 0.5.0 stamp, or never activating', async () => {
    const recorded = [
      await activate({}),
      await activate({ version: '0.5.0' }),
      await activate(null), // the guard did not run: activate refuses and records nothing
      newActivationState().guardVersion,
    ];
    expect(recorded).toEqual([null, '0.5.0', null, null]);
    for (const guardVersion of recorded) {
      const answer = await forwardRelay(RELAY, deps({ guardVersion }));
      expect(answer).toEqual({ forwarded: false, reason: GUARD_OLD });
    }
    expect(forwards()).toEqual([]);
  });

  it('a later activation overwrites it; a down guard or deactivate clears it', async () => {
    const tool = windowTool();
    expect(await activate({ version: '0.6.0' }, tool)).toBe('0.6.0');
    expect(await activate({}, tool)).toBeNull(); // a downgrade overwrites
    expect(await activate({ version: '0.6.0' }, tool)).toBe('0.6.0');
    expect(await activate(null, tool)).toBeNull(); // GUARD_DOWN: the guard is not running
    expect(await activate({ version: '0.6.0' }, tool)).toBe('0.6.0');
    await callTool('deactivate', {}, tool);
    expect(tool.activation.guardVersion).toBeNull();
  });
});
