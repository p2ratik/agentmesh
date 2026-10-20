import { addMs, MINUTE_MS } from '@agentmesh/common';
import { STANDARD_PLANNING_TEMPLATE } from '@agentmesh/config';
import type { MessageKind, PlanState, ReplyStatus } from '@agentmesh/protocol';
import type { HubContext } from '../../context';
import type { Actor, MessagingService, PresenceService, TaskService } from '../../contracts';
import { internalId, planKey } from '../../core/ids';
import { systemActor } from '../../rpc/actor';
import { toPlan } from './mappers';
import type { PlanRecord, PlansRepo } from './plans.repo';
import {
  handoffText,
  materializedText,
  nextRoundText,
  stalledText,
  synthesisText,
  synthesizingNotice,
} from './prompts';
import { compileContributions, pickNewFacilitator } from './rounds';

export interface PlanningDeps {
  messaging: MessagingService;
  tasks: TaskService;
  presence: PresenceService;
}

interface PostOptions {
  kind?: MessageKind;
  status?: ReplyStatus;
  round?: string;
}

/**
 * How a session moves on: next round, synthesis, facilitator hand-off, stall,
 * and turning drafts into tasks. Every method runs inside the caller's
 * transaction and leaves the plan in a consistent state.
 */
export class PlanFlow {
  readonly #ctx: HubContext;
  readonly #deps: PlanningDeps;
  readonly #repo: PlansRepo;

  constructor(ctx: HubContext, deps: PlanningDeps, repo: PlansRepo) {
    this.#ctx = ctx;
    this.#deps = deps;
    this.#repo = repo;
  }

  name = (participantId: string): string => this.#ctx.index.displayName(participantId);

  /** Ends the current round: opens the next one, or hands the session to the facilitator. */
  advance(planId: number): void {
    const plan = this.#repo.require(planId);
    if (plan.state !== 'collecting') return;
    const compiled = this.#compiled(plan);
    const nextIndex = plan.roundIndex + 1;
    const next = plan.rounds[nextIndex];
    if (!next) {
      this.#beginSynthesis(plan, compiled);
      return;
    }
    const now = this.#ctx.clock.now();
    this.#update(plan, { roundIndex: nextIndex, deadline: this.#deadline(next.minutes) });
    const updated = this.#repo.require(planId);
    this.post(updated, updated.participants, nextRoundText(updated, next, compiled, now), {
      round: next.id,
    });
    this.emit(updated, 'collecting', next.id);
  }

  /** The deadline passed (tick): advance a round, or deal with a late synthesis. */
  overdue(plan: PlanRecord): void {
    if (plan.state === 'collecting') {
      this.advance(plan.id);
      return;
    }
    if (plan.state !== 'synthesizing') return;
    const { presence } = this.#deps;
    const online = new Set(plan.participants.filter((p) => presence.isOnline(p)));
    const next =
      plan.facilitatorHandoffs === 0
        ? pickNewFacilitator(
            plan.participants,
            plan.facilitator,
            online,
            this.#repo.contributions(plan.id),
          )
        : null;
    if (next) this.#handOff(plan, next);
    else this.#stall(plan);
  }

  /**
   * Creates the drafted tasks in dependency order and closes the session.
   * Anyone who left the team since the synthesis is replaced: the hub creates
   * the tasks, and their drafts are routed like unassigned ones.
   */
  materialize(planId: number): void {
    const plan = this.#repo.require(planId);
    const onTeam = (id: string | undefined) => !!id && this.#ctx.index.kindOf(id) === 'agent';
    const facilitator: Actor = onTeam(plan.facilitator)
      ? { id: plan.facilitator, kind: 'agent', roles: [] }
      : systemActor(this.#deps.messaging.hubId);
    const keyToId = new Map<string, number>();
    const created: Array<{
      id: string;
      title: string;
      assignee: string | null;
      dependsOn: string[];
    }> = [];
    for (const draft of plan.drafts) {
      const detail = this.#deps.tasks.create(
        {
          title: draft.title,
          description: `${draft.description}\n\nPart of ${planKey(plan.id)}: ${plan.topic}`.trim(),
          area: draft.area,
          repo: draft.repo,
          assignee: onTeam(draft.assignee) ? draft.assignee : undefined,
          priority: draft.priority ?? 'normal',
          labels: draft.labels ?? [],
          doneWhen: draft.doneWhen,
          dependsOn: (draft.dependsOn ?? []).flatMap((key) => keyToId.get(key) ?? []),
          planId: plan.id,
        },
        facilitator,
      );
      keyToId.set(draft.key, internalId('task', detail.id));
      created.push({
        id: detail.id,
        title: detail.title,
        assignee: detail.assignee,
        dependsOn: detail.dependsOn,
      });
    }
    this.#update(plan, { state: 'materialized', deadline: null, taskIds: [...keyToId.values()] });
    const updated = this.#repo.require(planId);
    this.post(updated, updated.participants, materializedText(updated, created));
    this.emit(updated, plan.state, null);
  }

  /** Posts a hub message into the planning thread. An empty list stores without delivering. */
  post(plan: PlanRecord, to: readonly string[], body: string, options: PostOptions = {}): void {
    const { messaging } = this.#deps;
    messaging.post({
      threadId: plan.threadId,
      senderId: messaging.hubId,
      kind: options.kind ?? 'plan',
      body,
      to: [...to],
      system: true,
      ...(options.status ? { status: options.status } : {}),
      refs: options.round ? { round: options.round } : {},
    });
  }

  emit(plan: PlanRecord, from: PlanState, round: string | null): void {
    const current = this.#repo.require(plan.id);
    this.#ctx.outbox.enqueueEvent('plan.changed', {
      plan: toPlan(current),
      from,
      to: current.state,
      round,
    });
  }

  #beginSynthesis(plan: PlanRecord, compiled: string): void {
    const template = this.#ctx.index.planningTemplate(plan.template) ?? STANDARD_PLANNING_TEMPLATE;
    this.#update(plan, {
      state: 'synthesizing',
      deadline: this.#deadline(template.synthesis.minutes),
    });
    const updated = this.#repo.require(plan.id);
    const now = this.#ctx.clock.now();
    this.post(
      updated,
      [updated.facilitator],
      synthesisText(updated, template.synthesis.prompt, compiled, now),
      {
        round: 'synthesis',
      },
    );
    const others = updated.participants.filter((p) => p !== updated.facilitator);
    if (others.length > 0) this.post(updated, others, synthesizingNotice(updated, now));
    this.emit(updated, 'collecting', 'synthesis');
  }

  #handOff(plan: PlanRecord, next: string): void {
    const template = this.#ctx.index.planningTemplate(plan.template) ?? STANDARD_PLANNING_TEMPLATE;
    this.#update(plan, {
      facilitator: next,
      facilitatorHandoffs: plan.facilitatorHandoffs + 1,
      deadline: this.#deadline(template.synthesis.minutes),
    });
    const updated = this.#repo.require(plan.id);
    const now = this.#ctx.clock.now();
    this.post(
      updated,
      [next],
      synthesisText(updated, template.synthesis.prompt, this.#compiled(updated), now),
      {
        round: 'synthesis',
      },
    );
    this.post(updated, [plan.facilitator], handoffText(updated, plan.facilitator));
    this.emit(updated, 'synthesizing', 'synthesis');
  }

  /** Nobody synthesized: ask the initiator (or the initiating agent's owner) to step in. */
  #stall(plan: PlanRecord): void {
    const { index } = this.#ctx;
    this.#update(plan, { state: 'stalled', deadline: null });
    const updated = this.#repo.require(plan.id);
    const human =
      index.kindOf(plan.initiator) === 'human'
        ? plan.initiator
        : index.agent(plan.initiator)?.owner;
    if (human) {
      this.#deps.messaging.addParticipants(plan.threadId, [human]);
      this.post(updated, [human], stalledText(updated), {
        kind: 'escalation',
        status: 'needs_human',
      });
    }
    this.emit(updated, 'synthesizing', null);
  }

  #compiled(plan: PlanRecord): string {
    return compileContributions(plan.rounds, this.#repo.contributions(plan.id), this.name);
  }

  #deadline(minutes: number): string {
    return addMs(this.#ctx.clock.now(), minutes * MINUTE_MS).toISOString();
  }

  #update(plan: PlanRecord, patch: Parameters<PlansRepo['update']>[1]): void {
    this.#repo.update(plan.id, patch, this.#ctx.clock.now().toISOString());
  }
}
