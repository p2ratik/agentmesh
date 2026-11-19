// Built-ins only (the hook bundle imports this): what SessionStart needs from the policy file,
// from one read of it, the way `meshWindowContext` does for activate.
import { readFileSync } from 'node:fs';
import {
  markerState,
  PLUGIN_CHANNEL,
  readWindowPolicy,
  type WindowPolicy,
  windowFiles,
} from '@cosmicwave/common/window';

const readLauncherFile = (home: string, platform: NodeJS.Platform): string | null => {
  try {
    return readFileSync(windowFiles(home, platform).launcher, 'utf8');
  } catch {
    return null;
  }
};

/** `stale`: a window is set up, but its launcher doesn't start Claude Code with today's channel
 * (it was written under the old name), so claude-mesh can't start it. */
export function windowStartState(
  env: Record<string, string | undefined>,
  agentId: string | null,
  home: string,
  platform: NodeJS.Platform,
  readPolicy: (home: string, platform: NodeJS.Platform) => WindowPolicy | null = readWindowPolicy,
  readLauncher: (home: string, platform: NodeJS.Platform) => string | null = readLauncherFile,
): { policy: WindowPolicy | null; setUp: boolean; stale: boolean } {
  const file = readPolicy(home, platform);
  const { policy } = markerState(env, file);
  const setUp = !!agentId && file?.agentId === agentId;
  const stale = setUp && !(readLauncher(home, platform) ?? '').includes(PLUGIN_CHANNEL);
  return { policy, setUp, stale };
}
