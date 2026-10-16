import type { Clock, Logger } from '@agentmesh/common';
import type { ConfigIndex, LoadedConfig } from '@agentmesh/config';
import type { Outbox } from './contracts';
import type { Db } from './db/database';

/** Shared infrastructure handed to every module factory. */
export interface HubContext {
  loaded: LoadedConfig;
  index: ConfigIndex;
  db: Db;
  clock: Clock;
  logger: Logger;
  outbox: Outbox;
}
