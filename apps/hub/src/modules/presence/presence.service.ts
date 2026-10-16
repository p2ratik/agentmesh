import { MeshError } from '@agentmesh/common';
import type { ParticipantKind, PeerInfo, PresenceStatus } from '@agentmesh/protocol';
import type { HubContext } from '../../context';
import type { PresenceService } from '../../contracts';
import { type DeclaredStatus, ParticipantsRepo, type PresenceFields } from './participants.repo';
import {
  configuredParticipants,
  hubDisplayName,
  isVisibleChange,
  presenceStatus,
  toPeerInfo,
} from './peer';

/**
 * Who is online, what they declared, and their current load. Feed events fire
 * only on visible changes (on/offline, declared status or note), never on
 * plain heartbeats. Services are tracked but not announced.
 */
export class PresenceServiceImpl implements PresenceService {
  readonly #ctx: HubContext;
  readonly #repo: ParticipantsRepo;
  #load: () => Map<string, number> = () => new Map();

  constructor(ctx: HubContext) {
    this.#ctx = ctx;
    this.#repo = new ParticipantsRepo(ctx.db);
  }

  /** Upserts identities from config (and the hub itself); rows that left the config are hidden. */
  syncFromConfig(): void {
    const { index, loaded } = this.#ctx;
    const hub = { id: loaded.config.hub.serviceId, displayName: hubDisplayName(loaded.config) };
    this.#repo.sync(configuredParticipants(index, hub));
  }

  touch(participantId: string, info: { repo?: string; branch?: string } = {}): void {
    const now = this.#ctx.clock.now().toISOString();
    this.#change(participantId, (row) => ({
      ...row,
      online: 1,
      last_seen: now,
      repo: info.repo ?? row.repo,
      branch: info.branch ?? row.branch,
    }));
  }

  setDeclared(participantId: string, status: DeclaredStatus, note: string | null): void {
    this.#change(participantId, (row) => ({ ...row, declared_status: status, status_note: note }));
  }

  markOffline(participantId: string): void {
    this.#change(participantId, (row) => ({ ...row, online: 0 }));
  }

  isOnline(participantId: string): boolean {
    return this.#repo.get(participantId)?.online === 1;
  }

  status(participantId: string): PresenceStatus {
    const row = this.#repo.get(participantId);
    return row ? presenceStatus(row) : 'offline';
  }

  peer(participantId: string): PeerInfo {
    const row = this.#repo.get(participantId);
    if (!row) throw new MeshError('not_found', `Participant ${participantId} not found`);
    return toPeerInfo(row, this.#ctx.index, this.#load().get(participantId) ?? 0);
  }

  /** `all` means the team (agents and humans); pass `service` for services. */
  peers(kind: ParticipantKind | 'all' = 'all'): PeerInfo[] {
    const load = this.#load();
    const rows =
      kind === 'all'
        ? this.#repo.list(null).filter((r) => r.kind !== 'service')
        : this.#repo.list(kind);
    return rows.map((row) => toPeerInfo(row, this.#ctx.index, load.get(row.id) ?? 0));
  }

  lastAssignedAt(participantId: string): string | null {
    return this.#repo.get(participantId)?.last_assigned_at ?? null;
  }

  markAssigned(participantId: string, at: Date): void {
    this.#repo.setLastAssigned(participantId, at.toISOString());
  }

  setLoadReader(reader: () => Map<string, number>): void {
    this.#load = reader;
  }

  /** Tick: participants silent for longer than `presence.offlineAfterSeconds` go offline. */
  expireStale(now: Date): number {
    const cutoffMs = now.getTime() - this.#ctx.loaded.config.presence.offlineAfterSeconds * 1000;
    const stale = this.#repo.stale(new Date(cutoffMs).toISOString());
    for (const id of stale) this.markOffline(id);
    return stale.length;
  }

  #change(participantId: string, next: (row: PresenceFields) => PresenceFields): void {
    const { db, outbox } = this.#ctx;
    const changed = db.transaction(() => {
      const row = this.#repo.get(participantId);
      if (!row) return false;
      const updated = next(row);
      this.#repo.update(participantId, updated);
      if (!isVisibleChange(row, updated) || row.kind === 'service') return false;
      outbox.enqueueEvent('presence.changed', { peer: this.peer(participantId) });
      return true;
    });
    if (changed) outbox.kick();
  }
}
