import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  launcherDisplay,
  MESH_WINDOW_ENV,
  ownBranchPrefix,
  parseWindowPolicy,
  readMarker,
  type WindowPolicy,
  windowFiles,
} from './window';

const TOKEN = 'a'.repeat(32);
const policy: WindowPolicy = {
  version: 1,
  agentId: 'pratik-agent',
  token: TOKEN,
  ownBranchPrefix: 'agent/pratik/',
  integrationBranch: 'agents',
  testCommands: ['pnpm check'],
};

describe('ownBranchPrefix', () => {
  it('renders the own-branch prefix from the branch template', () => {
    expect(ownBranchPrefix('agent/{owner}/{task}-{slug}', 'pratik', 'pratik-agent')).toBe(
      'agent/pratik/',
    );
    expect(ownBranchPrefix('agent/{agent}/{task}', 'pratik', 'pratik-agent')).toBe(
      'agent/pratik-agent/',
    );
    const p = (tpl: string) => ownBranchPrefix(tpl, 'pratik', 'pratik-agent');
    // `-` can't end a prefix: ids may contain it, so `pratik-` would also cover `pratik-2`
    expect(p('agent/{owner}-{slug}')).toBeNull();
    expect(p('{owner}-{task}')).toBeNull();
    expect(p('{owner}_{task}')).toBe('pratik_');
    expect(p('agent/{owner}.{task}')).toBe('agent/pratik.');
    expect(p('agent/{owner}')).toBeNull();
    expect(p('{task}-{slug}')).toBeNull();
    expect(p('feature/{task}')).toBeNull();
    expect(p('agent/{task}')).toBeNull();
    expect(p('x/{team}/{owner}/{task}')).toBeNull();
    expect(p('agent/{owner}/{team}/{task}')).toBe('agent/pratik/');
  });
});

describe('parseWindowPolicy', () => {
  it('parses a valid policy and refuses every malformed one', () => {
    expect(parseWindowPolicy(JSON.stringify(policy))).toEqual(policy);
    for (const ownBranchPrefix of [null, 'pratik_', 'agent/pratik.']) {
      const ok = { ...policy, ownBranchPrefix };
      expect(parseWindowPolicy(JSON.stringify(ok))).toEqual(ok);
    }
    const bad: unknown[] = [
      { ...policy, token: 'XYZ' },
      { ...policy, agentId: 'Bob' },
      { ...policy, ownBranchPrefix: '../x' },
      { ...policy, ownBranchPrefix: 'agent/pratik-' }, // also prefixes teammate pratik-2
      { ...policy, ownBranchPrefix: 'agent/pratik' },
      { ...policy, testCommands: ['pnpm test; rm -rf ~'] },
      { ...policy, testCommands: Array.from({ length: 11 }, () => 'pnpm test') },
      { ...policy, version: 2 },
    ];
    for (const b of bad) expect(parseWindowPolicy(JSON.stringify(b))).toBeNull();
    expect(parseWindowPolicy('not json')).toBeNull();
  });
});

describe('readMarker', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mw-'));
    mkdirSync(join(home, '.agentmesh'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const write = () =>
    writeFileSync(windowFiles(home, 'linux').policy, JSON.stringify(policy), 'utf8');

  it('reads the marker: none, marked or verified', () => {
    write();
    expect(readMarker({}, home, 'linux')).toEqual({ state: 'none', policy: null });
    expect(readMarker({ [MESH_WINDOW_ENV]: TOKEN }, home, 'linux')).toEqual({
      state: 'verified',
      policy,
    });
    expect(readMarker({ [MESH_WINDOW_ENV]: 'b'.repeat(32) }, home, 'linux')).toEqual({
      state: 'marked',
      policy: null,
    });
    expect(readMarker({ [MESH_WINDOW_ENV]: TOKEN }, home, 'linux', 'other-agent').state).toBe(
      'marked',
    );
    expect(readMarker({ [MESH_WINDOW_ENV]: TOKEN }, home, 'linux', 'pratik-agent').state).toBe(
      'verified',
    );
  });

  it('is marked, never throwing, when the policy file is malformed', () => {
    writeFileSync(windowFiles(home, 'linux').policy, '{not json', 'utf8');
    expect(readMarker({ [MESH_WINDOW_ENV]: TOKEN }, home, 'linux')).toEqual({
      state: 'marked',
      policy: null,
    });
  });

  it('is marked, never throwing, when the policy file is missing', () => {
    expect(readMarker({ [MESH_WINDOW_ENV]: TOKEN }, home, 'linux')).toEqual({
      state: 'marked',
      policy: null,
    });
  });
});

describe('windowFiles', () => {
  it("joins with the given platform's separator, whatever the host", () => {
    // A win32 launcher rendered on a Linux host (CI) must still bake backslash paths.
    expect(windowFiles('C:\\Users\\a', 'win32').settings).toBe(
      'C:\\Users\\a\\.agentmesh\\mesh-window.settings.json',
    );
    expect(windowFiles('/home/a', 'linux').settings).toBe(
      '/home/a/.agentmesh/mesh-window.settings.json',
    );
  });

  it('names the launcher by platform, and keeps the claude-mesh fallback in its bin folder', () => {
    expect(windowFiles('/h', 'win32').launcher.endsWith('mesh-window.cmd')).toBe(true);
    expect(windowFiles('/h', 'linux').launcher).toBe('/h/.agentmesh/mesh-window');
    expect(windowFiles('/h', 'linux').bin).toBe('/h/.agentmesh/bin');
  });

  it('displays the launcher so PowerShell and Git Bash find it on windows', () => {
    expect(launcherDisplay('win32')).toBe('~/.agentmesh/mesh-window.cmd');
    expect(launcherDisplay('linux')).toBe('~/.agentmesh/mesh-window');
    expect(launcherDisplay('darwin')).toBe('~/.agentmesh/mesh-window');
  });
});
