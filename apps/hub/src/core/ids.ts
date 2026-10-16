import { formatId, MeshError, parseId, type SequentialKind } from '@agentmesh/common';

/** Parses a protocol id (`task-42`) into the internal integer, or throws `invalid_request`. */
export function internalId(kind: SequentialKind, raw: string): number {
  const id = parseId(kind, raw);
  if (id === null) throw new MeshError('invalid_request', `"${raw}" is not a valid ${kind} id`);
  return id;
}

export const threadKey = (id: number): string => formatId('thread', id);
export const taskKey = (id: number): string => formatId('task', id);
export const planKey = (id: number): string => formatId('plan', id);

export const optionalKey = (kind: SequentialKind, id: number | null | undefined): string | null =>
  id === null || id === undefined ? null : formatId(kind, id);
