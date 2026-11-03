import type { WindowPolicy } from '@agentmesh/common/window';
import { describe, expect, it } from 'vitest';
import { windowRules } from './rules';
import { HINT_SETUP, hintStart, type SessionStartInput, sessionStartOutput } from './session-start';

const policy: WindowPolicy = {
  version: 1,
  agentId: 'alice-agent',
  token: 'a'.repeat(32),
  ownBranchPrefix: null,
  integrationBranch: 'agents',
  testCommands: [],
};
const base: SessionStartInput = {
  source: 'startup',
  marked: false,
  policy: null,
  enrolled: true,
  hintOff: false,
  listening: false,
  launcherExists: true,
  platform: 'linux',
};

describe('sessionStartOutput', () => {
  it('gives the mesh window its rules at every session start', () => {
    for (const source of ['startup', 'resume', 'clear', 'compact', 'fork']) {
      expect(sessionStartOutput({ ...base, source, marked: true, policy })).toEqual({
        additionalContext: windowRules(policy),
        systemMessage: null,
      });
    }
  });

  it('tells a new session once when nothing is listening', () => {
    expect(sessionStartOutput(base)).toEqual({
      additionalContext: null,
      systemMessage: hintStart('linux'),
    });
    expect(sessionStartOutput({ ...base, launcherExists: false }).systemMessage).toBe(HINT_SETUP);
  });

  it('names the launcher the way this platform runs it', () => {
    expect(sessionStartOutput({ ...base, platform: 'win32' }).systemMessage).toBe(
      "No AgentMesh mesh window is running for this account, so teammates' requests will wait. Start it with ~/.agentmesh/mesh-window.cmd in your team's folder. (AGENTMESH_MESH_WINDOW_HINT=off in settings.json env hides this line.)",
    );
    expect(hintStart('linux')).toContain('Start it with ~/.agentmesh/mesh-window in');
  });

  it('stays quiet otherwise', () => {
    const quiet = { additionalContext: null, systemMessage: null };
    expect(sessionStartOutput({ ...base, listening: true })).toEqual(quiet);
    for (const source of ['resume', 'clear', 'compact', undefined]) {
      expect(sessionStartOutput({ ...base, source })).toEqual(quiet);
    }
    expect(sessionStartOutput({ ...base, hintOff: true })).toEqual(quiet);
    expect(sessionStartOutput({ ...base, enrolled: false })).toEqual(quiet);
  });
});
