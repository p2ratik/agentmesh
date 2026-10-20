import type { ConfigIndex } from '@agentmesh/config';
import type { DomainEvent } from '@agentmesh/protocol';
import { renderNotice, renderPaused, renderResumed } from '../render/control';
import { renderExternalReceived } from '../render/external';
import type { PostIntent } from '../render/intents';
import { renderMessageCreated } from '../render/message';
import { renderPlanChanged, renderPlanStarted } from '../render/plan';
import { maskEvent } from '../render/redact';
import { renderTaskChanged, renderTaskCreated } from '../render/task';

/**
 * Decides what each activity-feed event looks like in Discord. Pure: the same
 * event and config always produce the same posts.
 *
 * Every post comes from here, so this is where secrets are masked: in every
 * string of the event, before rendering (see `maskEvent`; notices come masked
 * from the hub). Everything else in a post comes from config and constants.
 */
export function routeEvent(event: DomainEvent, index: ConfigIndex): PostIntent[] {
  return render(maskEvent(event), index);
}

function render(event: DomainEvent, index: ConfigIndex): PostIntent[] {
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
