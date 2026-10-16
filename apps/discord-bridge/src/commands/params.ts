import type { Priority, RpcParamsInput } from '@agentmesh/protocol';

/** Option values as read from an interaction (`null` when not given). */
type Opt<T> = T | null;

/** Splits "a, b,,c" into ["a","b","c"]; undefined when nothing remains. */
export function splitIds(raw: Opt<string>): string[] | undefined {
  const ids = (raw ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

export function planStartParams(o: {
  topic: string;
  participants: Opt<string>;
  facilitator: Opt<string>;
  minutes: Opt<number>;
}): RpcParamsInput<'plan.start'> {
  const participants = splitIds(o.participants);
  return {
    topic: o.topic,
    ...(participants ? { participants } : {}),
    ...(o.facilitator ? { facilitator: o.facilitator } : {}),
    ...(o.minutes ? { roundMinutes: o.minutes } : {}),
  };
}

export function taskCreateParams(o: {
  title: string;
  description: Opt<string>;
  area: Opt<string>;
  repo: Opt<string>;
  assignee: Opt<string>;
  priority: Opt<string>;
}): RpcParamsInput<'task.create'> {
  return {
    title: o.title,
    description: o.description ?? '',
    ...(o.area ? { area: o.area } : {}),
    ...(o.repo ? { repo: o.repo } : {}),
    ...(o.assignee ? { assignee: o.assignee } : {}),
    ...(o.priority ? { priority: o.priority as Priority } : {}),
  };
}

export function taskListParams(o: {
  assignee: Opt<string>;
  state: Opt<string>;
}): RpcParamsInput<'task.list'> {
  return {
    ...(o.assignee ? { assignee: o.assignee } : {}),
    ...(o.state ? { state: [o.state] } : {}),
    limit: 25,
  };
}

export function taskAssignParams(taskId: string, agent: string): RpcParamsInput<'task.act'> {
  return { taskId, action: 'assign', to: agent };
}

export function taskCancelParams(taskId: string, reason: Opt<string>): RpcParamsInput<'task.act'> {
  return { taskId, action: 'cancel', ...(reason ? { note: reason } : {}) };
}

export function askParams(agent: string, question: string): RpcParamsInput<'message.send'> {
  return { kind: 'ask', to: [agent], body: question };
}
