import {
  type MarkerState,
  markerState,
  readWindowPolicy,
  type WindowPolicy,
} from '@agentmesh/common/window';
import { pullStateDirs } from '../pull/state';

/** What this process knows about being (or not being) the user's mesh window. */
export interface MeshWindowContext {
  state: MarkerState;
  policy: WindowPolicy | null;
  /** The window's policy file is valid and this agent's: its mesh window is set up here. */
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
  // One read serves the marker's check and the set-up question. One ~/.agentmesh serves every
  // Claude account on the laptop, so another agent's policy is no window of this one's.
  const file = readWindowPolicy(home, platform);
  const { state, policy } = markerState(env, file, agentId);
  const setUp = file?.agentId === agentId;
  return { state, policy, setUp, dataDir: pullStateDirs(env, home)[0] ?? '.', folder };
}
