import type { WindowPolicy } from '@agentmesh/common/window';
import { describe, expect, it } from 'vitest';
import { windowRules } from './rules';
import {
  HINT_SETUP,
  HINT_START,
  type SessionStartInput,
  sessionStartOutput,
} from './session-start';

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
  setUp: true,
};

describe('sessionStartOutput', () => {
  it('gives the mesh window its rules at every session start', () => {
    const auto = { ...policy, mode: 'auto' as const };
    for (const source of ['startup', 'resume', 'clear', 'compact', 'fork']) {
      expect(sessionStartOutput({ ...base, source, marked: true, policy: auto })).toEqual({
        additionalContext: windowRules(auto),
        systemMessage: null,
      });
    }
  });

  it('tells a window set up before auto mode that it starts in manual mode', () => {
    const old = sessionStartOutput({ ...base, marked: true, policy });
    expect(old.systemMessage).toBe(
      'This mesh window was set up before auto mode, so it starts in manual mode. Run /agentmesh:window again to start it in auto mode (or keep manual: agentmesh window init --mode manual).',
    );
    expect(old.additionalContext).toBe(windowRules(policy));
    for (const mode of ['auto', 'manual'] as const) {
      const set = { ...policy, mode };
      expect(sessionStartOutput({ ...base, marked: true, policy: set })).toEqual({
        additionalContext: windowRules(set),
        systemMessage: null,
      });
    }
    // no policy: the rules already say every command asks
    expect(sessionStartOutput({ ...base, marked: true, policy: null }).systemMessage).toBeNull();
  });

  it('tells a new session once when nothing is listening', () => {
    expect(sessionStartOutput(base)).toEqual({
      additionalContext: null,
      systemMessage: HINT_START,
    });
    expect(sessionStartOutput({ ...base, setUp: false }).systemMessage).toBe(HINT_SETUP);
  });

  it('names claude-mesh, the same start command on every platform', () => {
    expect(HINT_START).toBe(
      "No AgentMesh mesh window is running for this account, so teammates' requests will wait. Start it with claude-mesh in your team's folder. (AGENTMESH_MESH_WINDOW_HINT=off in settings.json env hides this line.)",
    );
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
