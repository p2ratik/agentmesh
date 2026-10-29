import { isBuiltinEffect } from './effects';
import { REQUIRED_CHANNEL_PURPOSES } from './schema/integrations';
import type { MeshConfig } from './schema/mesh';
import type { RuleConfig } from './schema/rules';
import type { WorkflowConfig } from './schema/workflow';

export interface ConfigIssue {
  path: string;
  message: string;
}

/** Cross-reference checks the schema alone cannot express. */
export function validateReferences(config: MeshConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  const humans = new Set(config.humans.map((h) => h.id));
  const expectKind = kindCheck(config, add);

  checkUniqueIds(config, add);
  config.agents.forEach((a, i) => {
    if (!humans.has(a.owner)) add(`agents[${i}].owner`, `unknown human "${a.owner}"`);
  });
  config.areas.forEach((area, i) => {
    for (const owner of area.owners) expectKind(`areas[${i}].owners`, owner, 'agent');
  });
  for (const id of config.review.humanReviewers) expectKind('review.humanReviewers', id, 'human');

  const workflowIds = new Set(config.workflows.map((w) => w.id));
  config.workflows.forEach((w, i) => {
    checkWorkflow(w, `workflows[${i}]`, add);
  });
  if (!workflowIds.has(config.tasks.defaultWorkflow)) {
    add('tasks.defaultWorkflow', `unknown workflow "${config.tasks.defaultWorkflow}"`);
  }

  const templates = new Set(config.planning.templates.map((t) => t.id));
  if (!templates.has(config.planning.defaultTemplate)) {
    add('planning.defaultTemplate', `unknown template "${config.planning.defaultTemplate}"`);
  }
  const { facilitator } = config.planning;
  if (facilitator !== 'initiator') expectKind('planning.facilitator', facilitator, 'agent');

  config.rules.forEach((rule, i) => {
    checkRule(rule, `rules[${i}]`, expectKind, workflowIds, add);
  });
  checkDiscord(config, add);
  checkIngest(config, add);
  return issues;
}

/**
 * People mesh.yaml refers to without listing them (area owners, human reviewers,
 * the planning facilitator, rule notify targets): people expected to join by
 * invite. The hub skips them until they do; `agentmesh validate` lists them so a
 * typo stays visible.
 */
export function pendingInvitees(config: MeshConfig): string[] {
  const listed = new Set([...config.humans, ...config.agents, ...config.services].map((p) => p.id));
  listed.add(config.hub.serviceId);
  const { facilitator } = config.planning;
  const referenced = [
    ...config.areas.flatMap((a) => a.owners),
    ...config.review.humanReviewers,
    ...(facilitator === 'initiator' ? [] : [facilitator]),
    ...config.rules.flatMap((r) =>
      r.actions.flatMap((a) => ('notify' in a && Array.isArray(a.notify.to) ? a.notify.to : [])),
    ),
  ];
  return [...new Set(referenced)].filter((id) => !listed.has(id));
}

type Add = (path: string, message: string) => void;
type Kind = 'agent' | 'human' | 'service';
type ExpectKind = (path: string, id: string, ...wanted: Kind[]) => void;

const named = (kind: Kind): string => (kind === 'agent' ? 'an agent' : `a ${kind}`);

/**
 * Reports an id that names the wrong kind of participant, or the hub. An id that
 * is no participant at all is pending, not wrong: someone who joins by invite.
 */
function kindCheck(config: MeshConfig, add: Add): ExpectKind {
  const kinds = new Map<string, Kind>([
    ...config.humans.map((h) => [h.id, 'human'] as const),
    ...config.agents.map((a) => [a.id, 'agent'] as const),
    ...config.services.map((s) => [s.id, 'service'] as const),
  ]);
  return (path, id, ...wanted) => {
    if (id === config.hub.serviceId) return add(path, `"${id}" is the hub`);
    const kind = kinds.get(id);
    if (kind && !wanted.includes(kind)) {
      add(path, `"${id}" is ${named(kind)}, not ${wanted.map(named).join(' or ')}`);
    }
  };
}

function checkUniqueIds(config: MeshConfig, add: Add): void {
  const seen = new Map<string, string>();
  const groups = [
    ['humans', config.humans],
    ['agents', config.agents],
    ['services', config.services],
  ] as const;
  for (const [group, list] of groups) {
    list.forEach((p, i) => {
      const prior = seen.get(p.id);
      if (prior) add(`${group}[${i}].id`, `"${p.id}" is already used by ${prior}`);
      else seen.set(p.id, `${group}[${i}]`);
    });
  }
}

function checkWorkflow(w: WorkflowConfig, path: string, add: Add): void {
  const states = new Set(Object.keys(w.states));
  if (!states.has(w.initial)) add(`${path}.initial`, `unknown state "${w.initial}"`);
  const effectNames = [
    ...Object.values(w.states).flatMap((s) => s.onEnter),
    ...w.transitions.flatMap((t) => t.effects),
  ].map((e) => e.name);
  for (const name of effectNames) {
    if (!isBuiltinEffect(name)) add(`${path}`, `unknown effect "${name}"`);
  }
  w.transitions.forEach((t, i) => {
    if (!states.has(t.to)) add(`${path}.transitions[${i}].to`, `unknown state "${t.to}"`);
    if (t.from !== '*') {
      for (const s of t.from) {
        if (!states.has(s)) add(`${path}.transitions[${i}].from`, `unknown state "${s}"`);
      }
    }
  });
}

function checkRule(
  rule: RuleConfig,
  path: string,
  expectKind: ExpectKind,
  workflows: Set<string>,
  add: Add,
): void {
  for (const [field, cond] of Object.entries(rule.match.where)) {
    if (cond.matches !== undefined && !isValidRegex(cond.matches)) {
      add(`${path}.match.where.${field}.matches`, 'invalid regular expression');
    }
  }
  rule.actions.forEach((action, i) => {
    const at = `${path}.actions[${i}]`;
    if ('notify' in action && Array.isArray(action.notify.to)) {
      for (const id of action.notify.to) expectKind(`${at}.notify.to`, id, 'agent', 'human');
    }
    const task = 'create_task' in action ? action.create_task : undefined;
    if (task?.workflow && !workflows.has(task.workflow)) {
      add(`${at}.create_task.workflow`, `unknown workflow "${task.workflow}"`);
    }
    if (task?.assignee) expectKind(`${at}.create_task.assignee`, task.assignee, 'agent');
    // `notice` channels are not checked: bridges fall back (alerts→events, unknown→events).
  });
}

function isValidRegex(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

function checkDiscord(config: MeshConfig, add: Add): void {
  const d = config.discord;
  if (!d.enabled) return;
  for (const key of ['token', 'applicationId', 'guildId'] as const) {
    if (!d[key]) add(`discord.${key}`, 'required when discord.enabled is true');
  }
  for (const purpose of REQUIRED_CHANNEL_PURPOSES) {
    if (!d.channels[purpose])
      add(`discord.channels.${purpose}`, 'missing required channel purpose');
  }
  const service = config.services.find((s) => s.id === d.serviceId);
  if (!service) add('discord.serviceId', `no service "${d.serviceId}" in services`);
  else {
    // The hub only provisions activity-feed consumers for bridge services.
    if (service.role !== 'bridge')
      add('discord.serviceId', `service "${d.serviceId}" needs role: bridge`);
    if (!service.canActAsHumans) {
      add('discord.serviceId', `service "${d.serviceId}" needs canActAsHumans: true`);
    }
  }
}

function checkIngest(config: MeshConfig, add: Add): void {
  const ids = new Set<string>();
  config.ingest.sources.forEach((s, i) => {
    if (ids.has(s.id)) add(`ingest.sources[${i}].id`, `duplicate source "${s.id}"`);
    ids.add(s.id);
    if (s.auth.type === 'none' && !config.hub.allowInsecureIngest) {
      add(`ingest.sources[${i}].auth`, 'auth "none" requires hub.allowInsecureIngest: true');
    }
    if (s.format === 'raw' && !s.typeHeader && !s.typeField) {
      add(`ingest.sources[${i}]`, 'raw sources need typeHeader or typeField');
    }
  });
}
