// Built-ins only (the hook bundle imports this): what SessionStart needs from the policy file,
// from one read of it, the way `meshWindowContext` does for activate.
import { markerState, readWindowPolicy, type WindowPolicy } from '@agentmesh/common/window';

export function windowStartState(
  env: Record<string, string | undefined>,
  agentId: string | null,
  home: string,
  platform: NodeJS.Platform,
  readPolicy: (home: string, platform: NodeJS.Platform) => WindowPolicy | null = readWindowPolicy,
): { policy: WindowPolicy | null; setUp: boolean } {
  const file = readPolicy(home, platform);
  const { policy } = markerState(env, file);
  return { policy, setUp: !!agentId && file?.agentId === agentId };
}
