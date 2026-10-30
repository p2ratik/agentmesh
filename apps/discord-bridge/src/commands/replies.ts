import type { PeerInfo, Plan, RpcResult, Task, TaskDetail } from '@agentmesh/protocol';
import { EXTERNAL, link, list, relativeTime, taskTitle } from '../render/format';

/** Reply texts for slash commands. Pure. */

const STATUS_DOT: Record<PeerInfo['status'], string> = {
  online: '🟢',
  busy: '🟠',
  away: '🟡',
  offline: '⚫',
};

const channel = (id: string | null) => (id ? ` in <#${id}>` : '');

export function planStarted(plan: Plan, planningChannel: string | null): string {
  return `🗺️ Started **${plan.id}** — ${plan.topic}\nFacilitator ${plan.facilitator} · participants ${list(plan.participants)} · follow it${channel(planningChannel)}.`;
}

export function planStatus(plan: Plan): string {
  return [
    `**${plan.id}** — ${plan.topic}`,
    `State: ${plan.state}${plan.currentRound ? ` (${plan.currentRound})` : ''}${plan.deadline ? ` · due ${relativeTime(plan.deadline)}` : ''}`,
    `Facilitator ${plan.facilitator} · participants ${list(plan.participants)}`,
    plan.taskIds.length > 0 ? `Tasks: ${plan.taskIds.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function taskCreated(task: TaskDetail): string {
  return `📋 Created **${task.id}** — ${task.title} → ${task.assignee ?? 'unassigned (board)'} [${task.state}]`;
}

export function taskLines(tasks: readonly Task[]): string {
  if (tasks.length === 0) return 'No matching open tasks.';
  return tasks
    .map(
      (t) =>
        `• **${t.id}** [${t.state}] ${taskTitle(t)} → ${t.assignee ?? 'unassigned'}${t.prUrl ? ` · ${link(t.prUrl)}` : ''}`,
    )
    .join('\n');
}

export function taskDetail(t: TaskDetail): string {
  return [
    `**${t.id}** — ${taskTitle(t)}`,
    `State: ${t.state} · priority ${t.priority} · workflow ${t.workflow}`,
    `Assignee: ${t.assignee ?? 'none'} · reviewers: ${list(t.reviewers)} · created by ${t.createdBy}`,
    t.prUrl ? `PR: ${link(t.prUrl)}` : '',
    t.dependsOn.length > 0 ? `Depends on: ${t.dependsOn.join(', ')}` : '',
    t.description
      ? `\n${t.trust === 'external' ? `${EXTERNAL}:\n` : ''}${t.description.slice(0, 1200)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function asked(agent: string, threadId: string, councilChannel: string | null): string {
  return `💬 Asked **${agent}** (${threadId}). The conversation will appear${channel(councilChannel)}.`;
}

/** Active sessions all in pull mode: work reaches the agent on its next prompt, not at once. */
const pullOnly = (p: PeerInfo): boolean =>
  p.sessions.length > 0 && p.sessions.every((s) => s.delivery === 'pull');

export function meshStatus(status: RpcResult<'mesh.status'>): string {
  const agents = status.peers.filter((p) => p.kind === 'agent');
  const lines = agents.map(
    (p) =>
      `${STATUS_DOT[p.status]} **${p.id}** ${p.status}${p.statusNote ? ` — ${p.statusNote}` : ''} · ${p.activeTasks} task(s)${p.repo ? ` · ${p.repo}${p.branch ? `@${p.branch}` : ''}` : ''}${pullOnly(p) ? ' · pull-only (reads on next prompt)' : ''}`,
  );
  const c = status.counts;
  return [
    `**${status.name}** — ${status.paused ? `⏸️ PAUSED${status.pausedReason ? ` (${status.pausedReason})` : ''}` : '▶️ running'}`,
    ...lines,
    `Open: ${c.openTasks} task(s), ${c.activePlans} plan(s), ${c.openThreads} thread(s) · held deliveries: ${c.heldDeliveries}`,
  ].join('\n');
}
