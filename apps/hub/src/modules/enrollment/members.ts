import type { MeshConfig } from '@agentmesh/config';
import type { MemberRecord } from '@agentmesh/protocol';

export interface MergedTeam {
  config: MeshConfig;
  /** Members left out because mesh.yaml already uses one of their ids, Discord id or key. */
  shadowed: string[];
}

/** Every id, Discord id and agent key mesh.yaml already claims. */
export function claimedByConfig(config: MeshConfig): {
  ids: Set<string>;
  discordIds: Set<string>;
  nkeys: Set<string>;
} {
  return {
    ids: new Set([
      config.hub.serviceId,
      ...config.humans.map((h) => h.id),
      ...config.agents.map((a) => a.id),
      ...config.services.map((s) => s.id),
    ]),
    discordIds: new Set(config.humans.flatMap((h) => (h.discordUserId ? [h.discordUserId] : []))),
    nkeys: new Set(
      [
        config.hub.nkey,
        // The hub's system-account user may kick connections: never hand it to a member.
        config.hub.authCallout?.sysNkey,
        ...config.agents.map((a) => a.nkey),
        ...config.services.map((s) => s.nkey),
      ].filter((k): k is string => !!k),
    ),
  };
}

/**
 * mesh.yaml plus the registry's active members, each as a human and their
 * agent. mesh.yaml wins: a member that collides with it is left out, never
 * merged over it. Pure, so the hub can rebuild its index after every change.
 */
export function withMembers(config: MeshConfig, members: readonly MemberRecord[]): MergedTeam {
  const claimed = claimedByConfig(config);
  const humans = [...config.humans];
  const agents = [...config.agents];
  const shadowed: string[] = [];
  for (const m of members) {
    if (m.status !== 'active') continue;
    const collides =
      claimed.ids.has(m.humanId) ||
      claimed.ids.has(m.agentId) ||
      claimed.nkeys.has(m.nkey) ||
      (m.discordUserId !== null && claimed.discordIds.has(m.discordUserId));
    if (collides) {
      shadowed.push(m.humanId);
      continue;
    }
    humans.push({
      id: m.humanId,
      displayName: m.displayName,
      ...(m.discordUserId ? { discordUserId: m.discordUserId } : {}),
      roles: m.roles,
    });
    agents.push({ id: m.agentId, owner: m.humanId, skills: m.skills, nkey: m.nkey });
  }
  return { config: { ...config, humans, agents }, shadowed };
}
