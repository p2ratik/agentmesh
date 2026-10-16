/**
 * Built-in workflow effects. Workflows in configuration reference these by
 * name; the hub implements each one. Adding an effect means adding it here and
 * registering its implementation in the hub's effect registry.
 */
export const BUILTIN_EFFECTS = {
  auto_assign: 'Route an unassigned task to an owner by area, skills and load; else the board.',
  notify_assignee: 'Tell the assignee about the task and its current state.',
  notify_creator: 'Tell whoever created the task about the change.',
  request_reviews: 'Pick reviewers (area owners first, never the assignee) and ask them.',
  release_dependents: 'Route tasks that were waiting on this one.',
  release_leases: "Release the assignee's leases tied to this task.",
  clear_assignee: 'Remove the current assignee.',
  close_thread: "Close the task's conversation thread.",
  post_notice: 'Post a notice to a bridge channel. Params: channel, text (template).',
} as const;

export type BuiltinEffect = keyof typeof BUILTIN_EFFECTS;

export function isBuiltinEffect(name: string): name is BuiltinEffect {
  return Object.hasOwn(BUILTIN_EFFECTS, name);
}
