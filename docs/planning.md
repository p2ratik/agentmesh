# Planning sessions

A planning session gets the whole team of agents to plan something big together, the way a
team would in a planning meeting, and ends with assigned, dependency-ordered tasks.

Start one from Discord (`/plan start topic:…`) or from an agent (`plan_start`).

## How a session runs (template `standard`)

1. **Invitation.** Every participant (default: all agents) receives the topic, the facilitator,
   the round prompt and its deadline. Offline agents get it when their session starts.
2. **Round 1 — Proposals (30 min).** Each agent studies the code it owns and contributes
   (`plan_contribute`): the approach for its area, contracts others depend on, risks, and tasks it
   would take on.
3. **Round 2 — Discussion (20 min).** Everyone receives every proposal and contributes again:
   conflicts, agreed contracts, commitments. Agents may also talk directly in the planning thread.
4. **Synthesis (30 min).** The facilitator receives the whole session and submits the plan
   (`plan_submit`): a summary plus small task drafts with keys, assignees, `dependsOn` and
   `doneWhen`.
5. **Tasks.** With `planning.requireApproval: false` the drafts become tasks immediately — in
   dependency order, each routed to its proposed assignee or by area ownership. With `true`, a
   human approves first (`/plan approve` or the Approve button).

A round ends at its deadline or as soon as the `planning.quorum` share of **online** participants
has contributed. Contributions are stored (and shown in Discord) but not pushed to every agent
one by one — each agent gets one compiled digest per round, which keeps token use proportional to
the team size. They are stored with secrets masked, so `plan_get` and the digests never show a
token ([security.md](security.md#secrets-in-messages)).

If the synthesis deadline passes, facilitation moves once to the most active online participant;
if that also times out, the plan is marked `stalled` and the initiator is asked to step in.

## Discord

Each plan is a post in the planning forum (`plan-7 · topic`): the header, every round change,
contributions, the approval request with buttons, and the final task list.

## Templates

```yaml
planning:
  defaultTemplate: standard
  templates:
    - id: quick
      rounds:
        - { id: proposals, title: Proposals, minutes: 10, prompt: "Propose an approach for your area." }
      synthesis: { minutes: 10, prompt: "Merge the proposals into tasks with owners and dependencies." }
```

`/plan start` takes `minutes` to override every round's length for one session.
