import type { ConfigIndex } from '@agentmesh/config';

export interface Choice {
  name: string;
  value: string;
}

const MAX_CHOICES = 25;
const AGENT_OPTIONS = new Set(['facilitator', 'assignee', 'agent']);

/**
 * Autocomplete answers come straight from config (Discord allows 3 seconds
 * and no deferring, so no hub round trip). `task list` also offers "unassigned".
 */
export function suggest(
  index: ConfigIndex,
  command: string,
  subcommand: string | null,
  option: string,
  typed: string,
): Choice[] {
  const needle = typed.trim().toLowerCase();
  let choices: Choice[] = [];
  if (AGENT_OPTIONS.has(option)) {
    choices = index
      .agents()
      .map((a) => ({ name: `${a.id} — ${index.displayName(a.id)}`, value: a.id }));
    if (command === 'task' && subcommand === 'list' && option === 'assignee') {
      choices.unshift({ name: 'unassigned (the board)', value: 'unassigned' });
    }
  } else if (option === 'person') {
    choices = index.config.humans.map((h) => ({ name: `${h.id} — ${h.displayName}`, value: h.id }));
  } else if (option === 'area') {
    choices = index.config.areas.map((a) => ({
      name: a.description ? `${a.id} — ${a.description}` : a.id,
      value: a.id,
    }));
  }
  return choices
    .filter((c) => c.value.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle))
    .slice(0, MAX_CHOICES)
    .map((c) => ({ name: c.name.slice(0, 100), value: c.value }));
}
