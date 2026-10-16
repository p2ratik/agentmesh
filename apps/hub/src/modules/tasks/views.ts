import { MeshError } from '@agentmesh/common';
import type { ConfigIndex, WorkflowConfig, WorkflowRole } from '@agentmesh/config';
import type { Task, TaskDetail } from '@agentmesh/protocol';
import type { HubContext } from '../../context';
import type { Actor } from '../../contracts';
import { taskKey } from '../../core/ids';
import { toTask } from './mappers';
import type { TaskRecord, TaskRepos } from './repo';
import { availableActions, isTerminalState } from './workflow/engine';
import { rolesFor } from './workflow/roles';

/**
 * Read-side helpers shared by the service, transitions and effects: workflow
 * lookups, terminal checks, roles, load and protocol views. Reads the config
 * index on every call so a config reload is picked up.
 */
export class TaskViews {
  readonly #ctx: HubContext;
  readonly #repos: TaskRepos;

  constructor(ctx: HubContext, repos: TaskRepos) {
    this.#ctx = ctx;
    this.#repos = repos;
  }

  get index(): ConfigIndex {
    return this.#ctx.index;
  }

  workflowOf(task: Pick<TaskRecord, 'workflow'>): WorkflowConfig | undefined {
    return this.#ctx.index.workflow(task.workflow);
  }

  requireWorkflow(task: Pick<TaskRecord, 'id' | 'workflow'>): WorkflowConfig {
    const workflow = this.workflowOf(task);
    if (!workflow) {
      throw new MeshError(
        'conflict',
        `${taskKey(task.id)} uses workflow "${task.workflow}", which is no longer configured`,
      );
    }
    return workflow;
  }

  isTerminal(task: Pick<TaskRecord, 'workflow' | 'state'>): boolean {
    const workflow = this.workflowOf(task);
    return workflow ? isTerminalState(workflow, task.state) : false;
  }

  /** `workflow:state` keys of every terminal state, for SQL filters. */
  terminalStates(): string[] {
    return this.#ctx.index.config.workflows.flatMap((w) =>
      Object.entries(w.states)
        .filter(([, s]) => s.terminal)
        .map(([state]) => `${w.id}:${state}`),
    );
  }

  /** Non-terminal tasks per assignee. */
  activeLoad(): Map<string, number> {
    return this.#repos.tasks.loadByAssignee(this.terminalStates());
  }

  currentReviewers(task: Pick<TaskRecord, 'id' | 'reviewRound'>): string[] {
    return this.#repos.reviews.reviewers(task.id, task.reviewRound);
  }

  rolesOf(actor: Actor, task: TaskRecord): Set<WorkflowRole> {
    return rolesFor(actor, task, this.currentReviewers(task));
  }

  /** Roles a participant would hold if they acted (used to render their next actions). */
  rolesOfParticipant(participantId: string, task: TaskRecord): Set<WorkflowRole> {
    const kind = this.#ctx.index.kindOf(participantId) ?? 'agent';
    return this.rolesOf({ id: participantId, kind, roles: [] }, task);
  }

  /** Dependencies of a task with their states. */
  dependencies(taskId: number): Array<{ record: TaskRecord; done: boolean }> {
    return this.#repos.dependencies.dependsOn(taskId).map((id) => {
      const record = this.#repos.tasks.require(id);
      return { record, done: this.isTerminal(record) };
    });
  }

  dependenciesDone(taskId: number): boolean {
    return this.dependencies(taskId).every((d) => d.done);
  }

  task(record: TaskRecord): Task {
    return toTask(record, {
      terminal: this.isTerminal(record),
      reviewers: this.currentReviewers(record),
      dependsOn: this.#repos.dependencies.dependsOn(record.id),
    });
  }

  detail(record: TaskRecord, actor: Actor): TaskDetail {
    const workflow = this.workflowOf(record);
    return {
      ...this.task(record),
      history: this.#repos.history.list(record.id),
      reviews: this.#repos.reviews.list(record.id),
      availableActions: workflow
        ? availableActions(workflow, record.state, this.rolesOf(actor, record))
        : [],
    };
  }
}
