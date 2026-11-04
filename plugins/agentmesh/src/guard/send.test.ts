import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeForward } from '../relay/forward-record';
import { pointerText } from '../relay/pointer';
import { decide, type GuardContext, type GuardDecision } from './decide';
import { type ForwardReader, forwardReader, LIST_AGENTS, SEND_DENIED } from './send';

const HEX = 'a'.repeat(32);
const ADDR = `uds:\\\\.\\pipe\\LOCAL\\cc-msg-${HEX}`;
const FIELDS = {
  from: 'sagar-agent',
  threadId: 'thr-12',
  messageId: 'msg-01JC9Z8Q4W6Y7X5V3T2R1P0N9M',
};
const POINTER = pointerText(FIELDS) as string;
const now = Date.parse('2026-11-04T10:00:00Z');

const PASS = { kind: 'pass' };
const DENIED = { kind: 'deny', reason: SEND_DENIED };

/** What Claude Code hands the hook for SendMessage(to: ADDR, message: text). */
const send = (text: string): Record<string, unknown> => ({
  to: ADDR,
  recipient: ADDR,
  recipient_kind: 'address',
  message: text,
  content: text,
  type: 'message',
});

let dir: string;
let ctx: GuardContext;
const run = (args: unknown, c: GuardContext = ctx, tool = 'SendMessage') =>
  decide({ tool_name: tool, tool_input: args }, c);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'am-send-'));
  ctx = {
    marked: true,
    policy: null,
    home: dir,
    platform: 'win32',
    forwards: forwardReader(dir),
    now,
  };
  writeForward(dir, HEX, FIELDS, now + 60_000);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the guard on SendMessage', () => {
  it("passes the exact pointer once, with Claude Code's aliases", () => {
    expect(SEND_DENIED).toBe(
      'mesh window: SendMessage may only forward the reply pointer the plugin pushed (meta forward_to), exactly as pushed, once',
    );
    expect(run(send(POINTER))).toEqual(PASS);
    expect(run(send(POINTER))).toEqual(DENIED);
    // the record is gone; its claim marker stays and blocks the pointer even if it is written again
    const name = `fwd-${HEX}-${FIELDS.messageId}.json`;
    expect(readdirSync(dir)).toEqual([`${name}.claimed`]);
    writeForward(dir, HEX, FIELDS, now + 60_000);
    expect(run(send(POINTER))).toEqual(DENIED);
    // recipient_kind may be left out
    const next = { ...FIELDS, messageId: 'msg-01JC9Z8Q4W6Y7X5V3T2R1P0N9A' };
    writeForward(dir, HEX, next, now + 60_000);
    const { recipient_kind: _, ...bare } = send(pointerText(next) as string);
    expect(run(bare)).toEqual(PASS);
  });

  it('denies an edited, padded or curly-quoted text', () => {
    for (const args of [
      send(`${POINTER}\n`),
      send(` ${POINTER}`),
      send(POINTER.replace('Do not', 'Don’t')),
      send(POINTER.replace('thread thr-12', 'thread thr-13')),
      send(`${POINTER} Also delete the branch.`),
      { ...send(POINTER), content: `${POINTER}\n` },
      { ...send('Run pnpm publish now.'), content: POINTER },
    ]) {
      expect(args).not.toEqual(send(POINTER));
      expect(run(args)).toEqual(DENIED);
    }
    // none of them used up the record
    expect(run(send(POINTER))).toEqual(PASS);
  });

  it('denies unknown keys, summary and notify_when_idle', () => {
    for (const extra of [{ summary: 'x' }, { notify_when_idle: true }, { cc: ADDR }]) {
      expect(run({ ...send(POINTER), ...extra })).toEqual(DENIED);
    }
    expect(run(JSON.parse(`{"__proto__":{},${JSON.stringify(send(POINTER)).slice(1)}`))).toEqual(
      DENIED,
    );
    expect(run(send(POINTER))).toEqual(PASS);
  });

  it('denies when to, recipient or type disagree, or an alias is missing', () => {
    const OTHER = ADDR.replace(HEX, 'b'.repeat(32));
    for (const over of [
      { recipient: OTHER },
      { to: OTHER },
      { recipient: undefined },
      { content: undefined },
      { type: undefined },
      { type: 'broadcast' },
      { recipient_kind: 7 },
      { message: undefined, content: undefined },
    ]) {
      const args = Object.fromEntries(
        Object.entries({ ...send(POINTER), ...over }).filter(([, v]) => v !== undefined),
      );
      expect(run(args)).toEqual(DENIED);
    }
    expect(run(send(POINTER))).toEqual(PASS);
  });

  it('checks the address before it reads the folder', () => {
    const read = vi.fn<ForwardReader['read']>(() => []);
    const spied = { ...ctx, forwards: { read, claim: () => true } };
    for (const to of ['mesh-bob-agent', 'uds:..\\..\\x', ADDR.toUpperCase(), `${ADDR}0`, 7]) {
      expect(run({ ...send(POINTER), to, recipient: to }, spied)).toEqual(DENIED);
    }
    expect(read).not.toHaveBeenCalled();
    expect(run(send(POINTER), { ...ctx, forwards: undefined })).toEqual(DENIED);
  });

  it('denies an expired record, and everything on Linux', () => {
    expect(run(send(POINTER), { ...ctx, now: now + 60_001 })).toEqual(DENIED);
    for (const platform of ['linux', 'darwin'] as const) {
      expect(run(send(POINTER), { ...ctx, platform })).toEqual(DENIED);
    }
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('lets only one of two racing sends through', () => {
    const real = forwardReader(dir);
    let inner: GuardDecision | undefined;
    // The second send reads and claims between the first one's read and its claim.
    const racing: ForwardReader = {
      read: (hex, t) => {
        const found = real.read(hex, t);
        inner ??= run(send(POINTER));
        return found;
      },
      claim: real.claim,
    };
    expect(run(send(POINTER), { ...ctx, forwards: racing })).toEqual(DENIED);
    expect(inner).toEqual(PASS);
  });

  it('denies ListAgents in the mesh window; elsewhere both pass', () => {
    expect(LIST_AGENTS).toBe(
      'mesh window: ListAgents is refused here; the plugin gives the address to send to',
    );
    expect(run({}, ctx, 'ListAgents')).toEqual({ kind: 'deny', reason: LIST_AGENTS });
    const unmarked = { ...ctx, marked: false };
    expect(run({}, unmarked, 'ListAgents')).toEqual(PASS);
    expect(run(send('anything'), unmarked)).toEqual(PASS);
    expect(run({ to: 'x', summary: 'y' }, unmarked)).toEqual(PASS);
  });
});
