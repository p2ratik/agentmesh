// The guard in auto mode: unlisted commands go to auto mode's classifier, except the risky floor.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { policy } from './commands.fixture';
import { decide, type GuardContext } from './decide';
import { fixture, mesh, slash } from './paths.fixture';

// The real worktree reader, with a switch that makes it throw.
const boom = vi.hoisted(() => ({ on: false }));
vi.mock('./paths', async (original) => {
  const real = await original<typeof import('./paths')>();
  return {
    ...real,
    meshWorktreeOf: (...a: Parameters<typeof real.meshWorktreeOf>) => {
      if (boom.on) throw new Error('boom');
      return real.meshWorktreeOf(...a);
    },
  };
});

let base: string;
let repo: string;
let W: string;
let R: string;
let ctx: GuardContext;

beforeEach(() => {
  const f = fixture();
  ({ base, repo } = f);
  ctx = { marked: true, policy, home: f.o.home, platform: f.o.platform };
  W = mesh(repo, 'mesh-task-1-a', 'agent/pratik/task-1-a');
  R = mesh(repo, 'mesh-review-2', 'agent/bob/task-2-x');
  boom.on = false;
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** `mode` null: the hook input has no permission_mode. */
const call = (tool: string, command: string, mode: string | null, cwd = repo) => ({
  tool_name: tool,
  tool_input: { command },
  cwd,
  ...(mode === null ? {} : { permission_mode: mode }),
});
const kind = (tool: string, command: string, mode: string | null = 'auto', cwd = repo) =>
  decide(call(tool, command, mode, cwd), ctx);

const PASS = { kind: 'pass' };
const RISKY = {
  kind: 'ask',
  reason:
    'mesh window: this command can push, merge, rewrite or delete work, or reach infrastructure, so your human decides even in auto mode',
  code: 'command.risky',
};
const UNLISTED = {
  kind: 'ask',
  reason: "mesh window: this command isn't on the window's list, so your human decides",
  code: 'command.not_listed',
};

const HARMLESS = [
  'cat src/a.ts',
  // a recursive grep from the checkout asks (auto-places.test.ts); a plain one doesn't
  'grep -n foo src/a.ts',
  'node scripts/x.mjs',
  'git commit -m "fix push"',
  'git rebase origin/agents',
  'git rebase refs/remotes/origin/agents',
  'git branch -a',
  'git clean -n',
  'git checkout -b agent/pratik/task-9-x',
  'git log --grep=push',
  'git merge-base HEAD origin/agents',
  'cat terraform/main.tf',
  'ls ~/aws-notes',
  'docker compose up -d',
];

const RISKY_COMMANDS = [
  'git push origin main',
  'git push --force origin agent/pratik/task-1-a',
  'git push origin :agent/pratik/task-1-a',
  'git push -u origin agents',
  'git push origin HEAD:refs/heads/main',
  'git -C repo push',
  'git merge origin/agents',
  'gh pr merge 12 --squash',
  'git rebase main',
  'git rebase -i HEAD~3',
  'git rebase --onto main x',
  'git branch -d x',
  'git branch -D x',
  'git branch --delete x',
  'git reset --hard HEAD~1',
  'git clean -fd',
  'git clean -xdf',
  'git checkout -- src/a.ts',
  'git restore src/a.ts',
  'terraform apply',
  'pulumi up',
  'kubectl delete pod x',
  'helm install x ./chart',
  'az vm list',
  'aws s3 ls',
  'gcloud auth list',
  'docker push img:1',
  'ssh mesh@example.com',
  'scp a host:b',
  // a compound command can't hide one
  'git status && git push --force',
  'ls; git push origin main',
  'echo $(git push origin main)',
  'cat x | ssh host',
  'bash -c "git push --force"',
  'pnpm build && terraform apply -auto-approve',
  'sudo kubectl get pods',
];

describe('the guard in auto mode', () => {
  it('hands an unlisted harmless command to auto mode', () => {
    expect(HARMLESS.map((c) => [c, kind('Bash', c)])).toEqual(HARMLESS.map((c) => [c, PASS]));
  });

  it('asks for each risky family, inside a compound command too', () => {
    expect(RISKY_COMMANDS.map((c) => [c, kind('Bash', c)])).toEqual(
      RISKY_COMMANDS.map((c) => [c, RISKY]),
    );
  });

  it("asks for the own-branch push when it isn't the listed form alone", () => {
    const own = `cd "${slash(W)}" && git push -u origin agent/pratik/task-1-a`;
    expect(kind('Bash', own)).toEqual(PASS);
    expect(kind('Bash', `${own} && echo done`)).toEqual(RISKY);
  });

  it('checks PowerShell and Monitor the same way, and no longer always asks for them', () => {
    for (const tool of ['PowerShell', 'Monitor']) {
      expect(kind(tool, 'Get-Content src/a.ts')).toEqual(PASS);
      expect(kind(tool, 'git push origin main')).toEqual(RISKY);
      expect(kind(tool, 'kubectl logs -f x')).toEqual(RISKY);
    }
  });

  it("asks before any command in a worktree that isn't on the window's own branch", () => {
    const theirs = {
      kind: 'ask',
      reason:
        "mesh window: agent/bob/task-2-x isn't your branch, so running its tests needs your human's approval",
      code: 'command.needs_approval',
    };
    expect(kind('Bash', `cd "${slash(R)}" && pnpm vitest run`)).toEqual(theirs);
    expect(kind('Bash', 'pnpm vitest run', 'auto', R)).toEqual(theirs);
    expect(kind('PowerShell', 'pnpm vitest run', 'auto', R)).toEqual(theirs);
    expect(kind('Bash', `cd "${slash(W)}" && pnpm vitest run`)).toEqual(PASS);
    // reads there still pass, as in manual mode
    expect(kind('Bash', 'git log', 'auto', R)).toEqual(PASS);
  });

  it('keeps every other ask and deny', () => {
    // a listed test on a branch the window didn't write
    expect(kind('Bash', `cd "${slash(R)}" && pnpm check`)).toMatchObject({
      kind: 'ask',
      code: 'command.needs_approval',
    });
    expect(decide(call('Bash', 'cat x', 'auto'), { ...ctx, policy: null })).toMatchObject({
      kind: 'ask',
      code: 'marker.unverified',
    });
    expect(decide(call('PowerShell', 'dir', 'auto'), { ...ctx, policy: null })).toMatchObject({
      kind: 'ask',
    });
    const workflow = {
      tool_name: 'Workflow',
      tool_input: { script: 'x' },
      permission_mode: 'auto',
    };
    expect(decide(workflow, ctx)).toMatchObject({ kind: 'ask', code: 'tool.workflow' });
    const edit = { tool_name: 'Edit', tool_input: { file_path: join(repo, 'src', 'a.ts') } };
    expect(decide({ ...edit, permission_mode: 'auto' }, ctx)).toMatchObject({
      kind: 'deny',
      code: 'path.outside_worktree',
    });
    const enter = { tool_name: 'EnterWorktree', tool_input: {}, permission_mode: 'auto' };
    expect(decide(enter, ctx)).toMatchObject({ kind: 'deny', code: 'tool.enter_worktree' });
  });

  it('asks, never passes, when a check of its own throws', () => {
    boom.on = true;
    const failed = { kind: 'ask', code: 'guard.error' };
    for (const tool of ['Bash', 'PowerShell', 'Monitor']) {
      expect(kind(tool, 'cat src/a.ts')).toMatchObject(failed);
    }
  });
});

describe('the guard in every other mode', () => {
  it('asks for unlisted and risky commands and for PowerShell and Monitor, as before', () => {
    const modes = [
      null,
      'default',
      'plan',
      'acceptEdits',
      'dontAsk',
      'bypassPermissions',
      'Auto',
      '',
    ];
    for (const mode of modes) {
      expect(kind('Bash', 'cat src/a.ts', mode)).toEqual(UNLISTED);
      expect(kind('Bash', 'git push origin main', mode)).toEqual(UNLISTED);
      expect(kind('Bash', 'pnpm vitest run', mode, R)).toEqual(UNLISTED);
      for (const tool of ['PowerShell', 'Monitor']) {
        expect(kind(tool, 'Get-Content src/a.ts', mode)).toEqual({
          kind: 'ask',
          reason: `mesh window: ${tool} commands need your human's approval here`,
          code: 'command.needs_approval',
        });
      }
    }
  });
});
