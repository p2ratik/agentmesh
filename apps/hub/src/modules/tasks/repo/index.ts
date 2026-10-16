import type { Db } from '../../../db/database';
import { DependenciesRepo } from './dependencies.repo';
import { HistoryRepo } from './history.repo';
import { ReviewsRepo } from './reviews.repo';
import { TasksRepo } from './tasks.repo';

export type { NewTask, TaskListFilter, TaskPatch, TaskRecord } from './tasks.repo';

/** Every table the task module owns. */
export interface TaskRepos {
  tasks: TasksRepo;
  dependencies: DependenciesRepo;
  reviews: ReviewsRepo;
  history: HistoryRepo;
}

export function createTaskRepos(db: Db): TaskRepos {
  return {
    tasks: new TasksRepo(db),
    dependencies: new DependenciesRepo(db),
    reviews: new ReviewsRepo(db),
    history: new HistoryRepo(db),
  };
}
