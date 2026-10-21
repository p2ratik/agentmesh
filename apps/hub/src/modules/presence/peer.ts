import type { ConfigIndex, MeshConfig } from '@agentmesh/config';
import type { PeerInfo, PresenceStatus } from '@agentmesh/protocol';
import type { ConfiguredParticipant, ParticipantRow, PresenceFields } from './participants.repo';

/** How the hub signs its own notices: "<mesh name> hub". */
export function hubDisplayName(config: MeshConfig): string {
  return `${config.mesh.name} hub`;
}

/** Every participant the config defines, plus the hub's own service identity. */
export function configuredParticipants(
  index: ConfigIndex,
  hub: { id: string; displayName: string },
): ConfiguredParticipant[] {
  const { config } = index;
  return [
    ...config.humans.map((h) => ({
      id: h.id,
      kind: 'human' as const,
      displayName: index.displayName(h.id),
      owner: null,
    })),
    ...config.agents.map((a) => ({
      id: a.id,
      kind: 'agent' as const,
      displayName: index.displayName(a.id),
      owner: a.owner,
    })),
    ...config.services.map((s) => ({
      id: s.id,
      kind: 'service' as const,
      displayName: index.displayName(s.id),
      owner: null,
    })),
    { id: hub.id, kind: 'service', displayName: hub.displayName, owner: null },
  ];
}

export function presenceStatus(
  row: Pick<ParticipantRow, 'online' | 'declared_status'>,
): PresenceStatus {
  return row.online === 1 ? row.declared_status : 'offline';
}

/** Feed-worthy changes: going on/offline or a new declared status/note. Heartbeats are not. */
export function isVisibleChange(before: PresenceFields, after: PresenceFields): boolean {
  return (
    before.online !== after.online ||
    before.declared_status !== after.declared_status ||
    before.status_note !== after.status_note
  );
}

export function toPeerInfo(row: ParticipantRow, index: ConfigIndex, activeTasks: number): PeerInfo {
  const agent = row.kind === 'agent' ? index.agent(row.id) : undefined;
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    owner: row.owner,
    status: presenceStatus(row),
    statusNote: row.status_note,
    lastSeen: row.last_seen,
    repo: row.repo,
    branch: row.branch,
    skills: agent?.skills ?? [],
    areas: agent ? index.areasOwnedBy(row.id).map((a) => a.id) : [],
    activeTasks,
    sessions: [],
  };
}
