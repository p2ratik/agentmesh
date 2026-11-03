import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launcherDisplay, type WindowPolicy } from '@agentmesh/common/window';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeGuardStamp } from '../window/guard-stamp';
import { windowRules } from '../window/rules';
import { fakeHub, text } from './fake-hub';
import { callTool } from './registry';

const NOT_WINDOW =
  "This isn't your mesh window; team work will come here while no mesh window is running. Your human can turn it off with /agentmesh:deactivate and set up a mesh window with /agentmesh:window.";
/** The launcher as this platform runs it (`mesh-window.cmd` on Windows, see launcherDisplay). */
const LAUNCHER = launcherDisplay(process.platform);
const PULL_REFUSED = `This is your mesh window: it never runs pull-only. Call activate again with no arguments to send a new test message; if none arrives, the window was started without the channel flag, so tell your human to restart it with ${LAUNCHER}.`;

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

const GUARD_DOWN =
  "The mesh window's worktree guard did not run for this call, so this session can't take team work. Check that hooks are on (disableAllHooks) and that node is on PATH, then call activate again.";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'am-window-'));
});

afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

/** The verified mesh window, with the guard's stamp as fresh as the guard writes it. */
function verified(deps: ReturnType<typeof fakeHub>['deps'], stamp = true) {
  if (stamp) writeGuardStamp(dataDir, new Date());
  deps.window = { ...deps.window, state: 'verified', policy, dataDir };
}

describe('activate and the mesh window', () => {
  it('the mesh window refuses to activate while the guard is down', async () => {
    const { deps, calls } = fakeHub(answers('mesh window'));
    verified(deps, false);
    for (const args of [{}, { code: 'c-1', description: 'mesh window' }]) {
      const result = await callTool('activate', args, deps);
      expect(result.isError).toBe(true);
      expect(text(result)).toBe(GUARD_DOWN);
    }
    writeGuardStamp(dataDir, new Date(Date.now() - 121_000));
    expect(text(await callTool('activate', {}, deps))).toBe(GUARD_DOWN);
    expect(calls).toEqual([]);
  });

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
    verified(deps);
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
      `AGENTMESH_MESH_WINDOW is set, but it doesn't match ~/.agentmesh/mesh-window.json for alice-agent, so this session can't be your mesh window. Start it with ${LAUNCHER}, or run /agentmesh:window again.`,
    );
    expect(calls).toEqual([]);
  });

  it('the mesh window activates and repeats its rules', async () => {
    const { deps } = fakeHub(answers('mesh window'));
    verified(deps);
    const result = await callTool('activate', { code: 'c-1', description: 'mesh window' }, deps);
    expect(text(result)).toBe(
      `This session is active on the mesh as “mesh window”. It is your mesh window.\n\n${windowRules(policy)}`,
    );
  });
});
