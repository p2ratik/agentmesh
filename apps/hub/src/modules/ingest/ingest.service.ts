import { addMs, MINUTE_MS } from '@agentmesh/common';
import type { RuleConfig } from '@agentmesh/config';
import type { IngestEvent, StoredIngestEvent } from '@agentmesh/protocol';
import type { HubContext } from '../../context';
import type { IngestService } from '../../contracts';
import { IngestRepo } from './events.repo';
import { eventId } from './http/normalize';
import { type ActionDeps, runAction } from './rules/actions';
import { type RuleContext, ruleMatches } from './rules/match';
import { renderTemplate } from './rules/template';

/**
 * Stores external events once (dedup by id), runs the configured rules in
 * order and publishes `external.received`. A failing action is logged and
 * rolled back on its own; the other actions and rules still run.
 */
export class IngestServiceImpl implements IngestService {
  readonly #ctx: HubContext;
  readonly #repo: IngestRepo;
  readonly #actions: ActionDeps;

  constructor(ctx: HubContext, actions: Omit<ActionDeps, 'ctx'>) {
    this.#ctx = ctx;
    this.#repo = new IngestRepo(ctx.db);
    this.#actions = { ctx, ...actions };
  }

  async accept(source: string, event: IngestEvent): Promise<{ id: string; duplicate: boolean }> {
    const { db, clock, outbox } = this.#ctx;
    const id = eventId(source, event.id, JSON.stringify(event));
    const stored: StoredIngestEvent = {
      ...event,
      id,
      source,
      receivedAt: clock.now().toISOString(),
    };
    const duplicate = db.transaction(() => {
      if (!this.#repo.insert(stored)) return true;
      const matched = this.#evaluate(toContext(stored));
      this.#repo.setMatchedRules(id, matched);
      outbox.enqueueEvent('external.received', { event: stored, matchedRules: matched });
      return false;
    });
    outbox.kick();
    return { id, duplicate };
  }

  #evaluate(event: RuleContext): string[] {
    const fired: string[] = [];
    for (const rule of this.#ctx.index.config.rules) {
      if (!rule.enabled || !ruleMatches(rule.match, event)) continue;
      if (!this.#claimThrottle(rule, event)) {
        this.#ctx.logger.info({ rule: rule.id, event: event.id }, 'rule throttled');
        continue;
      }
      fired.push(rule.id);
      for (const action of rule.actions) this.#run(rule, action, event);
      if (rule.stop) break;
    }
    return fired;
  }

  #run(rule: RuleConfig, action: RuleConfig['actions'][number], event: RuleContext): void {
    try {
      this.#ctx.db.transaction(() => runAction(this.#actions, action, event));
    } catch (err) {
      this.#ctx.logger.warn({ err, rule: rule.id, event: event.id }, 'rule action failed');
    }
  }

  #claimThrottle(rule: RuleConfig, event: RuleContext): boolean {
    if (!rule.throttle) return true;
    const now = this.#ctx.clock.now();
    const key = renderTemplate(rule.throttle.key, event);
    const until = addMs(now, rule.throttle.windowMinutes * MINUTE_MS).toISOString();
    return this.#repo.claimThrottle(rule.id, key, now.toISOString(), until);
  }
}

function toContext(event: StoredIngestEvent): RuleContext {
  return {
    id: event.id,
    source: event.source,
    type: event.type,
    severity: event.severity,
    summary: event.summary ?? null,
    url: event.url ?? null,
    occurredAt: event.occurredAt ?? null,
    payload: event.payload,
  };
}
