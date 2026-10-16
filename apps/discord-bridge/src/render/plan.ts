import type { ConfigIndex } from '@agentmesh/config';
import type { DomainEventData, Plan, PlanState, PlanTaskDraft } from '@agentmesh/protocol';
import { planButtonId } from '../custom-ids';
import { list, oneLine, relativeTime, threadTitle } from './format';
import type { PostIntent, ThreadTarget } from './intents';
import { discordUserFor, names } from './people';

const ANNOUNCED_IN_EVENTS: readonly PlanState[] = ['materialized', 'cancelled', 'stalled'];

/** The planning post mirrors the plan's mesh thread, titled `plan-7 · topic`. */
export function planTarget(plan: Plan): ThreadTarget {
  return {
    threadId: plan.threadId,
    title: threadTitle(plan.id, plan.topic),
    starter: `🧭 ${oneLine(`${plan.id} · ${plan.topic}`, 300)}`,
  };
}

/** Opens the planning post with a header, and announces the session in events. */
export function renderPlanStarted(
  data: DomainEventData<'plan.started'>,
  index: ConfigIndex,
): PostIntent[] {
  const { plan } = data;
  return [
    { purpose: 'planning', thread: planTarget(plan), content: planHeader(plan, index) },
    {
      purpose: 'events',
      content: `🧭 ${plan.id} started by ${plan.initiator}: ${oneLine(plan.topic)} · ${plan.participants.length} participants · facilitator ${plan.facilitator}`,
    },
  ];
}

export function planHeader(plan: Plan, index: ConfigIndex): string {
  const rounds = plan.rounds.map((r, i) => `${i + 1}. ${r.title} (${r.minutes} min)`);
  const approval = plan.requireApproval
    ? 'a human approves the plan before tasks are created (`/plan approve` or the button)'
    : 'not required; tasks are created as soon as the facilitator submits';
  return [
    `🧭 **Planning session ${plan.id}**`,
    `**Topic:** ${plan.topic}`,
    `**Facilitator:** ${index.displayName(plan.facilitator)} · **Started by:** ${index.displayName(plan.initiator)}`,
    `**Participants:** ${names(index, plan.participants, 25)}`,
    `**Rounds:** ${[...rounds, 'synthesis'].join(' → ')}`,
    `**Approval:** ${approval}`,
  ].join('\n');
}

/** A status line in the planning post; approval requests carry Approve/Cancel buttons. */
export function renderPlanChanged(
  data: DomainEventData<'plan.changed'>,
  index: ConfigIndex,
): PostIntent[] {
  const { plan, to } = data;
  const post: PostIntent =
    to === 'awaiting_approval'
      ? approvalRequest(plan, index)
      : { purpose: 'planning', thread: planTarget(plan), content: statusLine(data) };
  if (!ANNOUNCED_IN_EVENTS.includes(to)) return [post];
  return [
    post,
    { purpose: 'events', content: `${statusLine(data)} · ${oneLine(plan.topic, 120)}` },
  ];
}

function statusLine({ plan, from, to, round }: DomainEventData<'plan.changed'>): string {
  const deadline = plan.deadline ? ` · ends ${relativeTime(plan.deadline)}` : '';
  switch (to) {
    case 'collecting': {
      const title = plan.rounds.find((r) => r.id === round)?.title ?? round;
      return title
        ? `🔄 ${plan.id}: round **${title}** started${deadline}`
        : `🔄 ${plan.id}: collecting`;
    }
    case 'synthesizing':
      return `✍️ ${plan.id}: ${plan.facilitator} is synthesizing the plan${deadline}`;
    case 'awaiting_approval':
      return `🗳️ ${plan.id} is awaiting approval`;
    case 'materialized':
      return `✅ ${plan.id} materialized into ${plan.taskIds.length} tasks: ${list(plan.taskIds, 30)}`;
    case 'cancelled':
      return `🛑 ${plan.id} cancelled (was ${from})`;
    case 'stalled':
      return `⚠️ ${plan.id} stalled: nobody synthesized it in time; ${plan.initiator} was asked to step in`;
  }
}

function approvalRequest(plan: Plan, index: ConfigIndex): PostIntent {
  const initiator = discordUserFor(index, plan.initiator);
  const drafts = plan.drafts.map((d, i) => `${i + 1}. ${draftLine(d)}`);
  const content = [
    `🗳️ **${plan.id} is ready for approval**${initiator ? ` <@${initiator}>` : ''}`,
    '**Summary**',
    plan.summary ?? '(no summary)',
    `**Proposed tasks (${plan.drafts.length})**`,
    ...drafts,
  ].join('\n');
  return {
    purpose: 'planning',
    thread: planTarget(plan),
    content,
    buttons: [
      { customId: planButtonId('approve', plan.id), label: 'Approve', style: 'success' },
      { customId: planButtonId('cancel', plan.id), label: 'Cancel', style: 'danger' },
    ],
    ...(initiator ? { mentionUserIds: [initiator] } : {}),
  };
}

function draftLine(draft: PlanTaskDraft): string {
  const details = [
    draft.assignee ?? 'auto-assign',
    draft.area ? `area ${draft.area}` : '',
    draft.priority && draft.priority !== 'normal' ? draft.priority : '',
    draft.dependsOn?.length ? `after ${draft.dependsOn.join(', ')}` : '',
    draft.estimateHours ? `~${draft.estimateHours}h` : '',
  ].filter(Boolean);
  return `**${oneLine(draft.title)}** \`${draft.key}\` · ${details.join(' · ')}`;
}
