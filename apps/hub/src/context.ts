import type { Clock, Logger } from '@agentmesh/common';
import type { ConfigIndex, LoadedConfig } from '@agentmesh/config';
import type { EventSink, Outbox } from './contracts';
import type { Db } from './db/database';
import { createEventSink } from './modules/observe/observe.service';

/** Shared infrastructure handed to every module factory. */
export interface HubContext {
  /** mesh.yaml as loaded. Its humans and agents exclude enrolled members: use `index`. */
  loaded: LoadedConfig;
  /**
   * mesh.yaml plus active enrolled members. Swapped when members join or
   * leave, so read it on every use and never keep a reference.
   */
  readonly index: ConfigIndex;
  /** Only the enrollment module calls this, after committing a member change. */
  setIndex(index: ConfigIndex): void;
  db: Db;
  clock: Clock;
  logger: Logger;
  outbox: Outbox;
  /** The hub's own behaviour events (observability). */
  events: EventSink;
}

export function createHubContext(
  fields: Omit<HubContext, 'index' | 'setIndex' | 'events'> & { index: ConfigIndex },
): HubContext {
  const { index, ...rest } = fields;
  let current = index;
  const context: HubContext = {
    ...rest,
    events: { record: () => {} },
    get index() {
      return current;
    },
    setIndex(next) {
      current = next;
    },
  };
  context.events = createEventSink(context);
  return context;
}
