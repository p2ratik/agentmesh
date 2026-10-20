import type { ConfigIndex } from '@agentmesh/config';
import { authorize } from '../auth';
import type { Enrolled } from '../team';
import { isAdminCommand } from './definitions';

export interface Choice {
  name: string;
  value: string;
}

const MAX_CHOICES = 25;
const AGENT_OPTIONS = new Set(['facilitator', 'assignee', 'agent']);

export interface AutocompleteRequest {
  discordUserId: string;
  command: string;
  subcommand: string | null;
  option: string;
  typed: string;
}

/**
 * Autocomplete with the same gate as the commands: nothing for people who
 * are not members, and nothing on admin-only subcommands for non-admins (it
 * would list pending invitees and members). Pure.
 */
export function autocompleteFor(
  index: ConfigIndex,
  request: AutocompleteRequest,
  enrolled: Enrolled,
): Choice[] {
  const human = authorize(index, request.discordUserId);
  if (!human) return [];
  if (isAdminCommand(request.command, request.subcommand) && !index.hasRole(human.id, 'admin')) {
    return [];
  }
  const { command, subcommand, option, typed } = request;
  return suggest(index, command, subcommand, option, typed, enrolled);
}

/**
 * Autocomplete answers come straight from config (Discord allows 3 seconds
 * and no deferring, so no hub round trip). `task list` also offers "unassigned".
 * `person` lists only active invited members for `/mesh remove` (the hub
 * refuses to remove anyone from mesh.yaml), and only open invites for
 * `/mesh uninvite`.
 */
export function suggest(
  index: ConfigIndex,
  command: string,
  subcommand: string | null,
  option: string,
  typed: string,
  enrolled: Enrolled = { members: [], invites: [] },
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
    const people = subcommand === 'uninvite' ? enrolled.invites : enrolled.members;
    choices = people.map((p) => ({ name: `${p.humanId} — ${p.displayName}`, value: p.humanId }));
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
