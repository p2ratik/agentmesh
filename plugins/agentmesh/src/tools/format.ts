import type {
  Lease,
  MeshMessage,
  PeerInfo,
  Plan,
  PlanContribution,
  SessionSummary,
  Task,
  TaskDetail,
  ThreadSummary,
} from '@agentmesh/protocol';
import { EXTERNAL_TAG, oneLine, quoteBody } from '../inbox/render';

/** Compact text renderings of hub results, written for Claude to read. */

export function formatPeers(peers: readonly PeerInfo[]): string {
  if (peers.length === 0) return 'Nobody is configured on this mesh.';
  return peers
    .map((p) => {
      const facts = [
        p.status + (p.statusNote ? ` (${p.statusNote})` : ''),
        p.kind === 'agent' ? `${p.activeTasks} active task(s)` : p.kind,
        p.skills.length > 0 ? `skills ${p.skills.join(', ')}` : '',
        p.areas.length > 0 ? `owns ${p.areas.join(', ')}` : '',
        p.repo ? `on ${p.repo}${p.branch ? `@${p.branch}` : ''}` : '',
      ].filter(Boolean);
      return [
        `- ${p.id} (${p.displayName}) · ${facts.join(' · ')}`,
        ...p.sessions.map(formatSession),
      ].join('\n');
    })
    .join('\n');
}

/** An active session, which an `ask` can pick with `to_session`. A pull one reads on its next prompt. */
function formatSession(s: SessionSummary): string {
  const where = s.repo ? ` (${s.repo}${s.branch ? `@${s.branch}` : ''})` : '';
  const owns = s.tasks.length > 0 ? ` owns ${s.tasks.join(', ')}` : '';
  const pull = s.delivery === 'pull' ? ' [pull: reads on its next prompt]' : '';
  return `    · ${s.id} — ${s.description}${where}${owns}${pull}`;
}

/** A header line, then the body quoted (`│ `), so no body line can pass for another entry. */
export function formatMessage(m: MeshMessage): string {
  const tags = [m.kind, m.status, m.trust === 'external' ? 'EXTERNAL' : null]
    .filter(Boolean)
    .join(', ');
  return `--- ${m.from.displayName} [${m.from.id}] (${tags}) ${m.createdAt.slice(0, 16).replace('T', ' ')} UTC · ${m.id}\n${quoteBody(m)}`;
}

export function formatThreadHeader(t: ThreadSummary): string {
  const links = [t.taskId, t.planId].filter(Boolean).join(', ');
  return `${t.id} «${oneLine(t.subject)}» · ${t.kind} · ${t.status} · participants: ${t.participants.join(', ')}${links ? ` · ${links}` : ''}`;
}

/** An external task's title comes from outside the team: tagged, and kept on one line. */
const titleOf = (t: Task): string =>
  `${t.trust === 'external' ? `${EXTERNAL_TAG} · ` : ''}${oneLine(t.title)}`;

export function formatThread(thread: ThreadSummary, messages: readonly MeshMessage[]): string {
  const body = messages.length > 0 ? messages.map(formatMessage).join('\n\n') : '(no messages)';
  return `${formatThreadHeader(thread)}\n\n${body}`;
}

export function formatTaskLine(t: Task): string {
  const who = t.assignee ? `→ ${t.assignee}` : '→ unassigned';
  return `- ${t.id} [${t.state}] ${titleOf(t)} ${who} · ${t.priority}${t.area ? ` · ${t.area}` : ''}${t.prUrl ? ` · ${t.prUrl}` : ''}`;
}

export function formatTask(t: TaskDetail): string {
  const lines = [
    `${t.id} · ${titleOf(t)}`,
    `state: ${t.state}${t.terminal ? ' (final)' : ''} · workflow: ${t.workflow} · priority: ${t.priority}`,
    `assignee: ${t.assignee ?? 'none'} · creator: ${t.createdBy} · reviewers: ${t.reviewers.join(', ') || 'none'} (round ${t.reviewRound})`,
    [
      t.repo && `repo: ${t.repo}`,
      t.area && `area: ${t.area}`,
      t.baseBranch && `base: ${t.baseBranch}`,
      t.branch && `branch: ${t.branch}`,
    ]
      .filter(Boolean)
      .join(' · '),
    t.prUrl ? `PR: ${t.prUrl}` : '',
    t.doneWhen ? `done when: ${t.doneWhen}` : '',
    t.dependsOn.length > 0 ? `depends on: ${t.dependsOn.join(', ')}` : '',
    `thread: ${t.threadId}${t.planId ? ` · plan: ${t.planId}` : ''}`,
    t.description ? `\n${quoteBody({ body: t.description, trust: t.trust })}\n` : '',
    `Your available actions: ${t.availableActions.join(', ') || 'none'}`,
    t.reviews.length > 0
      ? `Reviews:\n${t.reviews.map((r) => `- round ${r.round} ${r.reviewer}: ${r.verdict} — ${firstLine(r.body)}`).join('\n')}`
      : '',
    `History: ${t.history.map((h) => `${h.action}(${h.actor})`).join(' → ')}`,
  ];
  return lines.filter(Boolean).join('\n');
}

export function formatPlan(plan: Plan, contributions: readonly PlanContribution[] = []): string {
  const lines = [
    `${plan.id} · ${plan.topic}`,
    `state: ${plan.state}${plan.currentRound ? ` (step: ${plan.currentRound})` : ''}${plan.deadline ? ` · deadline ${plan.deadline}` : ''}`,
    `facilitator: ${plan.facilitator} · participants: ${plan.participants.join(', ')} · thread: ${plan.threadId}`,
    plan.summary ? `\nSummary:\n${plan.summary}` : '',
    plan.taskIds.length > 0 ? `Tasks: ${plan.taskIds.join(', ')}` : '',
  ];
  if (contributions.length > 0) {
    lines.push(
      '\nContributions:',
      ...contributions.map(
        (c) => `--- ${c.participant} · ${c.round}\n${quoteBody({ body: c.body, trust: 'team' })}`,
      ),
    );
  }
  return lines.filter(Boolean).join('\n');
}

export function formatLeases(leases: readonly Lease[]): string {
  if (leases.length === 0) return 'No active leases.';
  return leases
    .map(
      (l) =>
        `- ${l.path}${l.repo ? ` (${l.repo})` : ''} · ${l.holder} · until ${l.expiresAt}${l.taskId ? ` · ${l.taskId}` : ''}${l.reason ? ` · ${l.reason}` : ''}`,
    )
    .join('\n');
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').slice(0, 160);
}
