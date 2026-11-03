// Built-ins only (the hook bundle imports this).
import { STATE_MAX_AGE_MS } from '../pull/state';

/** Written by an active push session so the SessionStart hook can tell something is listening. */
export interface Heartbeat {
  agentId: string;
  sessionId: string;
  meshWindow: boolean;
  updatedAt: string;
}

export const heartbeatFile = (prefix: string, agentId: string, sessionId: string): string =>
  `push-${prefix}-${agentId}-${sessionId}.json`;

export const isHeartbeatFile = (name: string): boolean =>
  name.startsWith('push-') && name.endsWith('.json');

/** True when any value has an `updatedAt` between now and STATE_MAX_AGE_MS ago. */
export function anyFresh(values: readonly unknown[], now: number): boolean {
  return values.some((v) => {
    const at = (v as { updatedAt?: unknown } | null)?.updatedAt;
    const age = now - (typeof at === 'string' ? Date.parse(at) : Number.NaN);
    return age >= 0 && age <= STATE_MAX_AGE_MS;
  });
}
