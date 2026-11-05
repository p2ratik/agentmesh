import { existsSync } from 'node:fs';
import {
  type MarkerState,
  readMarker,
  type WindowPolicy,
  windowFiles,
} from '@agentmesh/common/window';
import { pullStateDirs } from '../pull/state';

/** What this process knows about being (or not being) the user's mesh window. */
export interface MeshWindowContext {
  state: MarkerState;
  policy: WindowPolicy | null;
  /** The window's policy file exists: a mesh window is set up on this laptop. */
  setUp: boolean;
  dataDir: string;
  folder: string;
}

export const NO_WINDOW: MeshWindowContext = {
  state: 'none',
  policy: null,
  setUp: false,
  dataDir: '.',
  folder: '.',
};

export function meshWindowContext(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
  folder: string,
  agentId: string,
): MeshWindowContext {
  const { state, policy } = readMarker(env, home, platform, agentId);
  // Without the marker readMarker doesn't open the file; an ordinary session only needs to know
  // it exists, to say how to start the window rather than how to set one up.
  const setUp = policy !== null || existsSync(windowFiles(home, platform).policy);
  return { state, policy, setUp, dataDir: pullStateDirs(env, home)[0] ?? '.', folder };
}
