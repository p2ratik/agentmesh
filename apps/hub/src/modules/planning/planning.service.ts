import { addMs, MeshError, MINUTE_MS, redactSecrets } from '@agentmesh/common';
import type {
  Plan,
  PlanContribution,
  PlanState,
  PlanTaskDraft,
  RpcParams,
} from '@agentmesh/protocol';
import type { HubContext } from '../../context';
import type { Actor, PlanningService } from '../../contracts';
import { planKey } from '../../core/ids';
import { checkDrafts } from './drafts';
import { PlanFlow, type PlanningDeps } from './flow';
import { toPlan } from './mappers';
import { type PlanRecord, PlansRepo } from './plans.repo';
import { approvalText, cancelledText, inviteText } from './prompts';
import { roundComplete } from './rounds';

const ACTIVE: readonly PlanState[] = ['collecting', 'synthesizing', 'awaiting_approval'];
const CANCELLABLE: readonly PlanState[] = [...ACTIVE, 'stalled'];

/** Team planning sessions: propose → discuss → synthesize → tasks. */
export class PlanningServiceImpl implements PlanningService {
  readonly repo: PlansRepo;
  readonly #ctx: HubContext;
  readonly #deps: PlanningDeps;
  readonly #flow: PlanFlow;

  constructor(ctx: HubContext, deps: PlanningDeps) {
    this.#ctx = ctx;
    this.#deps = deps;
    this.repo = new PlansRepo(ctx.db);
    this.#flow = new PlanFlow(ctx, deps, this.repo);
  }

  get(planId: number): Plan {
    return toPlan(this.repo.require(planId));
  }

  activeCount(): number {
    return this.repo.countIn(ACTIVE);
  }

  contributions(planId: number): PlanContribution[] {
    this.repo.require(planId);
    return this.repo.contributions(planId);
  }

  list(states: readonly PlanState[] | null, limit: number): Plan[] {
    return this.repo.list(states, limit).map(toPlan);
  }

  start(params: RpcParams<'plan.start'>, actor: Actor): Plan {
    const { index, clock, db, outbox, loaded } = this.#ctx;
    const config = loaded.config.planning;
    const template = index.planningTemplate(params.template ?? config.defaultTemplate);
    if (!template)
      throw new MeshError('invalid_request', `Unknown planning template "${params.template}"`);
    const participants = this.#participants(params.participants);
    const facilitator = this.#facilitator(params.facilitator, actor, participants);
    if (!participants.includes(facilitator)) participants.push(facilitator);
    const rounds = template.rounds.map((r) => ({
      ...r,
      minutes: params.roundMinutes ?? r.minutes,
    }));
    const first = rounds[0];
    if (!first) throw new MeshError('invalid_request', `Template "${template.id}" has no rounds`);

    const id = db.transaction(() => {
      const { messaging } = this.#deps;
      const now = clock.now();
      const thread = messaging.createThread({
        kind: 'planning',
        // Redacted before it is cut: a cut token no longer matches.
        subject: `Plan: ${redactSecrets(params.topic)}`.slice(0, 80),
        createdBy: actor.id,
        participants: actor.kind === 'human' ? [...participants, actor.id] : participants,
      });
      const planId = this.repo.insert({
        topic: params.topic.trim(),
        state: 'collecting',
        template: template.id,
        initiator: actor.id,
        facilitator,
        participants,
        threadId: thread.id,
        rounds,
        roundIndex: 0,
        deadline: addMs(now, first.minutes * MINUTE_MS).toISOString(),
        requireApproval: config.requireApproval,
        facilitatorHandoffs: 0,
        createdAt: now.toISOString(),
      });
      messaging.linkThread(thread.id, { planId });
      const plan = this.repo.require(planId);
      outbox.enqueueEvent('plan.started', { plan: toPlan(plan) });
      this.#flow.post(plan, participants, inviteText(plan, first, this.#flow.name, now), {
        round: first.id,
      });
      return planId;
    });
    outbox.kick();
    return this.get(id);
  }

  contribute(
    planId: number,
    body: string,
    actor: Actor,
  ): { round: string; roundComplete: boolean } {
    const result = this.#ctx.db.transaction(() => {
      const plan = this.repo.require(planId);
      if (plan.state !== 'collecting') {
        throw new MeshError(
          'invalid_transition',
          `${planKey(planId)} is ${plan.state}; contributions are closed`,
        );
      }
      if (actor.kind !== 'human' && !plan.participants.includes(actor.id)) {
        throw new MeshError('forbidden', `You are not a participant of ${planKey(planId)}`);
      }
      const round = plan.rounds[plan.roundIndex]?.id ?? 'unknown';
      const createdAt = this.#ctx.clock.now().toISOString();
      this.repo.addContribution(planId, { round, participant: actor.id, body, createdAt });
      this.#deps.messaging.post({
        threadId: plan.threadId,
        senderId: actor.id,
        kind: 'plan',
        body,
        to: [],
        system: true,
        refs: { round },
      });
      const complete = roundComplete({
        participants: plan.participants,
        online: new Set(plan.participants.filter((p) => this.#deps.presence.isOnline(p))),
        contributed: new Set(this.repo.contributions(planId, round).map((c) => c.participant)),
        quorum: this.#ctx.loaded.config.planning.quorum,
      });
      if (complete) this.#flow.advance(planId);
      return { round, roundComplete: complete };
    });
    this.#ctx.outbox.kick();
    return result;
  }

  submit(planId: number, summary: string, tasks: readonly PlanTaskDraft[], actor: Actor): Plan {
    const { index } = this.#ctx;
    this.#mutate(planId, (plan) => {
      if (plan.state !== 'collecting' && plan.state !== 'synthesizing') {
        throw new MeshError('invalid_transition', `${planKey(planId)} is ${plan.state}`);
      }
      if (actor.id !== plan.facilitator && actor.kind !== 'human') {
        throw new MeshError(
          'forbidden',
          `Only the facilitator (${plan.facilitator}) submits the plan`,
        );
      }
      // Draft titles become task titles, which the thread subject and branch name cut: redact
      // them here, where they come in (a cut token no longer matches).
      const drafts = tasks.map((draft) => ({ ...draft, title: redactSecrets(draft.title) }));
      const check = checkDrafts(drafts, {
        isAgent: (id) => index.kindOf(id) === 'agent',
        isArea: (id) => index.area(id) !== undefined,
      });
      if (check.issues.length > 0) {
        throw new MeshError(
          'invalid_request',
          `The plan has problems: ${check.issues.join('; ')}`,
          {
            issues: check.issues,
          },
        );
      }
      const at = this.#ctx.clock.now().toISOString();
      this.repo.update(planId, { summary, drafts: check.ordered }, at);
      if (!plan.requireApproval) {
        this.#flow.materialize(planId);
        return;
      }
      this.repo.update(planId, { state: 'awaiting_approval', deadline: null }, at);
      const updated = this.repo.require(planId);
      const humans = index.kindOf(plan.initiator) === 'human' ? [plan.initiator] : [];
      this.#flow.post(
        updated,
        [...humans, plan.facilitator].filter((id) => id !== actor.id),
        approvalText(updated),
      );
      this.#flow.emit(updated, plan.state, null);
    });
    return this.get(planId);
  }

  approve(planId: number): Plan {
    this.#mutate(planId, (plan) => {
      if (plan.state !== 'awaiting_approval') {
        throw new MeshError(
          'invalid_transition',
          `${planKey(planId)} is ${plan.state}, not awaiting approval`,
        );
      }
      this.#flow.materialize(planId);
    });
    return this.get(planId);
  }

  cancel(planId: number, reason: string | null, actor: Actor): Plan {
    this.#mutate(planId, (plan) => {
      if (!CANCELLABLE.includes(plan.state)) {
        throw new MeshError('invalid_transition', `${planKey(planId)} is already ${plan.state}`);
      }
      if (actor.kind !== 'human' && actor.id !== plan.initiator && actor.id !== plan.facilitator) {
        throw new MeshError(
          'forbidden',
          'Only the initiator, the facilitator or a human can cancel a plan',
        );
      }
      this.repo.update(
        planId,
        { state: 'cancelled', deadline: null },
        this.#ctx.clock.now().toISOString(),
      );
      const updated = this.repo.require(planId);
      const to = updated.participants.filter((p) => p !== actor.id);
      this.#flow.post(updated, to, cancelledText(updated, this.#flow.name(actor.id), reason));
      this.#flow.emit(updated, plan.state, null);
    });
    return this.get(planId);
  }

  /** Scheduler tick: rounds and syntheses past their deadline. */
  tick(now: Date): void {
    for (const plan of this.repo.due(now.toISOString())) {
      this.#mutate(plan.id, (current) => this.#flow.overdue(current));
    }
  }

  #mutate(planId: number, fn: (plan: PlanRecord) => void): void {
    this.#ctx.db.transaction(() => fn(this.repo.require(planId)));
    this.#ctx.outbox.kick();
  }

  #participants(requested: readonly string[] | undefined): string[] {
    const { index } = this.#ctx;
    if (!requested || requested.length === 0) return index.agents().map((a) => a.id);
    const unknown = requested.filter((id) => index.kindOf(id) !== 'agent');
    if (unknown.length > 0)
      throw new MeshError('invalid_request', `Not agents: ${unknown.join(', ')}`);
    return [...new Set(requested)];
  }

  #facilitator(
    requested: string | undefined,
    actor: Actor,
    participants: readonly string[],
  ): string {
    const { index, loaded } = this.#ctx;
    const choice = requested ?? loaded.config.planning.facilitator;
    if (choice !== 'initiator') {
      if (index.kindOf(choice) !== 'agent')
        throw new MeshError('invalid_request', `"${choice}" is not an agent`);
      return choice;
    }
    if (actor.kind === 'agent') return actor.id;
    const own = index.primaryAgentOf(actor.id)?.id ?? participants[0];
    if (!own) throw new MeshError('invalid_request', 'No agent can facilitate this plan');
    return own;
  }
}
