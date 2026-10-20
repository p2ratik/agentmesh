import type { ConfigIndex } from '@agentmesh/config';
import type { DomainEvent } from '@agentmesh/protocol';
import { renderNotice, renderPaused, renderResumed } from '../render/control';
import { renderExternalReceived } from '../render/external';
import type { PostIntent } from '../render/intents';
import { renderMessageCreated } from '../render/message';
import { renderPlanChanged, renderPlanStarted } from '../render/plan';
import { renderTaskChanged, renderTaskCreated } from '../render/task';

/**
 * Decides what each activity-feed event looks like in Discord. Pure: the same
 * event and config always produce the same posts.
 */
export function routeEvent(event: DomainEvent, index: ConfigIndex): PostIntent[] {
  switch (event.type) {
    case 'message.created':
      return renderMessageCreated(event.data, index);
    case 'task.created':
      return renderTaskCreated(event.data);
    case 'task.changed':
      return renderTaskChanged(event.data);
    case 'plan.started':
      return renderPlanStarted(event.data, index);
    case 'plan.changed':
      return renderPlanChanged(event.data, index);
    case 'external.received':
      return renderExternalReceived(event.data);
    case 'notice.posted':
      return renderNotice(event.data);
    case 'mesh.paused':
      return renderPaused(event.data);
    case 'mesh.resumed':
      return renderResumed(event.data);
    // Threads appear in Discord with their first message; presence is shown by /mesh status.
    // Member events refresh the bridge's index (task-10) rather than posting.
    case 'thread.created':
    case 'presence.changed':
    case 'member.joined':
    case 'member.removed':
      return [];
  }
}
