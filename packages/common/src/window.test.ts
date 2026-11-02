import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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
    expect(ownBranchPrefix('agent/{owner}-{slug}', 'pratik', 'pratik-agent')).toBe('agent/pratik-');
    expect(ownBranchPrefix('{task}-{slug}', 'pratik', 'pratik-agent')).toBeNull();
  });
});

describe('parseWindowPolicy', () => {
  it('parses a valid policy and refuses every malformed one', () => {
    expect(parseWindowPolicy(JSON.stringify(policy))).toEqual(policy);
    const bad: unknown[] = [
      { ...policy, token: 'XYZ' },
      { ...policy, agentId: 'Bob' },
      { ...policy, ownBranchPrefix: '../x' },
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

  it('is marked, never throwing, when the policy file is missing', () => {
    expect(readMarker({ [MESH_WINDOW_ENV]: TOKEN }, home, 'linux')).toEqual({
      state: 'marked',
      policy: null,
    });
  });
});

describe('windowFiles', () => {
  it('names the launcher by platform', () => {
    expect(windowFiles('/h', 'win32').launcher.endsWith('mesh-window.cmd')).toBe(true);
    expect(windowFiles('/h', 'linux').launcher.endsWith(join('.agentmesh', 'mesh-window'))).toBe(
      true,
    );
  });
});
