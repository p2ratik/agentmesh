import type { z } from 'zod';
import type { HubClient } from '../hub';
import type { FyiBuffer } from '../inbox/fyi';
import type { ActivationState } from './activation';

export interface ToolDeps {
  /** Hub calls; each tool call gets its own view, so its result carries only its own notes. */
  hub: Pick<HubClient, 'call' | 'reportSeen'>;
  agentId: string;
  activation: ActivationState;
  /** Status items that ride along at the end of the next tool result. */
  fyi: FyiBuffer;
}

/**
 * One MCP tool: a zod input schema (snake_case, Claude-facing) and a runner
 * that maps it to hub RPC calls and returns compact, readable text.
 */
export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  /** Whether repeated calls could duplicate work (gets an idempotency key). */
  mutating: boolean;
  run(args: z.output<S>, deps: ToolDeps, idempotencyKey: string | undefined): Promise<string>;
}

export const defineTool = <S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> => def;

/** RPC call options carrying the per-call idempotency key, when there is one. */
export const withKey = (key: string | undefined): { idempotencyKey?: string } =>
  key ? { idempotencyKey: key } : {};
