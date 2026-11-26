import { describe, expect, it } from 'vitest';
import { pickWebhook } from './webhooks';

const hook = (name: string, token: string | null = 't') => ({ name, token });

describe('pickWebhook', () => {
  it('reuses a webhook named Cosmicwave', () => {
    const h = hook('Cosmicwave');
    expect(pickWebhook([hook('other'), h])).toBe(h);
  });

  it('reuses a webhook named AgentMesh when there is no Cosmicwave one', () => {
    const h = hook('AgentMesh');
    expect(pickWebhook([hook('other'), h])).toBe(h);
  });

  it('prefers Cosmicwave when both exist', () => {
    const h = hook('Cosmicwave');
    expect(pickWebhook([hook('AgentMesh'), h])).toBe(h);
  });

  it('ignores a webhook without a token, and other names', () => {
    expect(pickWebhook([hook('Cosmicwave', null), hook('AgentMesh', null), hook('x')])).toBe(
      undefined,
    );
  });
});
