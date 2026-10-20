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
  const agents = new Set(config.agents.map((a) => a.id));
  const services = new Set(config.services.map((s) => s.id));

  checkUniqueIds(config, add);
  config.agents.forEach((a, i) => {
    if (!humans.has(a.owner)) add(`agents[${i}].owner`, `unknown human "${a.owner}"`);
  });
  // An owner that is no participant at all is pending: an agent that joins by invite.
  config.areas.forEach((area, i) => {
    for (const owner of area.owners) {
      if (humans.has(owner)) add(`areas[${i}].owners`, `"${owner}" is a human, not an agent`);
      if (services.has(owner)) add(`areas[${i}].owners`, `"${owner}" is a service, not an agent`);
    }
  });
  config.review.humanReviewers.forEach((id) => {
    if (!humans.has(id)) add('review.humanReviewers', `unknown human "${id}"`);
  });

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
  if (facilitator !== 'initiator' && !agents.has(facilitator)) {
    add('planning.facilitator', `must be "initiator" or an agent id, got "${facilitator}"`);
  }

  config.rules.forEach((rule, i) => {
    checkRule(rule, `rules[${i}]`, config, workflowIds, add);
  });
  checkDiscord(config, add);
  checkIngest(config, add);
  return issues;
}

/**
 * Area owners mesh.yaml does not list as agents: agents expected to join by
 * invite. Routing skips them until they do; `agentmesh validate` lists them so
 * a typo stays visible.
 */
export function pendingAreaOwners(config: MeshConfig): string[] {
  const agents = new Set(config.agents.map((a) => a.id));
  return [...new Set(config.areas.flatMap((a) => a.owners))].filter((id) => !agents.has(id));
}

type Add = (path: string, message: string) => void;

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
  config: MeshConfig,
  workflows: Set<string>,
  add: Add,
): void {
  for (const [field, cond] of Object.entries(rule.match.where)) {
    if (cond.matches !== undefined && !isValidRegex(cond.matches)) {
      add(`${path}.match.where.${field}.matches`, 'invalid regular expression');
    }
  }
  const participants = new Set([...config.agents, ...config.humans].map((p) => p.id));
  rule.actions.forEach((action, i) => {
    const at = `${path}.actions[${i}]`;
    if ('notify' in action && Array.isArray(action.notify.to)) {
      for (const id of action.notify.to.filter((id) => !participants.has(id))) {
        add(`${at}.notify.to`, `unknown participant "${id}"`);
      }
    }
    const workflow = 'create_task' in action ? action.create_task.workflow : undefined;
    if (workflow && !workflows.has(workflow)) {
      add(`${at}.create_task.workflow`, `unknown workflow "${workflow}"`);
    }
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
