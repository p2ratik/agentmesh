# ADR 0003 — The hub is a modular monolith

**Status:** accepted · 2026-10-16

## Context

The hub owns messaging, presence, tasks and workflows, planning, leases, ingest/rules and the
kill switch. These could be separate services on the bus.

## Decision

One process, split into modules (`apps/hub/src/modules/*`). Modules depend only on the service
interfaces in `apps/hub/src/contracts.ts`, never on each other's tables or internals; `app.ts`
wires them in dependency order. Each module returns `{ service, handlers, ticks, start, stop }`.

## Consequences

- One deployable, one SQLite database, one transaction across modules when a task change also
  posts messages — no distributed consistency problems.
- Module boundaries are explicit and testable in isolation (fakes for the contracts; the real
  services over an in-memory database).
- A module can later move to its own process behind the same contracts if load ever requires it.
