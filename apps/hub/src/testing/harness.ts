import { createLogger, ManualClock } from '@agentmesh/common';
import { ConfigIndex, type LoadedConfig } from '@agentmesh/config';
import type { HubContext } from '../context';
import { SqliteOutbox } from '../core/outbox';
import { Db } from '../db/database';
import { migrate } from '../db/migrate';
import { MemoryPorts } from '../ports';
import { testTeamConfig } from './fixtures';

export interface TestHarness {
  ctx: HubContext;
  ports: MemoryPorts;
  clock: ManualClock;
  outbox: SqliteOutbox;
}

/** In-memory database, manual clock and recording ports. No NATS needed. */
export function createTestHarness(loaded: LoadedConfig = testTeamConfig()): TestHarness {
  const db = new Db(':memory:');
  const clock = new ManualClock('2026-10-16T09:00:00.000Z');
  migrate(db, () => clock.now());
  const logger = createLogger('hub-test', { level: 'silent', destination: 'stderr' });
  const ports = new MemoryPorts();
  const outbox = new SqliteOutbox(db, clock, logger, ports, ports);
  const ctx: HubContext = {
    loaded,
    index: new ConfigIndex(loaded.config),
    db,
    clock,
    logger,
    outbox,
  };
  return { ctx, ports, clock, outbox };
}
