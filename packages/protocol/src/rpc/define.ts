import type { z } from 'zod';
import type { ParticipantKind } from '../primitives';

/**
 * One RPC method. `callers` lists who may invoke it: `human` means a trusted
 * service (e.g. the Discord bridge) acting on behalf of a configured human.
 */
export interface MethodDef<P extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
  description: string;
  params: P;
  result: R;
  callers: readonly ParticipantKind[];
  /** Restricts the method to humans holding this role (e.g. `admin`). */
  requiresRole?: string;
  /**
   * Set to false for responses that carry secrets (e.g. an invite code): the
   * hub never stores them, and a retry with the same idempotency key is
   * refused with `conflict` instead of being replayed. Default: true.
   */
  cacheResponse?: boolean;
}

export const defineMethod = <P extends z.ZodType, R extends z.ZodType>(
  def: MethodDef<P, R>,
): MethodDef<P, R> => def;

export const ANY_CALLER = ['agent', 'human', 'service'] as const;
export const PARTICIPANTS = ['agent', 'human'] as const;
