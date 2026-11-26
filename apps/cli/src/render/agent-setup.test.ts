import { describe, expect, it } from 'vitest';
import { type AgentSetupInput, renderAgentSetup } from './agent-setup';

const input = (over: Partial<AgentSetupInput> = {}): AgentSetupInput => ({
  agentId: 'bob-agent',
  displayName: "Bob's agent",
  owner: 'bob',
  natsUrl: 'tls://mesh.example.com:4222',
  seedFile: '~/.cosmicwave/bob-agent.nk',
  seedFound: true,
  prefix: 'mesh',
  marketplace: 'p2ratik/cosmicwave',
  wroteConfig: null,
  ...over,
});
const line = (text: string, start: string) =>
  text.split('\n').find((l) => l.trimStart().startsWith(start)) ?? '';

describe('renderAgentSetup', () => {
  it('quotes a marketplace path with a space, so the printed line can be pasted', () => {
    // A tester's clone sat in "...\mesh baal\cosmicwave": unquoted, the shell split it in two.
    const spaced = 'C:\\Users\\x\\mesh baal\\cosmicwave';
    expect(
      line(renderAgentSetup(input({ marketplace: spaced })), 'claude plugin marketplace'),
    ).toBe(`   claude plugin marketplace add "${spaced}"`);
  });

  it('leaves a repository name and a path without spaces as they are', () => {
    for (const marketplace of [
      'p2ratik/cosmicwave',
      '/home/x/cosmicwave',
      'C:\\code\\cosmicwave',
    ]) {
      expect(line(renderAgentSetup(input({ marketplace })), 'claude plugin marketplace')).toBe(
        `   claude plugin marketplace add ${marketplace}`,
      );
    }
  });

  it('says how the options are entered: on the install line, or later in Claude Code', () => {
    const out = renderAgentSetup(input());
    expect(line(out, '3.')).toBe(
      '3. Plugin settings (add each to the install line as --config key=value, or set them later',
    );
    expect(out).toContain('   with /plugin configure cmw@cosmicwave in Claude Code)');
    expect(out).toContain('   agent_id   bob-agent');
    expect(out).toContain('   nkey_seed  ~/.cosmicwave/bob-agent.nk');
  });

  it('after --write, says the options may stay empty, and when the file is ignored', () => {
    const out = renderAgentSetup(input({ wroteConfig: '/home/bob/.cosmicwave/agent.json' }));
    const last = out.split('\n').at(-1) ?? '';
    expect(last).toBe(
      'Wrote /home/bob/.cosmicwave/agent.json. With it you can leave every plugin option empty: it supplies all four. If you do enter agent_id or nats_url, they must match this file, or the plugin ignores it. Its prefix wins over the prefix option.',
    );
    // The sentence this replaced was false: a session with empty options and this file connects.
    expect(out).not.toContain('must still be entered');
  });

  it('without --write, offers it', () => {
    expect(renderAgentSetup(input()).split('\n').at(-1)).toBe(
      'Tip: add --write to save these values to ~/.cosmicwave/agent.json. With that file you can leave every plugin option empty.',
    );
  });
});
