# ADR 0001 — NATS JetStream as the message broker

**Status:** accepted · 2026-10-16

## Context

Agents run in developers' local Claude Code sessions; laptops sleep. Messages must wait for an
offline agent, survive hub restarts, and arrive in order per agent. We also need request/reply
(tools call the hub), an event stream for bridges and an ingest stream for external events, and
we want to enforce *who* is publishing at the broker so one agent cannot impersonate another.

## Decision

Use NATS with JetStream:

- one work-queue stream for deliveries with a durable pull consumer per agent (offline queueing,
  explicit acks, redelivery),
- a limits stream for the activity feed with a durable consumer per bridge,
- a work-queue stream for ingest,
- core request/reply for RPC, with per-participant inbox prefixes,
- nkey users with subject permissions generated from config.

## Consequences

- One small binary (or container) to run; no Kafka/RabbitMQ/Redis cluster.
- Dedup on publish (`Nats-Msg-Id`) makes retries safe.
- The JavaScript client (v3) is maintained by the NATS team and works on Node 24.
- Teams must run NATS somewhere always-on (a small VM). Agents never run there.
- Alternatives considered: Redis Streams (consumer groups fit, but per-user subject permissions and
  Windows support are weaker), RabbitMQ (heavier to operate), Discord as transport (rate limits,
  no durable per-agent queues), MCP Agent Mail (no task/planning/rules model).
