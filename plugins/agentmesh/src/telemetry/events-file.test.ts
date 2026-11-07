import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendEvent,
  collectEventFiles,
  leaveEvent,
  MAX_EVENT_FILES,
  MAX_EVENTS_FILE_BYTES,
} from './events-file';

const OWN = `events-${process.pid}.jsonl`;
const NAMED = `events-alice-agent-${process.pid}.jsonl`;
const event = { kind: 'hook', note: 'error' };
const files = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

describe('the events file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'am-events-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stops appending at 256 KB', () => {
    const file = join(dir, OWN);
    appendEvent(dir, event);
    expect(collectEventFiles(dir, 'bob-agent', true)).toEqual([event]);
    expect(readdirSync(dir)).toEqual([]);

    expect(MAX_EVENTS_FILE_BYTES).toBe(256 * 1024);
    writeFileSync(file, 'x'.repeat(MAX_EVENTS_FILE_BYTES));
    appendEvent(dir, event);
    expect(statSync(file).size).toBe(MAX_EVENTS_FILE_BYTES);
  });

  it('never throws, even when the folder cannot be written', () => {
    const notADir = join(dir, 'file');
    writeFileSync(notADir, '');
    expect(() => appendEvent(notADir, { kind: 'hook' })).not.toThrow();
    expect(collectEventFiles(join(dir, 'missing'), 'bob-agent', true)).toEqual([]);
  });

  /** A waiting file of `agent` (unnamed for null), numbered past any real pid. */
  const waiting = (agent: string | null, i: number) =>
    join(dir, `events-${agent === null ? '' : `${agent}-`}${9e9 + i}.jsonl`);
  const fill = (agent: string | null) => {
    for (let i = 0; i < MAX_EVENT_FILES; i++) writeFileSync(waiting(agent, i), '');
  };

  it('leaves no new file when 500 of its own are waiting, and keeps filling one it started', () => {
    expect(MAX_EVENT_FILES).toBe(500);
    fill('alice-agent');
    appendEvent(dir, event, 'alice-agent');
    expect(existsSync(join(dir, NAMED))).toBe(false);
    // 499 waiting: other names don't count
    unlinkSync(waiting('alice-agent', 0));
    writeFileSync(join(dir, 'events-alice-agent-x.jsonl'), '');
    writeFileSync(join(dir, 'pull-a.json'), '');
    appendEvent(dir, event, 'alice-agent');
    expect(existsSync(join(dir, NAMED))).toBe(true);
    // the count is taken only before this process's first line
    writeFileSync(waiting('alice-agent', 0), '');
    writeFileSync(waiting('alice-agent', MAX_EVENT_FILES), '');
    appendEvent(dir, event, 'alice-agent');
    expect(readFileSync(join(dir, NAMED), 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
  });

  // Re-review N2: another agent's uncollected files can't stop this writer.
  it("counts only the writer's own files: its agent's, or the unnamed ones when it has none", () => {
    fill('bob-agent');
    fill(null);
    appendEvent(dir, event, 'alice-agent');
    expect(existsSync(join(dir, NAMED))).toBe(true);
    appendEvent(dir, event);
    expect(existsSync(join(dir, OWN))).toBe(false);
    for (let i = 0; i < MAX_EVENT_FILES; i++) unlinkSync(waiting(null, i));
    appendEvent(dir, event);
    expect(existsSync(join(dir, OWN))).toBe(true);
  });

  it("names the file by its agent, and refuses an agent that isn't an id", () => {
    appendEvent(dir, event, 'alice-agent');
    expect(readdirSync(dir)).toEqual([NAMED]);
    for (const bad of ['../x', 'Alice', 'a/b', '', '-a']) appendEvent(dir, event, bad);
    expect(readdirSync(dir)).toEqual([NAMED]);
  });

  it("collects its own agent's files, and unnamed ones only from the plugin data folder", () => {
    const named = {
      'events-bob-agent-1.jsonl': 'bob',
      'events-bob-2.jsonl': 'bob-only',
      'events-alice-agent-3.jsonl': 'alice',
      'events-4.jsonl': 'unnamed',
    };
    const write = () => {
      for (const [name, note] of Object.entries(named)) {
        writeFileSync(join(dir, name), `${JSON.stringify({ note })}\n`);
      }
    };
    const notes = (agent: string, unnamed: boolean) =>
      collectEventFiles(dir, agent, unnamed)
        .map((e) => (e as { note: string }).note)
        .sort();
    write();
    // the shared fallback folder: only this agent's named files
    expect(notes('bob-agent', false)).toEqual(['bob']);
    expect(readdirSync(dir).sort()).toEqual([
      'events-4.jsonl',
      'events-alice-agent-3.jsonl',
      'events-bob-2.jsonl',
    ]);
    write();
    // the plugin data folder: unnamed files are this plugin's too
    expect(notes('bob-agent', true)).toEqual(['bob', 'unnamed']);
    expect(notes('bob', false)).toEqual(['bob-only']);
    expect(readdirSync(dir)).toEqual(['events-alice-agent-3.jsonl']);
  });
});

describe('leaveEvent', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'am-leave-'));
    const home = join(base, 'home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('CLAUDE_PLUGIN_DATA', '');
    vi.stubEnv('CLAUDE_PLUGIN_OPTION_AGENT_ID', '');
    vi.stubEnv('CLAUDE_PLUGIN_OPTION_NATS_URL', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('names its file by the agent the hook resolves, in the plugin data folder', () => {
    const data = join(base, 'data');
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data);
    vi.stubEnv('CLAUDE_PLUGIN_OPTION_AGENT_ID', 'alice-agent');
    leaveEvent('hook', null, () => event);
    expect(files(data)).toEqual([NAMED]);
    const [line] = readFileSync(join(data, NAMED), 'utf8').split('\n');
    expect(JSON.parse(line ?? '')).toMatchObject({ source: 'hook', session: null, ...event });
  });

  it('leaves an unnamed file only in the plugin data folder, never in the shared one', () => {
    const data = join(base, 'data');
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data);
    leaveEvent('guard', null, () => event);
    expect(files(data)).toEqual([OWN]);
    // the shared fallback: a file no agent's shipper would take is never written
    vi.stubEnv('CLAUDE_PLUGIN_DATA', '');
    const fallback = join(base, 'home', '.agentmesh', 'run');
    leaveEvent('guard', null, () => event);
    vi.stubEnv('CLAUDE_PLUGIN_OPTION_AGENT_ID', '../evil');
    leaveEvent('guard', null, () => event);
    expect(files(fallback)).toEqual([]);
    vi.stubEnv('CLAUDE_PLUGIN_OPTION_AGENT_ID', 'alice-agent');
    leaveEvent('guard', null, () => event);
    expect(files(fallback)).toEqual([NAMED]);
  });
});
