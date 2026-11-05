import type { z } from 'zod';
import type { HubClient } from '../hub';
import type { FyiBuffer } from '../inbox/fyi';
import type { MeshWindowContext } from '../window/context';
import type { ActivationState } from './activation';

export interface ToolDeps {
  /** Hub calls; each tool call gets its own view, so its result carries only its own notes. */
  hub: Pick<HubClient, 'call' | 'reportSeen'>;
  agentId: string;
  /** The mesh's subject prefix (`session.config.prefix`); it names the local session records. */
  prefix: string;
  activation: ActivationState;
  /** Status items that ride along at the end of the next tool result. */
  fyi: FyiBuffer;
  /** The session's notices (reclaimed threads), shown once after the next tool result's notes. */
  notices: string[];
  /** Resolves once this session listens on its subject, where the hub sends the activation check. */
  listening: Promise<void>;
  /** Whether this session is the user's mesh window (spec §3). */
  window: MeshWindowContext;
  /** The team policy in full, from the latest hello (the instructions clip it); null without one. */
  teamPolicy(): string | null;
}

/** A refusal shown to Claude verbatim as an error (no code prefix). */
export class ToolRefusal extends Error {}

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
