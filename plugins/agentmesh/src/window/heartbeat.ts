// Built-ins only (the hook bundle imports this).
import { isFresh } from '../pull/state';

/** Written by an active push session so the SessionStart hook can tell something is listening. */
export interface Heartbeat {
  agentId: string;
  prefix: string;
  sessionId: string;
  meshWindow: boolean;
  /** The mesh window's messaging address, so a private session can verify its pointers; else null. */
  uds: string | null;
  updatedAt: string;
}

export const heartbeatFile = (prefix: string, agentId: string, sessionId: string): string =>
  `push-${prefix}-${agentId}-${sessionId}.json`;

export const isHeartbeatFile = (name: string): boolean =>
  name.startsWith('push-') && name.endsWith('.json');

/** True when any value has an `updatedAt` between now and STATE_MAX_AGE_MS ago. */
export function anyFresh(values: readonly unknown[], now: number): boolean {
  return values.some((v) => isFresh((v as { updatedAt?: unknown } | null)?.updatedAt, now));
}

/** The addresses of this agent's fresh mesh windows on this mesh, from their heartbeats. */
export function windowAddresses(
  values: readonly unknown[],
  prefix: string,
  agentId: string,
  now: number,
): string[] {
  return values.flatMap((v) => {
    const b = v as Partial<Record<keyof Heartbeat, unknown>> | null;
    const ok =
      b?.meshWindow === true &&
      b.prefix === prefix &&
      b.agentId === agentId &&
      typeof b.uds === 'string' &&
      b.uds !== '' &&
      isFresh(b.updatedAt, now);
    return ok ? [b.uds as string] : [];
  });
}
