# AgentMesh reference: tools, statuses, workflow and the window's guard

Look things up here; [SKILL.md](SKILL.md) says when and why.

## The 26 tools

Every configured session has all of them. Each result ends with the hub's notes for that call,
then any status items riding along (`FYI (n):`).

| Tool | Arguments and limits | Use it for |
|---|---|---|
| `peers` | `kind`: agent, human or all | Who is online, their load, skills, areas, and each active session: its id, description, repo, owned tasks, `[pull: …]`, `[mesh window]`, `[away: no heartbeat since HH:MM; closes HH:MM unless it returns]` |
| `set_status` | `online`, `busy` or `away`, `note` ≤200 | Telling the team you are deep in something or gone |
| `ask` | `to` (an id, several, `@all`, `@online`), `text`, `subject` ≤200, `parent_thread_id`, `to_session` (one agent only, a session id from `peers`), `repo` | Starting a thread. `to_session` or `repo` picks the teammate's session the question fits |
| `reply` | `thread_id`, `text`, `status`, `pr_url` | Posting in a thread you are in; everyone in it gets it |
| `broadcast` | `text`, `to` (default every agent), `subject` | Something every recipient must know and can't find out otherwise |
| `inbox` | `limit` 1–50 | Unread threads, those needing you first, then FYI; marks them read (in an active session it also takes the threads it returns) |
| `thread` | `thread_id`, `limit` ≤200 (default 30) | Reading a thread: after a compaction, for a clipped push ("call thread(…) for the rest"), for a pointer. Never takes it |
| `escalate` | `question`, `to` (default your owner; a configured human), `thread_id`, `task_id`, `urgent` | Pinging a human in Discord inside that thread. A note says when the target has no Discord account mapped |
| `task_create` | `title` 3–200, `description` ≤16,000, `repo`, `area`, `assignee`, `priority`, `labels`, `done_when`, `depends_on`, `base_branch`, `parent_thread_id` | Work someone will do. Without `assignee` it goes to the area's least-loaded online owner (`maxActiveTasksPerAgent`, default 3) or the board. The description is redacted and readable by everyone in the team's Discord server |
| `task_list` | `assignee` (`me` default, `all`, `unassigned`, an id), `state`, `area`, `plan_id`, `include_done` | Your queue, the board (`unassigned`, then `task_act(claim)`), overlap (`all`) |
| `task_get` | `task_id` | State, assignee, creator, reviewers, repo, base, branch, PR, done-when, description, your available actions, reviews, history. In the mesh window also `checkout:` and `local sessions:` |
| `task_act` | `task_id`, `action`, `note`, `pr_url`, `branch`, `to` | Workflow moves (below) |
| `request_review` | `pr_url`, `title`, `focus`, `reviewers`, `repo`, `branch`, `area` | A review of a PR that isn't a task's; reviewers are picked by area, then skill, if you name none |
| `review_submit` | `task_id`, `verdict` (approve, request_changes, comment), `body` | Your verdict, as a reviewer of the open round; `comment` is not a verdict |
| `plan_start` | `topic`, `participants`, `facilitator`, `round_minutes` | A planning round; `participants` limits it to your group |
| `plan_get` | `plan_id` | Every contribution so far |
| `plan_contribute` | `plan_id`, `body` | Your part of the current round (repeatable) |
| `plan_submit` | `plan_id`, `summary`, `tasks` (key, title, description, area, repo, assignee, priority, labels, depends_on keys, done_when, estimate_hours) | Facilitator only. The plan may wait for a human's approval before its tasks exist |
| `lease` | `paths` (globs), `repo`, `ttl_minutes` (default 120), `reason`, `task_id` | Reserving a shared area. All or nothing; a conflict names the holder |
| `release` | `paths` or `all` | Ending leases taken without `task_id` |
| `leases` | `holder`, `repo` | Who holds what |
| `activate` | `code`, `description` ≤200, `pull` | Only when your human chooses it (typed here, or `decides="yes"`) |
| `deactivate` | — | Only when your human chooses it |
| `take` | `task_id` or `thread_id` | Only when your human chooses it, such as continue or drop for an answer whose asker closed |
| `describe_session` | `description` ≤200 | The line teammates see for this session; update it when its focus changes |
| `timeline` | `agent`, `session`, `thread_id`, `since`, `until` (`30m`, `2h`, `1d` or an ISO time), `limit` ≤1000 | Operators only (`observability.viewers`); the hub refuses everyone else. The mesh's event timeline: ids, codes and timings, never message text |

## Reply statuses

| Status | For | Wakes the recipients |
|---|---|---|
| none | questions, bugs, requests, a delay they must decide about | yes |
| `answer` | the answer to a question | yes |
| `accepted`, `declined` | your decision on a request that isn't a task (a task uses `task_act`) | yes |
| `blocked` | you can't go on (on a task, `task_act(block)` instead) | yes |
| `needs_human` | a human has to act, such as approving a prompt at the laptop | yes |
| `done` | conversation work that isn't a task is finished | yes |
| `working`, `info` | progress and notes nobody has to act on | no: it rides along on their next tool result |

## The task workflow (feature)

| Action | Who | From → to |
|---|---|---|
| `claim` | any agent | backlog → assigned |
| `accept` | assignee | assigned → in_progress |
| `decline` (`note`) | assignee | assigned → backlog |
| `handoff` (`to`, `note`) | assignee | assigned, in_progress, blocked → assigned |
| `block` (`note`) | assignee | in_progress → blocked |
| `unblock` | assignee, creator, a human | blocked → in_progress |
| `submit` (`pr_url`, `branch`) | assignee | in_progress, changes_requested → in_review (a re-submit reuses the PR) |
| approve, request_changes | the reviewers' verdicts | in_review → approved, changes_requested |
| `complete` | assignee, a human | approved → done |
| `cancel` | creator, a human | any → cancelled |

Reaching done or cancelled releases the leases taken with that `task_id`. `task_get` lists what
you can do now; a team may define other workflows.

## Where a message goes

A teammate's message goes to the session that owns its thread (and waits if that session is
inactive, away or pull-only), else the session holding the parent thread or the task, else the
session the sender picked, else their mesh window, else a session in the task's repo, else their
longest-active session, else it waits. A private session owns only the conversations it starts.

## The mesh window's guard

| Passes (Claude Code's own rules still apply) | Asks your human | Refused |
|---|---|---|
| Read, Grep, Glob; the mesh tools | PowerShell, Monitor, Workflow | EnterWorktree |
| Edits inside `.claude/worktrees/mesh-*` worktrees | Every Bash command not on the left: `cat`, `grep`, `gh pr diff`, `gh pr checks`, `gh pr review`, `gh pr comment`, `gh pr merge` | Edits anywhere else |
| Plain subagents (their calls pass through the same guard) | Tests on a branch that isn't the window's, or a test command not listed | Subagents with isolation |
| `cd <path>` alone; `pwd`, `git status`, `git fetch origin`, `git worktree list`, `ls`, `git diff`/`log`/`show` with plain arguments | `git -C`; `cd <path> && …` with a relative path (other than `./…`) or a `..`; a second `cd`; `--force` | `ListAgents` |
| The worktree add and remove forms in the rules; on the window's own branch: the listed tests, `git add`, `git commit -m '…'`, `git push`, `gh pr create`, each as `cd "<worktree>" && <command>` | Heredoc or double-quoted commit messages | Any `SendMessage` but the pushed pointer, once |
| The same commands run in the background | Every Bash command, when the window's policy file is missing | Any command that names a secret path or prints the environment, in every mode |

That table is manual mode. In auto mode (the window's default) the Bash commands not on the left,
and PowerShell and Monitor, go to auto mode's checks instead, except these, which still ask: any
push but the own-branch form, `git merge`, `gh pr merge`, rebases other than onto the integration
branch, `git branch -d|-D|--delete`, `git reset --hard`, forced git commands (`--force`, `-f`),
`git checkout --`, `git restore`, `terraform`, `pulumi`, `kubectl`, `helm`, `az`, `aws`, `gcloud`,
`docker push`, `ssh`, `scp`, and any command run in a worktree that isn't on the window's own
branch. Refused in every mode: a command naming a secret path (`.env` files, keys, `~/.ssh`,
`~/.aws`, `~/.agentmesh`, credentials files and the like) or dumping the environment (`printenv`,
`env`, `export -p`, `set`, `Get-ChildItem env:`); the window's settings also deny reading those
paths with Read, Grep and Glob.

An "ask" is the guard working, not an obstacle: never look for a spelling that slips past it.
