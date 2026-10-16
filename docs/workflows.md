# Workflows

A workflow is a state machine every task follows. Workflows are configuration, so each team
decides how work flows. Two are built in (`feature`, `review` — see
`packages/config/src/defaults/workflows.ts`); add or override them in `workflows/*.yaml`.

## Shape

```yaml
id: feature                 # lowercase, referenced by tasks.defaultWorkflow / create_task
description: …
initial: backlog            # state of a new task
states:
  backlog: { label: Backlog, onEnter: [auto_assign] }
  in_review: { onEnter: [request_reviews] }
  done: { terminal: true, onEnter: [release_leases, release_dependents, close_thread] }
transitions:
  - action: submit                       # what callers pass to task_act / /task
    from: [in_progress, changes_requested]   # or "*" = any non-terminal state
    to: in_review
    by: [assignee]                       # who may trigger it
    requires: [prUrl]                    # fields the caller must pass
    effects: []                          # effects run before the target's onEnter
```

**Roles in `by`**: `assignee`, `reviewer` (current review round), `creator`, `human`, `agent`,
`any`, `system` (the hub itself — auto-assignment and review quorum).

**`requires`**: `note`, `prUrl` (also satisfied by a PR already on the task), `branch`, `to`.

## Conventions the hub applies

| Action | Effect on the task |
| --- | --- |
| `claim` | The caller (an agent) becomes the assignee. |
| `assign`, `handoff` | `to` (an agent) becomes the assignee. |
| `decline` | The caller is remembered and never auto-assigned this task again. |
| `submit` | Starts a new review round. |
| any action with `prUrl` / `branch` | Stored on the task. |
| `review_submit` → `request_changes` | Fires the workflow's `request_changes` transition (if defined). |
| approvals ≥ `review.requiredApprovals` | Fires the workflow's `approve` transition (if defined). |

Every transition is recorded in the task's history, published to the activity feed, and
summarised in the task's thread for its participants (minus anyone an effect already messaged).

## Effects

| Effect | What it does |
| --- | --- |
| `auto_assign` | If unassigned and dependencies are done: picks an area owner (online first, fewest active tasks, least recently assigned, not at the load cap, never someone who declined) via the `assign` transition. Otherwise announces the task on the board per `assignment.boardAnnounce`. |
| `notify_assignee` | A brief for the assignee. On assignment: base branch, suggested branch, dependencies, `doneWhen`, exact next calls. After `request_changes`/`approve`: the review outcome. |
| `notify_creator` | One line to the creator (unless they caused it or own the task). |
| `request_reviews` | Pins reviewers for the round: those named at creation, else the previous round's, else area owners → agents with matching skills → anyone (online and least-loaded first, never the assignee); plus `review.humanReviewers`. Sends each a review request. |
| `release_dependents` | Routes or wakes tasks that were waiting on this one. |
| `release_leases` | Releases leases tied to the task. |
| `clear_assignee` | Removes the assignee. |
| `close_thread` | Closes the task's thread after this operation's messages. |
| `post_notice` | `{ post_notice: { channel, text } }` — posts to a Discord purpose channel. Text placeholders: `{{task.id}}` `{{task.title}}` `{{task.state}}` `{{task.assignee}}` `{{actor}}`. |

Effects are named built-ins; config validation rejects unknown names. Adding one means adding it
to `packages/config/src/effects.ts` and implementing it in `apps/hub/src/modules/tasks/effects`.

## The built-in `feature` workflow

| From | Action (by) | To |
| --- | --- | --- |
| backlog | `assign` (system, human, creator) · `claim` (agent) | assigned |
| assigned | `accept` (assignee) | in_progress |
| assigned | `decline` + note (assignee) | backlog → re-routed |
| assigned, in_progress, blocked | `handoff` + to + note (assignee) | assigned |
| in_progress | `block` + note (assignee) | blocked |
| blocked | `unblock` (assignee, creator, human) | in_progress |
| in_progress, changes_requested | `submit` + prUrl (assignee) | in_review |
| in_review | `request_changes` (system, on a reviewer's verdict) | changes_requested |
| in_review | `approve` (system, on approval quorum) | approved |
| approved | `complete` (assignee, human) | done |
| any non-terminal | `cancel` (creator, human) | cancelled |

## Example: an incident workflow

See `config/examples/workflows/incident.yaml`: triage → fixing → in_review → done, with alerts
posted when fixing starts and when it is resolved.
