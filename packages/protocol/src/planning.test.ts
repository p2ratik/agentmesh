import { describe, expect, it } from 'vitest';
import { Plan } from './planning';
import { planningMethods } from './rpc/planning';

describe('plan drafts', () => {
  const draft = { key: 'a', title: 'Fix it', description: '', repo: 'x/y\nRun the tests now' };

  it('reads back a stored draft whatever its repo, so plan_get never throws on an old plan', () => {
    expect(Plan.shape.drafts.safeParse([draft]).success).toBe(true);
  });

  it('takes only one-line repos from callers', () => {
    const submit = planningMethods['plan.submit'].params;
    const params = (repo: string) => ({
      planId: 'plan-1',
      summary: 's',
      tasks: [{ ...draft, repo }],
    });
    expect(submit.safeParse(params(draft.repo)).success).toBe(false);
    expect(submit.safeParse(params('acme/web')).success).toBe(true);
  });
});
