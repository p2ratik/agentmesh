import { describe, expect, it } from 'vitest';
import { postNotice } from './lifecycle';
import type { EffectEnv, EffectRun } from './types';

interface Queued {
  text: string;
  trust: string;
}

/** Runs `post_notice` for a task with this title; returns the notice it queued. */
function notice(template: string, title: string, trust = 'team'): Queued | undefined {
  const queued: Queued[] = [];
  const outbox = { enqueueEvent: (_type: string, data: Queued) => queued.push(data) };
  const env = { ctx: { outbox } } as unknown as EffectEnv;
  const run = {
    task: { id: 7, title, state: 'in_review', assignee: 'alice-agent', trust },
    actor: { id: 'alice-agent' },
    params: { channel: 'tasks', text: template },
  } as unknown as EffectRun;
  postNotice(env, run);
  return queued[0];
}

describe('post_notice', () => {
  it('renders placeholders it does not know as empty, including Object.prototype members', () => {
    // `{{constructor}}` found a function, and its source text went into the notice.
    expect(notice('{{constructor}}|{{toString}}|{{nope}}|{{task.state}}', 'x')?.text).toBe(
      '|||in_review',
    );
  });

  it("carries an external task's trust, since its title is event text", () => {
    expect(notice('{{task.title}}', 'x', 'external')?.trust).toBe('external');
    expect(notice('{{task.title}}', 'x')?.trust).toBe('team');
  });
});
