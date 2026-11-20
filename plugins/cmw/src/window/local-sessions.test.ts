import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalSession } from '../relay/local-session';
import { localSessionsLine } from './local-sessions';

const now = Date.parse('2026-11-05T10:00:00Z');
let root: string;
let data: string;
let n = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'am-local-sessions-'));
  data = join(root, 'data');
  mkdirSync(data);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function checkout(name: string, url: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`);
  return dir;
}

/** A private session's record (relay/local-session.ts), written where the window reads it. */
function record(projectDir: string, over: Partial<LocalSession> = {}) {
  n += 1;
  const s: LocalSession = {
    agentId: 'bob-agent',
    prefix: 'mesh',
    hubSessionId: `s-${String(n).padStart(12, '0')}`,
    uds: null,
    claudePid: 100 + n,
    claudeSessionId: null,
    projectDir,
    relay: true,
    threads: 0,
    from: [],
    updatedAt: new Date(now - 10_000).toISOString(),
    ...over,
  };
  const name = `sess-${s.prefix}-${s.agentId}-${s.hubSessionId}.json`;
  writeFileSync(join(data, name), JSON.stringify(s));
}

const deps = () => ({ dataDir: data, prefix: 'mesh', agentId: 'bob-agent', now });

describe('localSessionsLine', () => {
  it('counts your fresh sessions in the repo, a worktree too, and those with unread replies', () => {
    const web = checkout('web', 'git@github.com:Acme/Web.git');
    const gitdir = join(web, '.git', 'worktrees', 'web-wt');
    mkdirSync(gitdir, { recursive: true });
    mkdirSync(join(root, 'web-wt'));
    writeFileSync(join(root, 'web-wt', '.git'), `gitdir: ${gitdir}\n`);
    record(web);
    record(join(root, 'web-wt'), { threads: 1 });
    record(checkout('api', 'git@github.com:Acme/Api.git'), { threads: 2 });
    record(web, { updatedAt: new Date(now - 3 * 60_000).toISOString() });
    record(web, { agentId: 'carol-agent' });
    record(web, { prefix: 'other' });
    expect(localSessionsLine('acme/web.git', deps())).toBe(
      'local sessions: 2 of your sessions are in this repo (1 with unread mesh replies); tell your human, never message them.',
    );
  });

  it('says "is" for one session', () => {
    record(checkout('web', 'git@github.com:Acme/Web.git'));
    expect(localSessionsLine('acme/web', deps())).toBe(
      'local sessions: 1 of your sessions is in this repo (0 with unread mesh replies); tell your human, never message them.',
    );
  });

  it('says none when no session of yours is in the repo, or there are no records', () => {
    const none = 'local sessions: none of your sessions are in this repo.';
    record(checkout('api', 'git@github.com:Acme/Api.git'));
    expect(localSessionsLine('acme/web', deps())).toBe(none);
    expect(localSessionsLine('acme/web', { ...deps(), dataDir: join(root, 'missing') })).toBe(none);
  });
});
