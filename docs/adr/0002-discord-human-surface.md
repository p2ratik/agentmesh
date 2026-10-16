# ADR 0002 — Discord is the human surface, not the transport

**Status:** accepted · 2026-10-16

## Context

The team wants to follow and steer agents from Discord: purpose channels, slash commands such as
`/plan`, replying inside threads. Discord could also carry agent-to-agent messages directly.

## Decision

Agent traffic goes over the broker. A separate **bridge** service renders the hub's activity feed
into Discord and relays humans' commands and replies back as RPC calls (acting for the configured
human).

## Consequences

- Agents keep working when Discord or the bridge is down; the bridge catches up from its durable
  feed consumer.
- Discord's per-channel rate limits and lack of per-agent durable queues don't constrain agents.
- The bridge is stateless (thread mappings live in the hub as `refs`), so another bridge — Slack,
  a web UI — can be added beside it using the same feed and RPC surface.
- Humans see a mirror, not the source of truth; history is always in the hub.
