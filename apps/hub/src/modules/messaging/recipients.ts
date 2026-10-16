import { MeshError } from '@agentmesh/common';

export const ALL_AGENTS = '@all';
export const ONLINE_AGENTS = '@online';

/** What recipient expansion needs to know about the team. */
export interface RecipientDirectory {
  /** Configured agent ids, in config order. */
  agents: readonly string[];
  /** Agents and humans may receive messages; services and unknown ids may not. */
  isAddressable(id: string): boolean;
  isOnline(id: string): boolean;
}

/**
 * Expands `@all` / `@online` to agents, validates explicit ids, dedupes and
 * drops the sender. Order follows the tokens. Pure apart from the directory.
 */
export function expandRecipients(
  tokens: readonly string[],
  sender: string,
  directory: RecipientDirectory,
): string[] {
  const out = new Set<string>();
  const unknown: string[] = [];
  for (const token of tokens) {
    const ids = expandToken(token, directory);
    if (ids === null) unknown.push(token);
    else for (const id of ids) out.add(id);
  }
  if (unknown.length > 0) {
    throw new MeshError('invalid_request', `Unknown recipients: ${unknown.join(', ')}`, {
      unknown,
    });
  }
  out.delete(sender);
  return [...out];
}

/** Explains why a new thread would have nobody to talk to. */
export function noRecipientsError(tokens: readonly string[], sender: string): MeshError {
  const onlySelf = tokens.every((t) => t === sender);
  return new MeshError(
    'invalid_request',
    onlySelf
      ? 'You cannot start a thread with only yourself'
      : `No recipients matched ${tokens.join(', ')} (nobody else is there)`,
  );
}

/** The ids one token stands for, or null when it names nobody we know. */
function expandToken(token: string, directory: RecipientDirectory): readonly string[] | null {
  if (token === ALL_AGENTS) return directory.agents;
  if (token === ONLINE_AGENTS) return directory.agents.filter((id) => directory.isOnline(id));
  return directory.isAddressable(token) ? [token] : null;
}
