import type { BuiltinEffect } from '@agentmesh/config';
import { autoAssign } from './assign';
import {
  clearAssignee,
  closeThread,
  postNotice,
  releaseDependents,
  releaseLeases,
} from './lifecycle';
import { notifyAssignee, notifyCreator } from './notify';
import { requestReviews } from './reviews';
import type { Effect } from './types';

/**
 * One implementation per built-in effect name. The `Record` type makes the
 * compiler insist that every effect declared in @agentmesh/config exists here.
 */
export const EFFECTS: Record<BuiltinEffect, Effect> = {
  auto_assign: autoAssign,
  notify_assignee: notifyAssignee,
  notify_creator: notifyCreator,
  request_reviews: requestReviews,
  release_dependents: releaseDependents,
  release_leases: releaseLeases,
  clear_assignee: clearAssignee,
  close_thread: closeThread,
  post_notice: postNotice,
};

export function effectNamed(name: string): Effect | undefined {
  return Object.hasOwn(EFFECTS, name) ? EFFECTS[name as BuiltinEffect] : undefined;
}
