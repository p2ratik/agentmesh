import type { WindowPolicy } from '@agentmesh/common/window';
import { describe, expect, it } from 'vitest';
import { windowRules } from '../window/rules';
import { fakeHub, text } from './fake-hub';
import { callTool } from './registry';

const NOT_WINDOW =
  "This isn't your mesh window; team work will come here while no mesh window is running. Your human can turn it off with /agentmesh:deactivate and set up a mesh window with /agentmesh:window.";
const PULL_REFUSED =
  'This is your mesh window: it never runs pull-only. Call activate again with no arguments to send a new test message; if none arrives, the window was started without the channel flag, so tell your human to restart it with ~/.agentmesh/mesh-window.';

const policy: WindowPolicy = {
  version: 1,
  agentId: 'alice-agent',
  token: 'a'.repeat(32),
  ownBranchPrefix: null,
  integrationBranch: 'agents',
  testCommands: [],
};

const view = (description: string) => ({
  id: 's-aaaaaaaaaaaa',
  active: true,
  description,
  repo: null,
  branch: null,
  owns: [],
});

const answers = (description: string) => ({
  'session.activate': { ...view(description), delivery: 'push' },
});

describe('activate and the mesh window', () => {
  it('activating an ordinary session warns that team work will come here', async () => {
    const { deps } = fakeHub(answers('web client'));
    const result = await callTool('activate', { code: 'c-1', description: 'web client' }, deps);
    expect(text(result)).toBe(`This session is active on the mesh as “web client”. ${NOT_WINDOW}`);
    const pull = fakeHub({ 'session.activate': { ...view('web client'), delivery: 'pull' } });
    const pulled = await callTool('activate', { pull: true, description: 'web client' }, pull.deps);
    expect(text(pulled).endsWith(NOT_WINDOW)).toBe(true);
  });

  it('the mesh window never activates pull-only', async () => {
    const { deps, calls } = fakeHub(answers('x'));
    deps.window = { ...deps.window, state: 'verified', policy };
    const result = await callTool('activate', { pull: true, description: 'x' }, deps);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(PULL_REFUSED);
    expect(calls).toEqual([]);
  });

  it('a marker that does not match the launcher refuses', async () => {
    const { deps, calls } = fakeHub(answers('x'));
    deps.window = { ...deps.window, state: 'marked' };
    const result = await callTool('activate', { code: 'c-1', description: 'x' }, deps);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "AGENTMESH_MESH_WINDOW is set, but it doesn't match ~/.agentmesh/mesh-window.json for alice-agent, so this session can't be your mesh window. Start it with ~/.agentmesh/mesh-window, or run /agentmesh:window again.",
    );
    expect(calls).toEqual([]);
  });

  it('the mesh window activates and repeats its rules', async () => {
    const { deps } = fakeHub(answers('mesh window'));
    deps.window = { ...deps.window, state: 'verified', policy };
    const result = await callTool('activate', { code: 'c-1', description: 'mesh window' }, deps);
    expect(text(result)).toBe(
      `This session is active on the mesh as “mesh window”. It is your mesh window.\n\n${windowRules(policy)}`,
    );
  });
});
