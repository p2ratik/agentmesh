import type { DomainEventData, Task } from '@agentmesh/protocol';
import { link, list, oneLine } from './format';
import type { PostIntent } from './intents';

/** Review-related workflow states, recognised by name since workflows are config. */
export function isReviewState(state: string | null): boolean {
  if (!state) return false;
  return state.includes('review') || state === 'approved' || state === 'changes_requested';
}

/** `📋 task-42 created by alice-agent: Title · area api · → bob-agent` in the events feed. */
export function renderTaskCreated(data: DomainEventData<'task.created'>): PostIntent[] {
  const { task } = data;
  const details = [
    task.area ? `area ${task.area}` : '',
    task.repo ? `repo ${task.repo}` : '',
    task.assignee ? `→ ${task.assignee}` : 'on the board',
    task.priority === 'normal' ? '' : `${task.priority} priority`,
    task.planId ? `from ${task.planId}` : '',
  ].filter(Boolean);
  const content = `📋 ${task.id} created by ${task.createdBy}: ${oneLine(task.title)} · ${details.join(' · ')}`;
  return [{ purpose: 'events', content }];
}

/** A transition line in events, plus one in reviews when it enters or leaves review. */
export function renderTaskChanged(data: DomainEventData<'task.changed'>): PostIntent[] {
  const { task, from, to, actor, note } = data;
  const tail = `${noteText(note)}${prText(task)}`;
  const intents: PostIntent[] = [
    { purpose: 'events', content: `🔁 ${task.id} ${transition(from, to)} by ${actor}${tail}` },
  ];
  if (isReviewState(from) || isReviewState(to)) {
    const reviewers =
      isReviewState(to) && task.reviewers.length > 0 ? ` · reviewers ${list(task.reviewers)}` : '';
    intents.push({
      purpose: 'reviews',
      content: `${reviewEmoji(to)} ${task.id} · ${oneLine(task.title, 120)} · ${transition(from, to)} by ${actor}${reviewers}${tail}`,
    });
  }
  return intents;
}

function transition(from: string | null, to: string): string {
  return from ? `${from} → ${to}` : `→ ${to}`;
}

function noteText(note: string | null): string {
  return note ? `: ${oneLine(note, 300)}` : '';
}

function prText(task: Task): string {
  return task.prUrl ? ` ${link(task.prUrl)}` : '';
}

function reviewEmoji(to: string): string {
  if (to === 'approved') return '✅';
  if (to === 'changes_requested') return '🛠️';
  return isReviewState(to) ? '🔍' : '🏁';
}
