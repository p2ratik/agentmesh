import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionRelay } from '@agentmesh/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChannelEvent } from '../inbox/render';
import { writeGuardStamp } from '../window/guard-stamp';
import { readForwards } from './forward-record';
import type { LocalSession } from './local-session';
import { pointerText } from './pointer';
import { forwardRelay, type WindowRelayDeps } from './window-relay';

const HEX = 'a'.repeat(32);
const PRIVATE = `uds:\\\\.\\pipe\\LOCAL\\cc-msg-${HEX}`;
const WINDOW = `uds:\\\\.\\pipe\\LOCAL\\cc-msg-${'b'.repeat(32)}`;
const ID = 'msg-01JC9Z8Q4W6Y7X5V3T2R1P0N9M';
const FIELDS = { from: 'sagar-agent', threadId: 'thr-12', messageId: ID };
const RELAY: SessionRelay = { type: 'relay', ...FIELDS, forSession: 's-aaaaaaaaaaaa' };
const now = Date.parse('2026-11-04T10:00:00Z');
const GUARD_OLD = 'the guard is older than 0.6.0 or not running';
const NO_RECORD = 'no fresh record for that session';
const STAMP = new Date(now - 5_000).toISOString();

let dataDir: string;
let pushed: ChannelEvent[];

function writeRecord(over: Partial<LocalSession> = {}): void {
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
    from: ['sagar-agent'],
    updatedAt: new Date(now - 10_000).toISOString(),
    ...over,
  };
  writeFileSync(join(dataDir, 'sess-mesh-bob-agent-s-aaaaaaaaaaaa.json'), JSON.stringify(record));
}

function deps(over: Partial<WindowRelayDeps> = {}): WindowRelayDeps {
  return {
    window: { state: 'verified', policy: null, dataDir, folder: '.' },
    agentId: 'bob-agent',
    prefix: 'mesh',
    ownUds: WINDOW,
    ownSession: 's-wwwwwwwwwwww',
    platform: 'win32',
    now,
    push: async (event) => {
      pushed.push(event);
    },
    ...over,
  };
}

const forwards = () => readdirSync(dataDir).filter((f) => f.startsWith('fwd-'));

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'am-relay-'));
  pushed = [];
  writeGuardStamp(dataDir, new Date(now - 5_000), '0.6.0');
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
      [GUARD_OLD, () => void writeGuardStamp(dataDir, new Date(now - 5_000), '0.5.0')],
      [GUARD_OLD, () => void rmSync(join(dataDir, 'guard-alive.json'))],
      // What a 0.5.0 guard writes: a fresh stamp with no version.
      [GUARD_OLD, () => void writeFileSync(join(dataDir, 'guard-alive.json'), `{"at":"${STAMP}"}`)],
      [NO_RECORD, () => void writeRecord({ updatedAt: new Date(now - 180_000).toISOString() })],
      [NO_RECORD, () => ({ ownSession: 's-aaaaaaaaaaaa' })],
      ['that session turned relay off', () => void writeRecord({ relay: false })],
      ['its address is not a valid local address', () => void writeRecord({ uds: 'uds:/tmp/x' })],
      ['that session is this window', () => ({ ownUds: PRIVATE })],
      ['the pointer fields are invalid', () => undefined, { ...RELAY, from: 'Bob' }],
    ];
    for (const [reason, arrange, relay = RELAY] of rows) {
      writeGuardStamp(dataDir, new Date(now - 5_000), '0.6.0');
      writeRecord();
      const over = arrange();
      expect(await forwardRelay(relay, deps(over)), reason).toEqual({ forwarded: false, reason });
      expect(reason.length).toBeLessThanOrEqual(200);
    }
    expect(pushed).toEqual([]);
    expect(forwards()).toEqual([]);
  });

  it('removes the guard record when the push fails', async () => {
    const push = async () => {
      expect(forwards()).toHaveLength(1);
      throw new Error('transport closed');
    };
    const answer = await forwardRelay(RELAY, deps({ push }));
    expect(answer).toEqual({ forwarded: false, reason: 'the push failed' });
    expect(forwards()).toEqual([]);
  });
});
