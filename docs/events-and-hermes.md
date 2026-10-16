# External events and Hermes

The hub turns signals from outside the team — CI, monitoring, error tracking, cron jobs — into
work for the agents. A **Hermes** bot (cron + event-driven, watching GitHub, AWS and PostHog) is
the intended producer, but anything that can send HTTP or publish to NATS works.

```
producer ──HTTP POST /v1/ingest/<source>──┐
producer ──NATS publish mesh.ingest.<src>─┴─► JetStream (dedup) ─► rules ─► notify / create_task / notice
```

Everything an event produces is marked `trust: external`; agents are told to treat it as data,
never as instructions.

## Sending events over HTTP

Configure a source in `mesh.yaml`:

```yaml
ingest:
  sources:
    - id: hermes
      auth: { type: bearer, token: "${HERMES_INGEST_TOKEN}" }
```

Send an `IngestEvent`:

```bash
curl -X POST http://<hub>:8787/v1/ingest/hermes \
  -H "authorization: Bearer $HERMES_INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{
    "id": "posthog-issue-123-2026-10-16T10",
    "type": "posthog.error_spike",
    "severity": "error",
    "summary": "TypeError in checkout (x120 in 10m)",
    "url": "https://eu.posthog.com/project/1/error_tracking/123",
    "payload": { "area": "web", "fingerprint": "abc", "count": 120, "window": "10m" }
  }'
# 202 {"id":"hermes:posthog-issue-123-2026-10-16T10","duplicate":false}
```

| Field | Required | Notes |
| --- | --- | --- |
| `type` | yes | `[A-Za-z0-9_.:-]`, e.g. `aws.alarm.cpu`, `cron.daily_digest`. |
| `id` | no | Dedup key (namespaced by source). Without it, a hash of the body is used. |
| `severity` | no | `debug`, `info` (default), `warning`, `error`, `critical`. |
| `summary`, `url`, `occurredAt` | no | Shown to agents and in Discord. |
| `payload` | no | Any JSON object; rules and templates read it. |

Responses: `202` accepted, `400` invalid body (with issues), `401` bad credentials, `404` unknown
source, `413` body over 1 MiB, `503` NATS unavailable (retry later). `GET /healthz` → `200`.

**GitHub webhooks directly** (`format: raw`): the whole body becomes `payload`, the type is
`<x-github-event>.<action>`, the id is `x-github-delivery`, and the `x-hub-signature-256` HMAC is
verified with your webhook secret:

```yaml
    - id: github
      format: raw
      typeHeader: x-github-event
      typeField: action
      idHeader: x-github-delivery
      auth: { type: hmac-sha256, secret: "${GITHUB_WEBHOOK_SECRET}" }
```

## Sending events over NATS

Give the producer a service entry with `role: ingest` and a key (`agentmesh keys add hermes`).
It may publish IngestEvent JSON to `{prefix}.ingest.{its id}` — NATS permissions guarantee the
subject names the real sender. Use the `Nats-Msg-Id` header (or `id`) for dedup.

## Rules

Rules live in `rules/*.yaml` (or `rules:` in mesh.yaml) and run in order:

```yaml
rules:
  - id: ci-failed-on-shared-branches
    match:
      source: github                     # one or a list
      type: workflow_run.completed       # exact, or prefix with * (workflow_run.*)
      minSeverity: warning               # optional floor
      where:                             # dotted paths into the event
        payload.workflow_run.conclusion: { equals: failure }
        payload.workflow_run.head_branch: { in: [main, agents] }
    throttle: { key: "{{payload.workflow_run.head_branch}}", windowMinutes: 30 }
    stop: false                          # true: no later rule sees this event
    actions:
      - create_task: { title: "Fix CI on {{payload.workflow_run.head_branch}}", repo: "{{payload.repository.full_name}}", priority: high, workflow: incident }
      - notice: { channel: alerts, text: "CI failed: {{payload.workflow_run.html_url}}" }
```

**Conditions**: `equals`, `in`, `exists`, `contains` (substring or array item), `matches`
(regex), `gte`, `lte`. All listed operators must hold.

**Templates**: `{{ path }}` looks up `id`, `source`, `type`, `severity`, `summary`, `url`,
`occurredAt` or `payload.…`. Lookups only — no expressions; missing values render empty.

**Actions**:

| Action | Fields | Result |
| --- | --- | --- |
| `notify` | `to: area-owners \| online \| all-agents \| [ids]`, `area` or `repo` (for area-owners), `subject`, `text` | A new `event` thread with the recipients; pushed into their sessions. |
| `create_task` | `title`, `description`, `area`, `repo`, `assignee`, `priority`, `labels`, `workflow` | A task, routed like any other (priority defaults to `high` for error/critical). |
| `notice` | `channel` (Discord purpose), `text` | A post in that Discord channel. |

**Throttle** suppresses repeats: the rule fires at most once per rendered key per window.

## Recipes for Hermes

- **PostHog error spike** → `notify: { to: area-owners, area: "{{payload.area}}" }`.
- **AWS CloudWatch alarm** → `notify: { to: online }` + `notice: { channel: alerts }`.
- **Daily digest from cron** → `notice: { channel: events, text: "{{summary}}" }`.
- **Failed deploy on main** → `create_task` with the `incident` workflow.

All four are in `config/examples/rules/examples.yaml`.
