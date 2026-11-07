import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReportedEvent } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { writeForward } from '../relay/forward-record';
import { pointerText } from '../relay/pointer';
import { decide, type GuardDecision } from './decide';
import { guardEvent } from './event';
import { forwardReader, SEND_DENIED } from './send';

const SEND = { tool_name: 'SendMessage' };
/** What the guard process adds before it writes a line (events-file.ts `leaveEvent`). */
const stamped = (fields: object) => ({
  id: randomUUID(),
  at: new Date().toISOString(),
  session: null,
  source: 'guard',
  ...fields,
});

describe('guardEvent', () => {
  it('records a deny or an ask by its code, with a plain key, never the reason text', () => {
    const unknown: GuardDecision = {
      kind: 'deny',
      reason: SEND_DENIED,
      code: 'send.unknown_key',
      key: 'notify_when_idle',
    };
    expect(guardEvent(SEND, unknown)).toEqual({
      kind: 'guard',
      tool: 'SendMessage',
      decision: 'deny',
      reason: 'send.unknown_key',
      key: 'notify_when_idle',
    });
    const ask: GuardDecision = { kind: 'ask', reason: 'why', code: 'command.not_listed' };
    expect(guardEvent({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, ask)).toEqual({
      kind: 'guard',
      tool: 'Bash',
      decision: 'ask',
      reason: 'command.not_listed',
    });
  });

  it('names the tool only as a short token', () => {
    const d: GuardDecision = { kind: 'deny', reason: 'x', code: 'guard.unreadable' };
    for (const input of [null, 'x', {}, { tool_name: 7 }, { tool_name: 'a b' }]) {
      expect(guardEvent(input, d)).toMatchObject({ tool: 'unknown' });
    }
    const long = `mcp__${'x'.repeat(80)}`;
    expect(guardEvent({ tool_name: long }, d)).toMatchObject({ tool: long.slice(0, 64) });
  });

  it('records relay claimed for a SendMessage that passed, and nothing else that passed', () => {
    const claimed = { message: `msg-${'0'.repeat(26)}`, thread: 'thr-7' };
    expect(guardEvent(SEND, { kind: 'pass', claimed })).toEqual({
      kind: 'relay',
      stage: 'claimed',
      ...claimed,
    });
    expect(guardEvent(SEND, { kind: 'pass' })).toBeNull();
    expect(guardEvent({ tool_name: 'x' }, { kind: 'stamp' })).toBeNull();
  });

  it('writes only lines the shipper keeps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'am-guard-event-'));
    try {
      const hex = 'a'.repeat(32);
      const to = `uds:\\\\.\\pipe\\LOCAL\\cc-msg-${hex}`;
      const fields = {
        from: 'alice-agent',
        threadId: 'thr-12',
        messageId: `msg-${'1'.repeat(26)}`,
      };
      writeForward(dir, hex, fields, Date.now() + 60_000);
      const message = pointerText(fields) ?? '';
      const ctx = {
        marked: true,
        policy: null,
        home: dir,
        platform: 'win32' as const,
        forwards: forwardReader(dir),
      };
      const send = { to, recipient: to, type: 'message', message, content: message };
      const calls = [
        { tool_name: 'SendMessage', tool_input: send },
        { tool_name: 'SendMessage', tool_input: send },
        { tool_name: 'SendMessage', tool_input: { ...send, notify_when_idle: true } },
        { tool_name: 'SendMessage', tool_input: { ...send, 'x y': 1 } },
        { tool_name: 'ListAgents', tool_input: {} },
        { tool_name: 'Bash', tool_input: { command: 'git status' } },
        { tool_name: 'Glob', tool_input: {} },
        null,
      ];
      const events = calls.map((c) => guardEvent(c, decide(c, ctx)));
      expect(events.map((e) => e && ('reason' in e ? e.reason : e.stage))).toEqual([
        'claimed',
        'send.no_record',
        'send.unknown_key',
        'send.unknown_key',
        'list_agents',
        'marker.unverified',
        'tool.unknown',
        'guard.unreadable',
      ]);
      for (const e of events) expect(ReportedEvent.parse(stamped(e ?? {}))).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
