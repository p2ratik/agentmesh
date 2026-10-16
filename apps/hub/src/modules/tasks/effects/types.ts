import type { WorkflowConfig } from '@agentmesh/config';
import type { HubContext } from '../../../context';
import type { Actor, PostInput, TaskActInput } from '../../../contracts';
import type { Operation } from '../operation';
import type { TaskRecord, TaskRepos } from '../repo';
import type { TaskModuleDeps } from '../types';
import type { TaskViews } from '../views';

/** What an effect may use. One env exists per transition. */
export interface EffectEnv {
  ctx: HubContext;
  deps: TaskModuleDeps;
  repos: TaskRepos;
  views: TaskViews;
  op: Operation;
  /** The hub's own actor. */
  system: Actor;
  /**
   * Queues a message. Always pass explicit `to`: recipients inside this task's
   * thread are left out of the transition's summary message.
   */
  post(input: PostInput): void;
  /**
   * Applies a hub-initiated transition (nested, in the same transaction, depth
   * guarded). Returns false when the workflow does not allow it right now.
   */
  applySystem(taskId: number, action: string, input: TaskActInput): boolean;
}

/** The situation an effect runs in. `task` is re-read before every effect. */
export interface EffectRun {
  task: TaskRecord;
  workflow: WorkflowConfig;
  actor: Actor;
  /** Null when a state is entered without a transition (task creation). */
  action: string | null;
  from: string | null;
  note: string | null;
  /** Parameters from the effect reference in config (`{ post_notice: { … } }`). */
  params: Record<string, unknown>;
}

/** A built-in workflow effect. Synchronous: it only touches the database and the operation queue. */
export type Effect = (env: EffectEnv, run: EffectRun) => void;
