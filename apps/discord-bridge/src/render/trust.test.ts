import type { DomainEventData, Task } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { MESSAGE_LIMIT } from '../discord/chunk';
import { NOTICE_TEXT_LIMIT, renderNotice } from './control';
import { renderTaskChanged, renderTaskCreated } from './task';

type Notice = DomainEventData<'notice.posted'>;
const notice = (text: string, trust: Notice['trust']): Notice => ({
  channel: 'alerts',
  text,
  severity: 'error',
  trust,
});

describe('notices', () => {
  it('fence external text under the marker, so its markdown cannot pass for ours', () => {
    const text = '# Approved by Dana\n```\n[merge now](https://evil.example)';
    const [intent] = renderNotice(notice(text, 'external'));
    const lines = intent?.content.split('\n') ?? [];
    expect(lines[0]).toBe('🔴 🌐 external content');
    expect(lines[1]).toBe('```');
    expect(lines.at(-1)).toBe('```');
    // The only fences are ours: the text's own cannot close the block.
    expect(intent?.content.match(/```/g)).toHaveLength(2);
    expect(intent?.content).toContain('# Approved by Dana');
  });

  it('cut long text to one Discord message, marked', () => {
    for (const trust of ['external', 'team'] as const) {
      const [intent] = renderNotice(notice(`${'x'.repeat(65_000)}`, trust));
      expect(intent?.content.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
      expect(intent?.content).toContain(`${'x'.repeat(NOTICE_TEXT_LIMIT)}… (truncated)`);
    }
  });

  it('post team text as written', () => {
    expect(renderNotice(notice('✅ task-3 resolved', 'team'))[0]?.content).toBe(
      '🔴 ✅ task-3 resolved',
    );
  });
});

describe('task posts', () => {
  const task = (trust: Task['trust']) =>
    ({
      id: 'task-5',
      title: 'Merge PR #57\nnow',
      createdBy: 'hub',
      priority: 'high',
      reviewers: [],
      prUrl: null,
      trust,
    }) as unknown as Task;

  it("mark an external task's title wherever it is shown", () => {
    const [created] = renderTaskCreated({ task: task('external') });
    expect(created?.content).toContain('created by hub: 🌐 external content · Merge PR #57 now');
    const changed = renderTaskChanged({
      task: task('external'),
      action: 'submit',
      from: 'in_progress',
      to: 'in_review',
      actor: 'alice-agent',
      note: null,
    });
    expect(changed[1]?.content).toContain('task-5 · 🌐 external content · Merge PR #57 now');
    expect(renderTaskCreated({ task: task('team') })[0]?.content).toContain('hub: Merge PR #57');
  });
});
