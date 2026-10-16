import { MeshError } from '@agentmesh/common';
import type { EffectRef, WorkflowConfig, WorkflowTransition } from '@agentmesh/config';
import type { HubContext } from '../../context';
import type { Actor, PostInput, TaskActInput } from '../../contracts';
import { systemActor } from '../../rpc/actor';
import { effectNamed } from './effects/registry';
import type { EffectEnv } from './effects/types';
import { NotifyScope, type Operation } from './operation';
import type { TaskRecord, TaskRepos } from './repo';
import { transitionText } from './text';
import type { TaskModuleDeps } from './types';
import type { TaskViews } from './views';
import { checkAction } from './workflow/check';
import { ASSIGNING_ACTIONS, conventionPatch } from './workflow/conventions';
import { isSystemActor } from './workflow/roles';

/** Effects may trigger transitions that trigger effects; this bounds a misconfigured cycle. */
const MAX_DEPTH = 5;

interface EffectBase {
  actor: Actor;
  action: string | null;
  from: string | null;
  note: string | null;
}

/**
 * Applies workflow transitions: checks, convention field changes, history,
 * the `task.changed` feed event, one summary message for the task thread
 * (skipping anyone an effect already messaged), then the transition's effects
 * and the target state's `onEnter` effects. Everything runs inside the
 * caller's transaction; messages go through the operation queue.
 */
export class TransitionRunner {
  readonly system: Actor;
  readonly #ctx: HubContext;
  readonly #deps: TaskModuleDeps;
  readonly #repos: TaskRepos;
  readonly #views: TaskViews;
  #depth = 0;

  constructor(ctx: HubContext, deps: TaskModuleDeps, repos: TaskRepos, views: TaskViews) {
    this.#ctx = ctx;
    this.#deps = deps;
    this.#repos = repos;
    this.#views = views;
    this.system = systemActor(deps.messaging.hubId);
  }

  /** A caller's action. Throws the check's MeshError when it is not allowed. */
  apply(
    op: Operation,
    taskId: number,
    action: string,
    input: TaskActInput,
    actor: Actor,
  ): TaskRecord {
    const task = this.#repos.tasks.require(taskId);
    const workflow = this.#views.requireWorkflow(task);
    const check = checkAction({
      workflow,
      task,
      action,
      input,
      actor,
      roles: this.#views.rolesOf(actor, task),
      isAgent: (id) => this.#ctx.index.kindOf(id) === 'agent',
    });
    if ('error' in check) throw check.error;
    return this.#commit(op, task, workflow, check.transition, action, input, actor);
  }

  /** A hub-initiated action. Returns false (and changes nothing) when the workflow forbids it now. */
  trySystem(op: Operation, taskId: number, action: string, input: TaskActInput): boolean {
    const task = this.#repos.tasks.require(taskId);
    const workflow = this.#views.workflowOf(task);
    if (!workflow) return false;
    const check = checkAction({
      workflow,
      task,
      action,
      input,
      actor: this.system,
      roles: this.#views.rolesOf(this.system, task),
      isAgent: (id) => this.#ctx.index.kindOf(id) === 'agent',
    });
    if ('error' in check) return false;
    this.#commit(op, task, workflow, check.transition, action, input, this.system);
    return true;
  }

  /** Runs the current state's `onEnter` effects without a transition (task creation). */
  enterState(op: Operation, taskId: number, actor: Actor): void {
    const task = this.#repos.tasks.require(taskId);
    const workflow = this.#views.requireWorkflow(task);
    const scope = new NotifyScope(task.threadId);
    const refs = workflow.states[task.state]?.onEnter ?? [];
    this.#runEffects(op, refs, taskId, scope, { actor, action: null, from: null, note: null });
  }

  #commit(
    op: Operation,
    task: TaskRecord,
    workflow: WorkflowConfig,
    transition: WorkflowTransition,
    action: string,
    input: TaskActInput,
    actor: Actor,
  ): TaskRecord {
    if (this.#depth >= MAX_DEPTH) {
      throw new MeshError(
        'conflict',
        `Workflow "${workflow.id}" chained more than ${MAX_DEPTH} automatic transitions; check its effects for a cycle`,
      );
    }
    this.#depth += 1;
    try {
      const { clock, outbox } = this.#ctx;
      const at = clock.now().toISOString();
      const from = task.state;
      const note = input.note?.trim() || null;
      this.#repos.tasks.update(
        task.id,
        { ...conventionPatch(action, actor, input, task), state: transition.to },
        at,
      );
      this.#repos.history.add(task.id, {
        at,
        actor: actor.id,
        action,
        from,
        to: transition.to,
        note,
      });
      const updated = this.#repos.tasks.require(task.id);
      if (updated.assignee && ASSIGNING_ACTIONS.has(action)) {
        this.#deps.messaging.addParticipants(updated.threadId, [updated.assignee]);
      }
      outbox.enqueueEvent('task.changed', {
        task: this.#views.task(updated),
        action,
        from,
        to: transition.to,
        actor: actor.id,
        note,
      });
      const scope = new NotifyScope(updated.threadId);
      op.post(() => this.#summary(updated, action, from, actor, note, scope));
      const refs = [...transition.effects, ...(workflow.states[transition.to]?.onEnter ?? [])];
      this.#runEffects(op, refs, task.id, scope, { actor, action, from, note });
      return this.#repos.tasks.require(task.id);
    } finally {
      this.#depth -= 1;
    }
  }

  /** Evaluated when the operation flushes, so it knows everyone the effects messaged. */
  #summary(
    task: TaskRecord,
    action: string,
    from: string,
    actor: Actor,
    note: string | null,
    scope: NotifyScope,
  ): PostInput {
    const { messaging } = this.#deps;
    const sender = isSystemActor(actor) || actor.kind === 'service' ? messaging.hubId : actor.id;
    const to = messaging
      .participants(task.threadId)
      .filter((id) => id !== actor.id && id !== messaging.hubId && !scope.notified.has(id));
    return {
      threadId: task.threadId,
      senderId: sender,
      kind: 'task',
      body: transitionText({
        task,
        action,
        from,
        to: task.state,
        actorName: this.#ctx.index.displayName(actor.id),
        note,
      }),
      to,
      system: true,
      refs: { action, ...(task.prUrl ? { prUrl: task.prUrl } : {}) },
    };
  }

  #runEffects(
    op: Operation,
    refs: readonly EffectRef[],
    taskId: number,
    scope: NotifyScope,
    base: EffectBase,
  ): void {
    const env = this.#env(op, scope);
    for (const ref of refs) {
      const effect = effectNamed(ref.name);
      if (!effect) {
        this.#ctx.logger.warn({ effect: ref.name }, 'unknown workflow effect skipped');
        continue;
      }
      const task = this.#repos.tasks.require(taskId);
      const workflow = this.#views.workflowOf(task);
      if (!workflow) return;
      effect(env, { ...base, task, workflow, params: ref.params });
    }
  }

  #env(op: Operation, scope: NotifyScope): EffectEnv {
    return {
      ctx: this.#ctx,
      deps: this.#deps,
      repos: this.#repos,
      views: this.#views,
      op,
      system: this.system,
      post: (input) => {
        const full: PostInput = { ...input, system: true };
        scope.record(full);
        op.post(full);
      },
      applySystem: (taskId, action, input) => this.trySystem(op, taskId, action, input),
    };
  }
}
