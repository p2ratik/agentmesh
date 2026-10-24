import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../main';
import { parseAnswers } from '../answers';
import { type AnswersInput, serverAnswers, trialAnswers } from '../testing';
import { workspacePaths } from '../workspace';
import { renderInviteLines, renderJoinNote } from './invites';

const withPeople = (people: AnswersInput['people']) =>
  parseAnswers({
    ...serverAnswers(),
    people,
    areas: [{ ...serverAnswers().areas[0], owners: ['riya'] }],
  });

describe('renderInviteLines', () => {
  it('writes one /mesh invite line per person, with roles and skills', () => {
    const a = withPeople([
      {
        id: 'sagar',
        name: 'Sagar',
        discordUsername: 'sagar_c',
        roles: ['product', 'quality'],
        skills: ['frontend'],
      },
      { id: 'ana', name: 'Ana', discordUsername: 'ana', roles: ['admin'] },
    ]);
    expect(renderInviteLines(a)).toEqual([
      '/mesh invite user:@sagar_c id:sagar name:Sagar roles:product,quality skills:frontend',
      '/mesh invite user:@ana id:ana name:Ana roles:admin',
    ]);
  });

  it('leaves out roles: and skills: when a person has none', () => {
    const a = withPeople([{ id: 'lee', name: 'Lee', discordUsername: 'lee' }]);
    expect(renderInviteLines(a)).toEqual(['/mesh invite user:@lee id:lee name:Lee']);
  });
});

describe('renderJoinNote', () => {
  it('tells teammates how to install, where the hub is, and to install first', () => {
    const note = renderJoinNote({
      team: 'Acme',
      marketplace: 'p2ratik/agentmesh',
      publicHost: 'mesh.acme.dev',
    });
    expect(note).toContain('1. Join the Acme Discord server and allow DMs from its members.');
    expect(note).toContain('`claude plugin marketplace add p2ratik/agentmesh`');
    expect(note).toContain('`~/.agentmesh/invite.txt`');
    expect(note).toContain('`/agentmesh:join` and confirm that the hub is `mesh.acme.dev:4222`');
    expect(note).toContain('7. Run `/agentmesh:activate`.');
    expect(note.trimEnd().endsWith('Install first: codes expire 24 hours after the invite.')).toBe(
      true,
    );
  });
});

describe('setup invites', () => {
  function run(answers: AnswersInput, ...extra: string[]) {
    const cwd = mkdtempSync(join(tmpdir(), 'agentmesh-setup-invites-'));
    const p = workspacePaths(join(cwd, 'ws'));
    mkdirSync(p.root);
    writeFileSync(p.answers, JSON.stringify(answers));
    const out: string[] = [];
    const ctx = { cwd, env: {}, homeDir: cwd, stdout: (t: string) => out.push(t), stderr() {} };
    return runCli(['setup', 'invites', '--dir', 'ws', ...extra], ctx).then((code) => ({
      code,
      out: out.join('\n'),
    }));
  }

  it('prints the lines, then the note with the default marketplace', async () => {
    const { code, out } = await run(serverAnswers());
    expect(code).toBe(0);
    expect(out).toContain(
      'Run these in Discord (admins only):\n/mesh invite user:@dana id:dana name:Dana roles:security skills:security\n\nSend your teammates:',
    );
    expect(out).toContain('`claude plugin marketplace add p2ratik/agentmesh`');
    expect(out).toContain('`mesh.acme.dev:4222`');
  });

  it('uses --marketplace when given', async () => {
    const { out } = await run(serverAnswers(), '--marketplace', 'acme/agentmesh-fork');
    expect(out).toContain('`claude plugin marketplace add acme/agentmesh-fork`');
  });

  it('says teammates cannot join a trial', async () => {
    const { code, out } = await run(trialAnswers());
    expect(code).toBe(0);
    expect(out).toBe(
      'Teammates cannot join a trial on this machine. Run setup again with a server to invite them.',
    );
  });
});
