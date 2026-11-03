import { describe, expect, it } from 'vitest';
import { toGitInfo } from './git';

// Built from code points: an editor must never turn these into the characters themselves.
const LS = String.fromCharCode(0x2028);
const NEL = String.fromCharCode(0x85);

describe('toGitInfo', () => {
  it('keeps a repo and branch the hub takes', () => {
    expect(toGitInfo('git@github.com:acme/web.git', 'agent/x')).toEqual({
      repo: 'acme/web',
      branch: 'agent/x',
    });
    expect(toGitInfo(undefined, 'HEAD')).toEqual({});
  });

  it('drops a repo or branch hello would refuse, instead of failing hello and heartbeats', () => {
    // git accepts these in branch names; the hub's GitRef doesn't
    expect(toGitInfo('git@github.com:acme/web.git', `agent/x${LS}y`)).toEqual({ repo: 'acme/web' });
    expect(toGitInfo('git@github.com:acme/web.git', `agent/x${NEL}y`)).toEqual({
      repo: 'acme/web',
    });
    expect(toGitInfo(`git@github.com:acme/w${NEL}eb.git`, 'main')).toEqual({ branch: 'main' });
    expect(toGitInfo('git@github.com:acme/web.git', 'x'.repeat(301))).toEqual({ repo: 'acme/web' });
  });
});
