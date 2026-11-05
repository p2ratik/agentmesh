import {
  GitRef,
  type Lease,
  type MeshMessage,
  type PeerInfo,
  type Plan,
  type PlanContribution,
  type SessionSummary,
  type Task,
  type TaskDetail,
  type ThreadSummary,
} from '@agentmesh/protocol';
import { decides, EXTERNAL_TAG, oneLine, quoteBody } from '../inbox/render';

/** Compact text renderings of hub results, written for Claude to read. */

/** A repo or branch as the hub sent it, or `(invalid)`: an older hub may hold a value with a line
 * break, which would forge a line in this output. */
const ref = (v: string) => (GitRef.safeParse(v).success ? v : '(invalid)');

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
  const window = s.meshWindow ? ' [mesh window]' : '';
  const away =
    s.liveness === 'away' && s.awaySince && s.closesAt
      ? ` [away: no heartbeat since ${hhmm(s.awaySince)}; closes ${hhmm(s.closesAt)} unless it returns]`
      : '';
  return `    · ${s.id} — ${s.description}${where}${owns}${pull}${window}${away}`;
}

/** Local time, `HH:MM`. */
function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * A header line, then the body quoted (`│ `), so no body line can pass for another entry. DECIDES:
 * the hub marked it as from `selfId`'s owner.
 */
export function formatMessage(m: MeshMessage, selfId?: string): string {
  const tags = [
    m.kind,
    m.status,
    m.trust === 'external' ? 'EXTERNAL' : null,
    decides(m, selfId) ? 'DECIDES' : null,
  ]
    .filter(Boolean)
    .join(', ');
  return `--- ${m.from.displayName} [${m.from.id}] (${tags}) ${m.createdAt.slice(0, 16).replace('T', ' ')} UTC · ${m.id}\n${quoteBody(m)}`;
}

export function formatThreadHeader(t: ThreadSummary): string {
  const links = [t.taskId, t.planId].filter(Boolean).join(', ');
  return `${t.id} «${oneLine(t.subject)}» · ${t.kind} · ${t.status} · participants: ${t.participants.join(', ')}${links ? ` · ${links}` : ''}${t.parentId ? ` · parent ${t.parentId}` : ''}`;
}

/** An external task's title comes from outside the team: tagged, and kept on one line. */
const titleOf = (t: Task): string =>
  `${t.trust === 'external' ? `${EXTERNAL_TAG} · ` : ''}${oneLine(t.title)}`;

export function formatThread(
  thread: ThreadSummary,
  messages: readonly MeshMessage[],
  selfId?: string,
): string {
  const entries = messages.map((m) => formatMessage(m, selfId));
  const body = entries.length > 0 ? entries.join('\n\n') : '(no messages)';
  return `${formatThreadHeader(thread)}\n\n${body}`;
}

export function formatTaskLine(t: Task): string {
  const who = t.assignee ? `→ ${t.assignee}` : '→ unassigned';
  const repo = t.repo ? ` · repo ${ref(t.repo)}` : '';
  const branch = t.branch ? ` · branch ${ref(t.branch)}` : '';
  return `- ${t.id} [${t.state}] ${titleOf(t)} ${who} · ${t.priority}${t.area ? ` · ${t.area}` : ''}${repo}${branch}${t.prUrl ? ` · ${t.prUrl}` : ''}`;
}

export function formatTask(t: TaskDetail): string {
  const lines = [
    `${t.id} · ${titleOf(t)}`,
    `state: ${t.state}${t.terminal ? ' (final)' : ''} · workflow: ${t.workflow} · priority: ${t.priority}`,
    `assignee: ${t.assignee ?? 'none'} · creator: ${t.createdBy} · reviewers: ${t.reviewers.join(', ') || 'none'} (round ${t.reviewRound})`,
    [
      t.repo && `repo: ${ref(t.repo)}`,
      t.area && `area: ${t.area}`,
      t.baseBranch && `base: ${ref(t.baseBranch)}`,
      t.branch && `branch: ${ref(t.branch)}`,
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
