import { MeshError, redactSecrets } from '@agentmesh/common';
import type { WorkflowConfig } from '@agentmesh/config';
import type { ReviewVerdict, Task, TaskDetail } from '@agentmesh/protocol';
import type { HubContext } from '../../context';
import type { Actor, TaskActInput, TaskCreateInput, TaskService } from '../../contracts';
import { taskKey } from '../../core/ids';
import { reviewSubmittedClass } from './effects/classes';
import { Operation } from './operation';
import { createTaskRepos, type TaskListFilter, type TaskRepos } from './repo';
import { resolveArea } from './routing/area';
import { approversInRound } from './routing/reviewers';
import { createdText, reviewSubmittedText } from './text';
import { TransitionRunner } from './transitions';
import type { TaskModuleDeps } from './types';
import { TaskViews } from './views';
import { findTransition } from './workflow/engine';

interface CreationPlan {
  workflow: WorkflowConfig;
  area: string | null;
  reviewers: string[];
  /** Route the explicit assignee through the workflow's `assign` transition. */
  viaAssign: boolean;
}

/**
 * Task lifecycle: creation, workflow actions, reviews and queries.
 *
 * `notes` is given when the actor made the call itself, over RPC: its own call
 * is then never echoed back to it as a delivery, and what it must still learn
 * is added to `notes` for its result. Modules calling in (planning, ingest) omit it.
 */
export class TaskServiceImpl implements TaskService {
  readonly repos: TaskRepos;
  readonly views: TaskViews;
  readonly #ctx: HubContext;
  readonly #deps: TaskModuleDeps;
  readonly #runner: TransitionRunner;

  constructor(ctx: HubContext, deps: TaskModuleDeps) {
    this.#ctx = ctx;
    this.#deps = deps;
    this.repos = createTaskRepos(ctx.db);
    this.views = new TaskViews(ctx, this.repos);
    this.#runner = new TransitionRunner(ctx, deps, this.repos, this.views);
  }

  create(input: TaskCreateInput, actor: Actor, notes?: string[]): TaskDetail {
    const plan = this.#prepare(input);
    const id = this.#operation(actor, notes, (op) => {
      const taskId = this.#insert(op, input, actor, plan);
      if (plan.viaAssign && input.assignee) {
        this.#runner.trySystem(op, taskId, 'assign', { to: input.assignee });
      } else {
        this.#runner.enterState(op, taskId, actor);
      }
      return taskId;
    });
    return this.get(id, actor);
  }

  /** Validates references before anything is written. */
  #prepare(input: TaskCreateInput): CreationPlan {
    const { index } = this.#ctx;
    const workflowId = input.workflow ?? index.config.tasks.defaultWorkflow;
    const workflow = index.workflow(workflowId);
    if (!workflow) throw new MeshError('invalid_request', `Unknown workflow "${workflowId}"`);
    const area = resolveArea(index, input.area, input.repo);
    if (input.assignee && index.kindOf(input.assignee) !== 'agent') {
      throw new MeshError('invalid_request', `"${input.assignee}" is not a configured agent`);
    }
    for (const dep of input.dependsOn) this.repos.tasks.require(dep);
    return {
      workflow,
      area,
      reviewers: this.#validReviewers(input.reviewers ?? [], input.assignee),
      viaAssign: Boolean(input.assignee && findTransition(workflow, workflow.initial, 'assign')),
    };
  }

  /** Thread, row, links, history, feed event and the creation note — no routing yet. */
  #insert(op: Operation, input: TaskCreateInput, actor: Actor, plan: CreationPlan): number {
    const { index, clock, outbox } = this.#ctx;
    const { messaging } = this.#deps;
    const member = actor.kind === 'agent' || actor.kind === 'human';
    const thread = messaging.createThread({
      kind: 'task',
      subject: input.title,
      createdBy: member ? actor.id : messaging.hubId,
      participants: member ? [actor.id] : [],
      parentThreadId: input.parentThreadId ?? null,
    });
    op.rootThreadId = thread.id;
    const at = clock.now().toISOString();
    const directAssignee = plan.viaAssign ? null : (input.assignee ?? null);
    const taskId = this.repos.tasks.insert({
      title: input.title.trim(),
      description: input.description.trim(),
      workflow: plan.workflow.id,
      state: plan.workflow.initial,
      priority: input.priority,
      labels: input.labels,
      repo: input.repo ?? null,
      area: plan.area,
      baseBranch: input.baseBranch ?? null,
      branch: null,
      prUrl: input.prUrl ?? null,
      doneWhen: input.doneWhen ?? null,
      assignee: directAssignee,
      createdBy: actor.id,
      planId: input.planId ?? null,
      threadId: thread.id,
      reviewRound: 0,
      declinedBy: [],
      trust: input.trust ?? 'team',
      createdAt: at,
    });
    messaging.linkThread(thread.id, { taskId });
    if (directAssignee) messaging.addParticipants(thread.id, [directAssignee]);
    this.repos.dependencies.add(taskId, input.dependsOn);
    if (plan.reviewers.length > 0) this.repos.reviews.addReviewers(taskId, 0, plan.reviewers);
    const to = plan.workflow.initial;
    this.repos.history.add(taskId, {
      at,
      actor: actor.id,
      action: 'create',
      from: null,
      to,
      note: null,
    });
    const record = this.repos.tasks.require(taskId);
    outbox.enqueueEvent('task.created', { task: this.views.task(record) });
    op.post({
      threadId: thread.id,
      senderId: messaging.hubId,
      kind: 'task',
      body: createdText(record, index.displayName(actor.id)),
      to: [],
      system: true,
      trust: record.trust,
      refs: { action: 'create' },
    });
    return taskId;
  }

  act(
    taskId: number,
    action: string,
    input: TaskActInput,
    actor: Actor,
    notes?: string[],
  ): TaskDetail {
    this.#operation(actor, notes, (op) => {
      op.rootThreadId = this.repos.tasks.require(taskId).threadId;
      this.#runner.apply(op, taskId, action, input, actor);
    });
    return this.get(taskId, actor);
  }

  get(taskId: number, actor: Actor): TaskDetail {
    return this.views.detail(this.repos.tasks.require(taskId), actor);
  }

  list(filter: Omit<TaskListFilter, 'excludeStates'> & { includeTerminal: boolean }): Task[] {
    const { includeTerminal, ...rest } = filter;
    const excludeStates = includeTerminal ? [] : this.views.terminalStates();
    return this.repos.tasks.list({ ...rest, excludeStates }).map((t) => this.views.task(t));
  }

  /** Records a verdict; `request_changes` and reaching the approval quorum move the workflow. */
  submitReview(
    taskId: number,
    verdict: ReviewVerdict,
    body: string,
    actor: Actor,
    notes?: string[],
  ): TaskDetail {
    this.#operation(actor, notes, (op) => {
      const task = this.repos.tasks.require(taskId);
      op.rootThreadId = task.threadId;
      const round = task.reviewRound;
      const reviewers = this.views.currentReviewers(task);
      if (round === 0 || this.views.isTerminal(task)) {
        throw new MeshError(
          'invalid_transition',
          `${taskKey(task.id)} is not waiting for a review`,
        );
      }
      if (actor.kind !== 'human' && !reviewers.includes(actor.id)) {
        throw new MeshError(
          'forbidden',
          `You are not a reviewer of ${taskKey(task.id)} (round ${round})`,
        );
      }
      const review = {
        reviewer: actor.id,
        verdict,
        body,
        round,
        createdAt: this.#ctx.clock.now().toISOString(),
      };
      this.repos.reviews.add(task.id, review);
      const { messaging } = this.#deps;
      messaging.addParticipants(task.threadId, [actor.id]);
      op.post({
        threadId: task.threadId,
        senderId: actor.id,
        kind: 'review',
        body: reviewSubmittedText(task, review, this.#ctx.index.displayName(actor.id)),
        system: true,
        refs: { verdict, action: 'review_submitted', ...(task.prUrl ? { prUrl: task.prUrl } : {}) },
        deliveryClass: (id) => reviewSubmittedClass(id, task),
      });
      if (verdict === 'request_changes') {
        // Redacted before it is cut: a cut token no longer matches, and the note reaches Discord.
        const note = firstLine(redactSecrets(body));
        this.#runner.trySystem(op, task.id, 'request_changes', { note });
        return;
      }
      const required = this.#ctx.index.config.review.requiredApprovals;
      const approvers = approversInRound(
        this.repos.reviews.list(task.id, round),
        round,
        task.assignee,
      );
      if (verdict === 'approve' && approvers.length >= required) {
        this.#runner.trySystem(op, task.id, 'approve', {});
      }
    });
    return this.get(taskId, actor);
  }

  activeLoad(): Map<string, number> {
    return this.views.activeLoad();
  }

  openCount(): number {
    return this.repos.tasks.count(this.views.terminalStates());
  }

  locate(taskId: number): { threadId: number; repo: string | null } | null {
    const task = this.repos.tasks.get(taskId);
    return task ? { threadId: task.threadId, repo: task.repo } : null;
  }

  /** One transaction; queued messages are posted in order before it commits. */
  #operation<T>(actor: Actor, notes: string[] | undefined, fn: (op: Operation) => T): T {
    const caller = notes && actor.kind === 'agent' ? actor.id : null;
    const op = new Operation(this.#deps.messaging, caller);
    const result = this.#ctx.db.transaction(() => {
      const value = fn(op);
      op.flush();
      return value;
    });
    this.#ctx.outbox.kick();
    notes?.push(...op.notes);
    return result;
  }

  #validReviewers(ids: readonly string[], assignee: string | undefined): string[] {
    const kinds = new Set(['agent', 'human']);
    for (const id of ids) {
      if (!kinds.has(this.#ctx.index.kindOf(id) ?? '')) {
        throw new MeshError('invalid_request', `"${id}" is not a configured agent or human`);
      }
    }
    return [...new Set(ids)].filter((id) => id !== assignee);
  }
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
