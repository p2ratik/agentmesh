import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  launcherDisplay,
  MESH_WINDOW_ENV,
  ownBranchPrefix,
  parseWindowPolicy,
  readMarker,
  type WindowPolicy,
  windowFiles,
} from './window';

// The real readFileSync, spied on: readMarker must not read the policy without the marker.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});

const TOKEN = 'a'.repeat(32);
const policy: WindowPolicy = {
  version: 1,
  agentId: 'alice-agent',
  token: TOKEN,
  ownBranchPrefix: 'agent/alice/',
  integrationBranch: 'agents',
  testCommands: ['pnpm check'],
};

describe('ownBranchPrefix', () => {
  it('renders the own-branch prefix from the branch template', () => {
    expect(ownBranchPrefix('agent/{owner}/{task}-{slug}', 'alice', 'alice-agent')).toBe(
      'agent/alice/',
    );
    expect(ownBranchPrefix('agent/{agent}/{task}', 'alice', 'alice-agent')).toBe(
      'agent/alice-agent/',
    );
    const p = (tpl: string) => ownBranchPrefix(tpl, 'alice', 'alice-agent');
    // `-` can't end a prefix: ids may contain it, so `alice-` would also cover `alice-2`
    expect(p('agent/{owner}-{slug}')).toBeNull();
    expect(p('{owner}-{task}')).toBeNull();
    expect(p('{owner}_{task}')).toBe('alice_');
    expect(p('agent/{owner}.{task}')).toBe('agent/alice.');
    expect(p('agent/{owner}')).toBeNull();
    expect(p('{task}-{slug}')).toBeNull();
    expect(p('feature/{task}')).toBeNull();
    expect(p('agent/{task}')).toBeNull();
    expect(p('x/{team}/{owner}/{task}')).toBeNull();
    expect(p('agent/{owner}/{team}/{task}')).toBe('agent/alice/');
  });
});

describe('parseWindowPolicy', () => {
  it('parses a valid policy and refuses every malformed one', () => {
    expect(parseWindowPolicy(JSON.stringify(policy))).toEqual(policy);
    for (const ownBranchPrefix of [null, 'alice_', 'agent/alice.']) {
      const ok = { ...policy, ownBranchPrefix };
      expect(parseWindowPolicy(JSON.stringify(ok))).toEqual(ok);
    }
    const bad: unknown[] = [
      { ...policy, token: 'XYZ' },
      { ...policy, agentId: 'Bob' },
      { ...policy, ownBranchPrefix: '../x' },
      { ...policy, ownBranchPrefix: 'agent/alice-' }, // also prefixes teammate alice-2
      { ...policy, ownBranchPrefix: 'agent/alice' },
      { ...policy, testCommands: ['pnpm test; rm -rf ~'] },
      { ...policy, testCommands: Array.from({ length: 11 }, () => 'pnpm test') },
      { ...policy, version: 2 },
    ];
    for (const b of bad) expect(parseWindowPolicy(JSON.stringify(b))).toBeNull();
    expect(parseWindowPolicy('not json')).toBeNull();
  });

  it('keeps the mode, accepts none (an older window init) and refuses an invalid one', () => {
    for (const mode of ['auto', 'manual'] as const) {
      expect(parseWindowPolicy(JSON.stringify({ ...policy, mode }))).toEqual({ ...policy, mode });
    }
    const old = parseWindowPolicy(JSON.stringify(policy));
    expect(old).not.toBeNull();
    expect(old?.mode).toBeUndefined();
    expect(old && 'mode' in old).toBe(false);
    for (const mode of ['default', 'Auto', '', null, 1, 'bypassPermissions']) {
      expect(parseWindowPolicy(JSON.stringify({ ...policy, mode }))).toBeNull();
    }
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
    expect(readMarker({ [MESH_WINDOW_ENV]: TOKEN }, home, 'linux', 'alice-agent').state).toBe(
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

  // The guard and the hook call readMarker on every tool call and prompt, in every session.
  it('never reads the policy file without the marker', () => {
    write();
    vi.mocked(readFileSync).mockClear();
    expect(readMarker({}, home, 'linux')).toEqual({ state: 'none', policy: null });
    expect(readMarker({ [MESH_WINDOW_ENV]: '' }, home, 'linux').state).toBe('none');
    expect(readFileSync).not.toHaveBeenCalled();
    readMarker({ [MESH_WINDOW_ENV]: TOKEN }, home, 'linux');
    expect(readFileSync).toHaveBeenCalledOnce();
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
