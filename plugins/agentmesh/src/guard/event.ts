// Built-ins only: the worktree guard bundle (dist/guard.js) imports this.
import type { ReasonCode } from '@agentmesh/protocol/observe-codes';
import type { GuardDecision } from './decide';

/** A ReportedEvent's fields as the guard writes them (`leaveEvent` adds id, time and source). */
export type GuardEventFields =
  | { kind: 'guard'; tool: string; decision: 'deny' | 'ask'; reason: ReasonCode; key?: string }
  | { kind: 'relay'; stage: 'claimed'; message: string; thread: string };

/** The protocol's Token: a tool name is kept only in this shape. */
const TOKEN = /^[A-Za-z0-9_.+-]{1,64}$/;

function toolName(input: unknown): string {
  const name =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>).tool_name
      : undefined;
  const short = typeof name === 'string' ? name.slice(0, 64) : '';
  return TOKEN.test(short) ? short : 'unknown';
}

/**
 * What the timeline records of a decision: a guard line for a deny or an ask, relay `claimed` for
 * a SendMessage that passed, nothing for any other pass or the stamp. Codes, ids and the tool's
 * name only: never the reason text or anything else the call carried.
 */
export function guardEvent(input: unknown, d: GuardDecision): GuardEventFields | null {
  if (d.kind === 'deny' || d.kind === 'ask') {
    const key = d.kind === 'deny' && d.key !== undefined ? { key: d.key } : {};
    return { kind: 'guard', tool: toolName(input), decision: d.kind, reason: d.code, ...key };
  }
  return d.kind === 'pass' && d.claimed ? { kind: 'relay', stage: 'claimed', ...d.claimed } : null;
}
