# ADR 0004 — SQLite state with a transactional outbox

**Status:** accepted · 2026-10-16

## Context

Every state change (a message stored, a task moved) must also reach NATS (deliveries to agents,
events for bridges). Publishing directly from request handlers loses messages when NATS hiccups
between the database write and the publish, or publishes things whose transaction then rolls back.

## Decision

- State lives in SQLite via `node:sqlite` (no native dependency), accessed through small
  repositories.
- Services write deliveries and feed events into **outbox tables in the same transaction** as the
  state change. A dispatcher publishes them after commit and on every scheduler tick, marking rows
  published; failures are retried, per-recipient order is preserved, and dedup ids make
  republishing harmless.
- The kill switch marks new deliveries `held`; resuming releases them.

## Consequences

- At-least-once delivery with no lost messages across NATS outages or hub restarts.
- Consumers (plugin, bridge) must tolerate duplicates; both do.
- SQLite fits one hub per team. The repositories isolate SQL so Postgres could replace it.
