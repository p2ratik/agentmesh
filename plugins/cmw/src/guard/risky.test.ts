// The risky floor and the recursive-search detection, on the command text alone.
import { describe, expect, it } from 'vitest';
import { policy } from './commands.fixture';
import { recursiveSearch, risky } from './risky';

const each = (commands: string[], f: (c: string) => boolean, want: boolean) =>
  expect(commands.map((c) => [c, f(c)])).toEqual(commands.map((c) => [c, want]));
const isRisky = (c: string) => risky(c, policy);

describe('risky', () => {
  it('sees a risky command split over a line continuation', () => {
    each(
      ['git reset \\\n --hard', 'git branch \\\r\n -D x', 'git \\\npush origin main'],
      isRisky,
      true,
    );
  });

  it('asks for discarding, stashes, rsync, buildx pushes and changes through gh', () => {
    each(
      [
        'git checkout .',
        'git stash drop',
        'git stash clear',
        'rsync -a ./ host:/srv',
        'docker buildx build --push -t img .',
        'docker build --push .',
        'gh workflow run deploy.yml',
        'gh run rerun 123',
        'gh release create v1',
        'gh release delete v1',
        'gh api -X DELETE repos/o/r/git/refs/heads/x',
        'gh api --method PUT repos/o/r/topics',
        'gh api --method=POST repos/o/r/issues',
        'gh api -XPATCH repos/o/r',
        'gh api repos/o/r/issues -f title=x',
        'gh pr review 12 --approve',
        'gh pr review 12 -a',
        'gh repo delete o/r --yes',
        'gh secret list',
        'gh secret set X',
        'gh variable set X',
        'gh variable delete X',
      ],
      isRisky,
      true,
    );
  });

  it('leaves reads through gh and safe git commands alone', () => {
    each(
      [
        'git checkout -b agent/pratik/x',
        'git stash list',
        'git stash',
        'gh api repos/o/r/pulls',
        'gh api -X GET repos/o/r',
        'gh pr review 12 --comment -b ok',
        'gh release view v1',
        'gh variable list',
        'gh workflow list',
        'docker build -t img .',
      ],
      isRisky,
      false,
    );
  });
});

describe('recursiveSearch', () => {
  it('finds recursive grep, unignored rg, findstr /s and recursive Select-String', () => {
    each(
      [
        'grep -r TOKEN .',
        'grep -rn foo src',
        'grep -nR foo',
        'grep --recursive foo .',
        'egrep -ri foo .',
        'grep \\\n -r foo .',
        'rg --hidden foo',
        'rg -u foo',
        'rg -uu foo',
        'rg -uuu foo',
        'rg --no-ignore foo',
        'rg --unrestricted foo',
        'findstr /s TOKEN *.*',
        'findstr /S /I token *',
        'Select-String -Path * -Pattern x -Recurse',
        'Get-ChildItem -Recurse | Select-String TOKEN',
        'gci -r *.txt | sls secret',
      ],
      recursiveSearch,
      true,
    );
  });

  it('leaves git grep, a plain grep and a plain rg alone', () => {
    each(
      [
        'git grep -n foo',
        'git --no-pager grep -rn foo',
        'grep -n foo src/a.ts',
        'cat a | grep -e foo',
        'rg foo',
        'rg -n foo src',
        'findstr TOKEN a.txt',
        'Select-String -Path a.txt -Pattern x',
        'Get-ChildItem -Recurse',
      ],
      recursiveSearch,
      false,
    );
  });
});
