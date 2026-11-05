import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type LocalSession,
  localSessionFile,
  localSessionRecord,
  ownLocalSession,
  parseLocalSession,
  readLocalSession,
  readLocalSessions,
  replyNote,
} from './local-session';

const now = Date.parse('2026-11-04T10:00:00Z');
const UDS = `uds:\\\\.\\pipe\\LOCAL\\cc-msg-${'a'.repeat(32)}`;

function record(over: Partial<LocalSession> = {}): LocalSession {
  return {
    agentId: 'bob-agent',
    prefix: 'mesh',
    hubSessionId: 's-aaaaaaaaaaaa',
    uds: UDS,
    claudePid: 100,
    claudeSessionId: null,
    projectDir: '/work/api',
    relay: true,
    threads: 0,
    from: [],
    updatedAt: new Date(now - 10_000).toISOString(),
    ...over,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('local session records', () => {
  it('names the file only for valid ids', () => {
    expect(localSessionFile('mesh', 'bob-agent', 's-aaaaaaaaaaaa')).toBe(
      'sess-mesh-bob-agent-s-aaaaaaaaaaaa.json',
    );
    expect(localSessionFile('../x', 'bob-agent', 's-aaaaaaaaaaaa')).toBeNull();
    expect(localSessionFile('Mesh', 'bob-agent', 's-aaaaaaaaaaaa')).toBeNull();
    expect(localSessionFile('mesh', 'Bob', 's-aaaaaaaaaaaa')).toBeNull();
    expect(localSessionFile('mesh', 'bob-agent', '../s-aaaaaaaaaaaa')).toBeNull();
  });

  it("finds this session's own fresh record by CLAUDE_PID", () => {
    const values = [
      record({ claudePid: 100 }),
      record({ claudePid: 200, hubSessionId: 's-bbbbbbbbbbbb', threads: 1 }),
      record({
        claudePid: 200,
        hubSessionId: 's-cccccccccccc',
        updatedAt: new Date(now - 60_000).toISOString(),
      }),
      null,
      'junk',
    ];
    expect(ownLocalSession(values, 200, now)?.hubSessionId).toBe('s-bbbbbbbbbbbb');
    const old = record({ claudePid: 200, updatedAt: new Date(now - 180_000).toISOString() });
    expect(ownLocalSession([old], 200, now)).toBeNull();
    const future = record({ claudePid: 200, updatedAt: new Date(now + 60_000).toISOString() });
    expect(ownLocalSession([future], 200, now)).toBeNull();
    expect(ownLocalSession(values, Number(undefined), now)).toBeNull();
    expect(ownLocalSession(values, 300, now)).toBeNull();
  });

  it('writes the reply note', () => {
    expect(replyNote(record({ threads: 2, from: ['sagar-agent'] }))).toBe(
      'AgentMesh: 2 unread repl(ies) from sagar-agent in threads this session started; call inbox to read them.',
    );
    expect(replyNote(record({ threads: 1 }))).toBe(
      'AgentMesh: 1 unread repl(ies) in threads this session started; call inbox to read them.',
    );
    expect(replyNote(record({ threads: 0, from: ['sagar-agent'] }))).toBeNull();
  });

  it('parses only well-typed records and drops odd senders', () => {
    expect(
      parseLocalSession(record({ from: ['sagar-agent', 'Evil One', 7 as unknown as string] }))
        ?.from,
    ).toEqual(['sagar-agent']);
    for (const bad of [
      { claudePid: 0 },
      { claudePid: 1.5 },
      { relay: 'yes' },
      { threads: -1 },
      { hubSessionId: 's-x' },
      { uds: 7 },
    ]) {
      expect(parseLocalSession({ ...record(), ...bad })).toBeNull();
    }
  });

  it('reads one fresh record and builds one from the peek counts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmesh-sess-'));
    dirs.push(dir);
    // The watcher passes its deps: nothing but the record's fields may reach the file.
    const base = { ...record(), hub: { token: 'x' }, logger: {} };
    const peek = { threads: 2, actions: 1, from: ['sagar-agent'], external: true };
    const at = new Date(now).toISOString();
    const built = localSessionRecord(base, peek, at);
    expect(built).toEqual(record({ threads: 2, from: ['sagar-agent'], updatedAt: at }));
    writeFileSync(join(dir, 'sess-mesh-bob-agent-s-aaaaaaaaaaaa.json'), JSON.stringify(built));
    expect(readLocalSession(dir, 'mesh', 'bob-agent', 's-aaaaaaaaaaaa', now)).toEqual(built);
    expect(readLocalSession(dir, 'mesh', 'bob-agent', 's-aaaaaaaaaaaa', now + 180_000)).toBeNull();
    expect(readLocalSession(dir, 'mesh', 'bob-agent', 's-bbbbbbbbbbbb', now)).toBeNull();
    expect(readLocalSession(dir, '../mesh', 'bob-agent', 's-aaaaaaaaaaaa', now)).toBeNull();
  });

  it('reads every fresh sess-* record in a folder, skipping other and bad files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmesh-sess-'));
    dirs.push(dir);
    const fresh = record({ hubSessionId: 's-bbbbbbbbbbbb' });
    writeFileSync(join(dir, 'sess-mesh-bob-agent-s-bbbbbbbbbbbb.json'), JSON.stringify(fresh));
    const old = record({ updatedAt: new Date(now - 180_000).toISOString() });
    writeFileSync(join(dir, 'sess-mesh-bob-agent-s-aaaaaaaaaaaa.json'), JSON.stringify(old));
    writeFileSync(join(dir, 'sess-mesh-bob-agent-s-cccccccccccc.json'), '{not json');
    writeFileSync(join(dir, 'pull-mesh-bob-agent-s-dddddddddddd.json'), JSON.stringify(record()));
    expect(readLocalSessions(dir, now)).toEqual([fresh]);
    expect(readLocalSessions(join(dir, 'missing'), now)).toEqual([]);
  });

  it('refuses a record whose content names another session, agent or mesh than its file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmesh-sess-'));
    dirs.push(dir);
    const file = join(dir, 'sess-mesh-bob-agent-s-aaaaaaaaaaaa.json');
    for (const other of [
      { hubSessionId: 's-bbbbbbbbbbbb' },
      { agentId: 'carol-agent' },
      { prefix: 'other' },
    ]) {
      writeFileSync(file, JSON.stringify(record(other)));
      expect(readLocalSession(dir, 'mesh', 'bob-agent', 's-aaaaaaaaaaaa', now)).toBeNull();
    }
  });
});
