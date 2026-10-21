import { describe, expect, it } from 'vitest';
import { postNotice } from './lifecycle';
import type { EffectEnv, EffectRun } from './types';

/** Runs `post_notice` for a task with this title; returns the notice text it queued. */
function notice(template: string, title: string): string | undefined {
  const texts: string[] = [];
  const outbox = { enqueueEvent: (_type: string, data: { text: string }) => texts.push(data.text) };
  const env = { ctx: { outbox } } as unknown as EffectEnv;
  const run = {
    task: { id: 7, title, state: 'in_review', assignee: 'alice-agent' },
    actor: { id: 'alice-agent' },
    params: { channel: 'tasks', text: template },
  } as unknown as EffectRun;
  postNotice(env, run);
  return texts[0];
}

describe('post_notice', () => {
  it('renders placeholders it does not know as empty, including Object.prototype members', () => {
    // `{{constructor}}` found a function, and its source text went into the notice.
    expect(notice('{{constructor}}|{{toString}}|{{nope}}|{{task.state}}', 'x')).toBe(
      '|||in_review',
    );
  });
});
