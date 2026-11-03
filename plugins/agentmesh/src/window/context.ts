import { type MarkerState, readMarker, type WindowPolicy } from '@agentmesh/common/window';
import { pullStateDirs } from '../pull/state';

/** What this process knows about being (or not being) the user's mesh window. */
export interface MeshWindowContext {
  state: MarkerState;
  policy: WindowPolicy | null;
  dataDir: string;
  folder: string;
}

export const NO_WINDOW: MeshWindowContext = {
  state: 'none',
  policy: null,
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
  return { state, policy, dataDir: pullStateDirs(env, home)[0] ?? '.', folder };
}
