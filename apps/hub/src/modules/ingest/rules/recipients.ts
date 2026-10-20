import type { ConfigIndex } from '@agentmesh/config';

/**
 * Who an `area-owners` notice goes to: the area's owners on the team. While
 * they have not joined yet (pending invitees), agents sharing one of the
 * area's skills, else whoever is online, so the notice still reaches someone
 * the way task routing degrades. `pending` lists the owners still missing.
 */
export function areaRecipients(
  index: ConfigIndex,
  areaId: string,
  isOnline: (agentId: string) => boolean,
): { recipients: string[]; pending: string[] } {
  const area = index.area(areaId);
  if (!area) return { recipients: [], pending: [] };
  if (area.owners.length > 0) return { recipients: area.owners, pending: [] };
  const declared = index.config.areas.find((a) => a.id === areaId)?.owners ?? [];
  const skills = new Set(area.skills);
  const agents = index.agents();
  const skilled = agents.filter((a) => a.skills.some((s) => skills.has(s))).map((a) => a.id);
  const recipients = skilled.length > 0 ? skilled : agents.map((a) => a.id).filter(isOnline);
  return { recipients, pending: declared };
}
