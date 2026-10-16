import type { z } from 'zod';
import type { HubClient } from '../hub';

export interface ToolDeps {
  hub: HubClient;
  agentId: string;
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
