import type { PlanRound } from '@agentmesh/protocol';
import { planKey, threadKey } from '../../core/ids';
import type { PlanRecord } from './plans.repo';

/** Messages of a planning session, written for Claude Code agents. */

type Name = (participantId: string) => string;

const head = (plan: PlanRecord) => `**${planKey(plan.id)} · ${plan.topic}**`;

export function deadlineText(deadline: string | null, now: Date): string {
  if (!deadline) return 'no deadline';
  const at = new Date(deadline);
  const minutes = Math.max(0, Math.round((at.getTime() - now.getTime()) / 60_000));
  return `${at.toISOString().slice(11, 16)} UTC (in ${minutes} min)`;
}

function contributeHelp(plan: PlanRecord): string {
  return [
    `Contribute: \`plan_contribute(plan_id: "${planKey(plan.id)}", body: "…")\` — you may contribute more than once.`,
    `Discuss directly in the planning thread: \`reply(thread_id: "${threadKey(plan.threadId)}", text: "…")\`.`,
    `Everything so far: \`plan_get(plan_id: "${planKey(plan.id)}")\`.`,
  ].join('\n');
}

function roundHeader(plan: PlanRecord, round: PlanRound, now: Date): string {
  return `Round ${plan.roundIndex + 1}/${plan.rounds.length} — ${round.title} · deadline ${deadlineText(plan.deadline, now)}`;
}

export function inviteText(plan: PlanRecord, round: PlanRound, name: Name, now: Date): string {
  return [
    `${head(plan)} — planning session started by ${name(plan.initiator)}.`,
    `Facilitator: ${plan.facilitator} · participants: ${plan.participants.join(', ')}`,
    roundHeader(plan, round, now),
    '',
    round.prompt,
    '',
    contributeHelp(plan),
  ].join('\n');
}

export function nextRoundText(
  plan: PlanRecord,
  round: PlanRound,
  compiled: string,
  now: Date,
): string {
  return [
    `${head(plan)} — next round.`,
    roundHeader(plan, round, now),
    '',
    round.prompt,
    '',
    '## Session so far',
    compiled,
    '',
    contributeHelp(plan),
  ].join('\n');
}

export function synthesisText(
  plan: PlanRecord,
  prompt: string,
  compiled: string,
  now: Date,
): string {
  const id = planKey(plan.id);
  return [
    `${head(plan)} — you are the facilitator. Synthesize the plan by ${deadlineText(plan.deadline, now)}.`,
    '',
    prompt,
    '',
    `Submit with \`plan_submit(plan_id: "${id}", summary: "…", tasks: [...])\`. Each task: key (lowercase-dashes),`,
    'title, description, and optionally area, repo, assignee (agent id), priority (low|normal|high|urgent),',
    'labels, depends_on (keys of other tasks), done_when, estimate_hours.',
    '',
    '## Session',
    compiled,
  ].join('\n');
}

export function synthesizingNotice(plan: PlanRecord, now: Date): string {
  return `${head(plan)}: ${plan.facilitator} is synthesizing the plan (due ${deadlineText(plan.deadline, now)}). You'll get the result here.`;
}

export function handoffText(plan: PlanRecord, previous: string): string {
  return `${head(plan)}: the synthesis deadline passed, so facilitation moved from ${previous} to ${plan.facilitator}.`;
}

export function stalledText(plan: PlanRecord): string {
  return `${head(plan)} stalled: nobody submitted the synthesis in time. Please pick a facilitator and restart with /plan, or cancel it.`;
}

export function approvalText(plan: PlanRecord): string {
  return [
    `${head(plan)} is ready for approval (${plan.drafts.length} tasks).`,
    plan.summary ?? '',
    `Approve with \`/plan approve plan:${planKey(plan.id)}\` or cancel with \`/plan cancel\`.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function materializedText(
  plan: PlanRecord,
  tasks: ReadonlyArray<{ id: string; title: string; assignee: string | null; dependsOn: string[] }>,
): string {
  const lines = tasks.map(
    (t) =>
      `- ${t.id} · ${t.title} → ${t.assignee ?? 'board (unassigned)'}${t.dependsOn.length > 0 ? ` · after ${t.dependsOn.join(', ')}` : ''}`,
  );
  return [`${head(plan)} is final. Tasks created:`, lines.join('\n'), plan.summary ?? '']
    .filter(Boolean)
    .join('\n\n');
}

export function cancelledText(plan: PlanRecord, by: string, reason: string | null): string {
  return `${head(plan)} was cancelled by ${by}${reason ? `: ${reason}` : '.'}`;
}
