import type { Clock, Logger } from '@agentmesh/common';
import type { ConfigIndex, LoadedConfig } from '@agentmesh/config';
import type { Outbox } from './contracts';
import type { Db } from './db/database';

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
}

export function createHubContext(
  fields: Omit<HubContext, 'index' | 'setIndex'> & { index: ConfigIndex },
): HubContext {
  const { index, ...rest } = fields;
  let current = index;
  return {
    ...rest,
    get index() {
      return current;
    },
    setIndex(next) {
      current = next;
    },
  };
}
