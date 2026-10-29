import { ensureStreams, jetstreamManager } from '@agentmesh/bus';
import { streamNames, subjects } from '@agentmesh/protocol';
import { connect } from '@nats-io/transport-node';
import { describe, expect, it } from 'vitest';

/** Needs AGENTMESH_TEST_NATS=nats://… with JetStream. */
const NATS = process.env.AGENTMESH_TEST_NATS ?? '';
const PREFIX = `topo${Date.now().toString(36)}`;

describe.skipIf(!NATS)('stream topology', () => {
  it('caps the size of streams an older hub created without a limit', async () => {
    const nc = await connect({ servers: NATS });
    const jsm = await jetstreamManager(nc);
    const names = streamNames(PREFIX);
    const subs = subjects(PREFIX);
    try {
      // What hubs before the cap created: no max_bytes.
      await jsm.streams.add({
        name: names.events,
        subjects: [subs.eventAll],
        retention: 'limits',
        storage: 'file',
      });
      await jsm.streams.add({
        name: names.ingest,
        subjects: [subs.ingestAll],
        retention: 'workqueue',
        storage: 'file',
      });
      await ensureStreams(jsm, {
        prefix: PREFIX,
        eventRetentionDays: 7,
        ingestDedupMinutes: 60,
        eventsMaxBytes: 8 * 1024 * 1024,
        ingestMaxBytes: 2 * 1024 * 1024,
      });
      const events = (await jsm.streams.info(names.events)).config;
      const ingest = (await jsm.streams.info(names.ingest)).config;
      expect(events).toMatchObject({ max_bytes: 8 * 1024 * 1024, discard: 'old' });
      expect(ingest).toMatchObject({ max_bytes: 2 * 1024 * 1024, discard: 'old' });
    } finally {
      for (const name of [names.events, names.ingest]) {
        await jsm.streams.delete(name).catch(() => undefined);
      }
      await nc.close();
    }
  }, 30_000);
});
