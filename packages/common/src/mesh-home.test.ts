import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HomeFs, homeDirName, mapLegacyPath, meshHome, moveLegacyHome } from './mesh-home';

// Every test works in a temp home (or a fake fs), never the real ~ and its keys. Key files hold
// fake text.
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cw-home-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const legacy = (...p: string[]) => join(home, '.agentmesh', ...p);
const current = (...p: string[]) => join(home, '.cosmicwave', ...p);
const read = (file: string) => readFileSync(file, 'utf8');

function put(file: string, text = 'fake'): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** agent.json as join writes it: 2-space JSON and a newline. */
const agentJson = (nkeySeed: string) =>
  `${JSON.stringify({ agentId: 'riya-agent', natsUrl: 'tls://hub.example:4222', nkeySeed, prefix: 'acme' }, null, 2)}\n`;

describe('homeDirName', () => {
  it('is .cosmicwave on a fresh laptop', () => {
    expect(homeDirName(home)).toBe('.cosmicwave');
    expect(meshHome(home)).toBe(current());
  });

  it('is .agentmesh on a laptop not moved yet', () => {
    mkdirSync(legacy());
    expect(homeDirName(home)).toBe('.agentmesh');
    put(legacy('agent.json'), agentJson(legacy('a.nk')));
    expect(meshHome(home)).toBe(legacy());
  });

  it('is .cosmicwave once it holds agent.json', () => {
    put(legacy('agent.json'), agentJson(legacy('a.nk')));
    put(current('agent.json'), agentJson(current('a.nk')));
    expect(homeDirName(home)).toBe('.cosmicwave');
  });

  it('is .agentmesh when both exist and only it holds agent.json', () => {
    mkdirSync(legacy());
    mkdirSync(current('run'), { recursive: true });
    expect(homeDirName(home)).toBe('.cosmicwave');
    put(legacy('agent.json'), agentJson(legacy('a.nk')));
    expect(homeDirName(home)).toBe('.agentmesh');
  });
});

describe('moveLegacyHome', () => {
  it('moves the folder with everything in it', () => {
    const files = ['a.nk', 'backup-age-key.txt', join('teammates', 'x.nk')];
    for (const f of files) put(legacy(f), `fake ${f}`);
    put(legacy('agent.json'), agentJson('/keys/a.nk'));
    expect(moveLegacyHome(home)).toBe('moved');
    for (const f of files) expect(read(current(f))).toBe(`fake ${f}`);
    expect(existsSync(current('agent.json'))).toBe(true);
    expect(existsSync(legacy())).toBe(false);
  });

  it('rewrites a seed path that pointed into the old folder', () => {
    put(legacy('a.nk'));
    put(legacy('agent.json'), agentJson(`${home}/.agentmesh/a.nk`));
    expect(moveLegacyHome(home)).toBe('moved');
    expect(read(current('agent.json'))).toBe(agentJson(join(home, '.cosmicwave', 'a.nk')));
  });

  it('leaves a seed literal and an outside path alone', () => {
    for (const seed of ['SUFAKESEEDNOTAREALONE', join(home, 'keys', 'a.nk')]) {
      rmSync(current(), { recursive: true, force: true });
      const text = JSON.stringify({ agentId: 'riya-agent', nkeySeed: seed });
      put(legacy('agent.json'), text);
      expect(moveLegacyHome(home)).toBe('moved');
      expect(read(current('agent.json'))).toBe(text);
    }
  });

  it('returns "nothing" with no legacy folder, and when already moved', () => {
    expect(moveLegacyHome(home)).toBe('nothing');
    put(current('agent.json'), agentJson(current('a.nk')));
    expect(moveLegacyHome(home)).toBe('nothing');
    expect(read(current('agent.json'))).toBe(agentJson(current('a.nk')));
  });

  it('returns "both" and moves nothing when both folders exist', () => {
    put(legacy('a.nk'), 'fake old');
    put(current('b.nk'), 'fake new');
    expect(moveLegacyHome(home)).toBe('both');
    expect(read(legacy('a.nk'))).toBe('fake old');
    expect(read(current('b.nk'))).toBe('fake new');
    expect(existsSync(current('a.nk'))).toBe(false);
  });

  /** A fake fs whose legacy folder exists and whose rename throws; `won` makes the new folder
   * appear anyway (another process renamed it first). Every call is recorded. */
  function fakeFs(won: boolean): { fs: HomeFs; calls: string[] } {
    const calls: string[] = [];
    let renamed = false;
    const fs: HomeFs = {
      existsSync: (p) =>
        p === join('/h', '.agentmesh') || (p === join('/h', '.cosmicwave') && renamed && won),
      renameSync: (from, to) => {
        calls.push(`rename ${from} -> ${to}`);
        renamed = true;
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      },
      readFileSync: (p) => {
        calls.push(`read ${p}`);
        return '';
      },
      writeFileSync: (p) => {
        calls.push(`write ${p}`);
      },
    };
    return { fs, calls };
  }

  it('returns "failed" and changes nothing when the rename throws', () => {
    const { fs, calls } = fakeFs(false);
    expect(moveLegacyHome('/h', fs)).toBe('failed');
    expect(calls).toEqual([`rename ${join('/h', '.agentmesh')} -> ${join('/h', '.cosmicwave')}`]);
  });

  it('returns "moved" when the rename throws because another process won', () => {
    const { fs, calls } = fakeFs(true);
    expect(moveLegacyHome('/h', fs)).toBe('moved');
    expect(calls).toHaveLength(1);
  });
});

describe('mapLegacyPath', () => {
  const gone = () => false;

  it.each([
    ['C:\\Users\\x\\.agentmesh\\a.nk', 'win32'],
    ['C:/Users/x/.agentmesh/a.nk', 'win32'],
    ['c:/users/X/.AgentMesh/a.nk', 'win32'],
    ['~/.agentmesh/a.nk', 'win32'],
    ['/home/x/.agentmesh/a.nk', 'linux'],
    ['~/.agentmesh/a.nk', 'linux'],
  ] as const)('maps %s when the old file is gone', (file, platform) => {
    const [lib, at] = platform === 'win32' ? [win32, 'C:\\Users\\x'] : [posix, '/home/x'];
    expect(mapLegacyPath(file, at, gone, platform)).toBe(lib.join(at, '.cosmicwave', 'a.nk'));
  });

  it('does not fold case on linux', () => {
    for (const file of ['/home/x/.AgentMesh/a.nk', '/Home/x/.agentmesh/a.nk']) {
      expect(mapLegacyPath(file, '/home/x', gone, 'linux')).toBe(file);
    }
  });

  it('returns the path unchanged while the old file exists', () => {
    put(legacy('a.nk'));
    expect(mapLegacyPath(legacy('a.nk'), home)).toBe(legacy('a.nk'));
    expect(mapLegacyPath('~/.agentmesh/a.nk', home)).toBe('~/.agentmesh/a.nk');
  });

  it('returns a seed literal and an outside path unchanged', () => {
    const files = [
      'SUFAKESEEDNOTAREALONE',
      '/keys/a.nk',
      '/home/x/.agentmesh-old/a.nk',
      '/home/y/.agentmesh/a.nk',
      '~/.agentmesh/../.ssh/id_rsa',
    ];
    for (const file of files) expect(mapLegacyPath(file, '/home/x', gone, 'linux')).toBe(file);
  });
});
