// Built-ins only (the hook bundle imports this).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFresh, PARTICIPANT_ID } from '../pull/state';

/**
 * A private session's local record, `sess-{prefix}-{agent}-{hubSession}.json` in the shared
 * plugin data folder: the mesh window resolves a relay to its address, and the prompt hook
 * finds it by `CLAUDE_PID` for the reply note. Written only after the session's first mesh call.
 */
export interface LocalSession {
  agentId: string;
  prefix: string;
  hubSessionId: string;
  /** The messaging address: local data, never logged or sent to the hub. */
  uds: string | null;
  claudePid: number;
  claudeSessionId: string | null;
  projectDir: string;
  /** False when the human set AGENTMESH_RELAY=off. */
  relay: boolean;
  threads: number;
  from: string[];
  updatedAt: string;
}

const PREFIX = /^[a-z][a-z0-9_-]{0,30}$/;
const HUB_SESSION = /^s-[a-z0-9]{12}$/;

const valid = (re: RegExp, v: unknown): v is string => typeof v === 'string' && re.test(v);

/** The record's file name, or null for any id outside its pattern (checked before any fs call). */
export function localSessionFile(
  prefix: string,
  agentId: string,
  hubSessionId: string,
): string | null {
  if (
    !valid(PREFIX, prefix) ||
    !valid(PARTICIPANT_ID, agentId) ||
    !valid(HUB_SESSION, hubSessionId)
  ) {
    return null;
  }
  return `sess-${prefix}-${agentId}-${hubSessionId}.json`;
}

export const isLocalSessionFile = (name: string): boolean =>
  name.startsWith('sess-') && name.endsWith('.json');

/**
 * A record from this process's facts and the hub's peek, field by field: `base` may carry more
 * (the watcher's deps), and only counts and ids come from the peek.
 */
export function localSessionRecord(
  base: Omit<LocalSession, 'threads' | 'from' | 'updatedAt'>,
  peek: { threads: number; from: readonly string[] },
  updatedAt: string,
): LocalSession {
  const { agentId, prefix, hubSessionId, uds, claudePid, claudeSessionId, projectDir, relay } =
    base;
  const { threads, from } = peek;
  return {
    agentId,
    prefix,
    hubSessionId,
    uds,
    claudePid,
    claudeSessionId,
    projectDir,
    relay,
    threads,
    from: [...from],
    updatedAt,
  };
}

/** A well-typed record, or null; senders that are not participant ids are dropped. */
export function parseLocalSession(value: unknown): LocalSession | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const ok =
    valid(PARTICIPANT_ID, v.agentId) &&
    valid(PREFIX, v.prefix) &&
    valid(HUB_SESSION, v.hubSessionId) &&
    (v.uds === null || typeof v.uds === 'string') &&
    Number.isInteger(v.claudePid) &&
    (v.claudePid as number) > 0 &&
    (v.claudeSessionId === null || typeof v.claudeSessionId === 'string') &&
    typeof v.projectDir === 'string' &&
    typeof v.relay === 'boolean' &&
    Number.isInteger(v.threads) &&
    (v.threads as number) >= 0 &&
    Array.isArray(v.from) &&
    typeof v.updatedAt === 'string';
  if (!ok) return null;
  const s = v as unknown as LocalSession;
  const from = (v.from as unknown[]).filter((f): f is string => valid(PARTICIPANT_ID, f));
  return localSessionRecord(s, { threads: s.threads, from }, s.updatedAt);
}

/** The well-typed records written in the last two minutes (and not in the future). */
export function freshLocalSessions(values: readonly unknown[], now: number): LocalSession[] {
  return values
    .map(parseLocalSession)
    .filter((s): s is LocalSession => s !== null && isFresh(s.updatedAt, now));
}

/** That one session's record, if it is fresh. */
export function readLocalSession(
  dir: string,
  prefix: string,
  agentId: string,
  hubSessionId: string,
  now: number,
): LocalSession | null {
  const name = localSessionFile(prefix, agentId, hubSessionId);
  if (!name) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  } catch {
    return null;
  }
  const [s] = freshLocalSessions([value], now);
  return s && s.prefix === prefix && s.agentId === agentId && s.hubSessionId === hubSessionId
    ? s
    : null;
}

/** This Claude Code session's newest fresh record, matched by its process id. */
export function ownLocalSession(
  values: readonly unknown[],
  claudePid: number,
  now: number,
): LocalSession | null {
  if (!Number.isInteger(claudePid)) return null;
  let newest: LocalSession | null = null;
  for (const s of freshLocalSessions(values, now)) {
    if (s.claudePid === claudePid && (!newest || newest.updatedAt < s.updatedAt)) newest = s;
  }
  return newest;
}

/** The one line a private session sees on each prompt while replies wait. */
export function replyNote({ threads, from }: LocalSession): string | null {
  if (threads === 0) return null;
  return `AgentMesh: ${threads} unread repl(ies)${from.length ? ` from ${from.join(', ')}` : ''} in threads this session started; call inbox to read them.`;
}
