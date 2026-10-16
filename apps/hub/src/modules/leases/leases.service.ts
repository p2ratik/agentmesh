import { addMs, MINUTE_MS } from '@agentmesh/common';
import type { Lease, LeaseConflict } from '@agentmesh/protocol';
import type { HubContext } from '../../context';
import type { LeaseService } from '../../contracts';
import { LeasesRepo } from './leases.repo';
import { normalizePath, pathsOverlap, reposOverlap } from './overlap';

export interface AcquireRequest {
  holder: string;
  paths: readonly string[];
  repo: string | null;
  ttlMinutes: number | null;
  reason: string | null;
  taskId: number | null;
}

/** Advisory path leases. Acquisition is all-or-nothing; your own leases never conflict. */
export class LeaseServiceImpl implements LeaseService {
  readonly #ctx: HubContext;
  readonly #repo: LeasesRepo;

  constructor(ctx: HubContext) {
    this.#ctx = ctx;
    this.#repo = new LeasesRepo(ctx.db);
  }

  acquire(req: AcquireRequest): { granted: Lease[]; conflicts: LeaseConflict[] } {
    const now = this.#ctx.clock.now();
    const paths = [...new Set(req.paths.map(normalizePath).filter(Boolean))];
    const ttl = req.ttlMinutes ?? this.#ctx.index.config.leases.defaultTtlMinutes;
    return this.#ctx.db.transaction(() => {
      const others = this.#repo
        .active(now.toISOString())
        .filter((l) => l.holder !== req.holder && reposOverlap(l.repo, req.repo));
      const conflicts: LeaseConflict[] = [];
      for (const requested of paths) {
        for (const held of others) {
          if (pathsOverlap(requested, held.path)) {
            conflicts.push({
              requested,
              held: held.path,
              holder: held.holder,
              expiresAt: held.expiresAt,
            });
          }
        }
      }
      if (conflicts.length > 0) return { granted: [], conflicts };
      const granted = paths.map((path) =>
        this.#repo.upsert({
          holder: req.holder,
          repo: req.repo,
          path,
          reason: req.reason,
          taskId: req.taskId,
          createdAt: now.toISOString(),
          expiresAt: addMs(now, ttl * MINUTE_MS).toISOString(),
        }),
      );
      return { granted, conflicts: [] };
    });
  }

  release(holder: string, paths: readonly string[] | null): number {
    return this.#repo.release(holder, paths === null ? null : paths.map(normalizePath));
  }

  list(filter: { holder?: string; repo?: string }): Lease[] {
    return this.#repo.active(this.#ctx.clock.now().toISOString(), filter);
  }

  releaseForTask(taskId: number): number {
    return this.#repo.releaseForTask(taskId);
  }

  releaseAll(holder: string): number {
    return this.#repo.release(holder, null);
  }

  purgeExpired(now: Date): number {
    return this.#repo.purgeExpired(now.toISOString());
  }
}
