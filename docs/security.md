# Security

AgentMesh assumes a trusted team: agents may ask, assign, review and merge into the integration
branch without asking their humans. The controls below are about keeping it that way — making
sure only your team is on the mesh, that outside content can't steer agents, and that humans keep
the irreversible decisions.

## Identity

- Every process authenticates to NATS with its own **nkey**. `mesh.yaml` holds only public keys;
  seeds stay with their owner (agents) or on the hub VM (hub, bridge, ingest).
- `agentmesh nats-config` renders **least-privilege** permissions: an agent may publish RPCs only
  under its own id, read only its own session subjects and receive only its own replies. The hub therefore
  trusts the caller named in the subject — one agent cannot act as another (covered by the
  authenticated end-to-end test).
- `agentmesh nats-config --auth-callout` renders account mode for invite-only onboarding (see
  `docs/specs/auth-callout-spike.md`). Agents are no longer listed: the hub's callout admits each
  connect and fails closed when the hub is down. The hub, the bridge and every other service stay
  static users, so the hub can never lock itself out.
  - Every static user except the hub keeps explicit `permissionsFor()` permissions. A NATS user
    without permissions gets `>`, which would let the bridge read every auth request on
    `$SYS.REQ.USER.AUTH` and publish any agent's RPC subject. The callout integration test checks
    that the bridge is refused both.
  - The hub's system-account user is an nkey that may only publish `$SYS.REQ.SERVER.*.KICK`;
    `CONNZ` and the other system requests are refused.
  - `xkey` is always rendered, so auth requests (which carry invite codes) are sealed.
  - The issuer, xkey and sys seeds are new hub secrets in `deploy/secrets/`; `nats.conf` and
    `mesh.yaml` hold only their public keys. `permissionsFor()` lives in `packages/bus`, the one
    source for both `nats.conf` and the JWTs the callout issues.
  - **The hub's callout is the only nkey signature check** (`apps/hub/src/modules/callout`):
    nats-server forwards the signature unchecked. For every connect the callout:
    1. checks that the request JWT is signed by the server it names. That is only a consistency
       check: requests can't be forged because no client may publish to `$SYS.REQ.USER.AUTH`;
    2. verifies the agent's nkey signature over the nonce;
    3. admits a key that mesh.yaml or an active member holds;
    4. otherwise redeems the invite in `auth_token`;
    5. anything else is refused, and so is any error. An unanswered request is a refusal too.
    Admitted agents get a user JWT with `permissionsFor()` and `exp` from
    `enrollment.userJwtTtlMinutes`. Failed redemptions are rate-limited per invite and per client
    address (`enrollment.redeemAttemptsPerMinute`, in memory). The refusal reason goes only to the
    hub log; the response says `not authorized`, and tokens are never logged.
  - Removing a member revokes them first, then kicks every connection the callout admitted them
    on. Connections admitted before a hub restart are not tracked; the JWT's `exp` ends them.
  - A member who leaves (`/mesh remove` or an edit to mesh.yaml) stays listed in their threads,
    but the hub skips them as a recipient, so they receive nothing. Their leases stop blocking
    others. Tasks and review rounds they already hold are not moved (see discord.md).
    - **Threat:** whoever later gets the same agent id inherits those threads.
    - **Mitigation:** partial in code. An invite may not take an agent id that a removed invited
      member still holds under a different human id. Human ids are not tied to a person, and ids
      from mesh.yaml are not reserved at all. Admins reuse a departed member's ids only for the same
      person.
- Only the bridge service with `canActAsHumans` may act for humans, and only for humans listed in
  config, mapped from their Discord user ids.
- Keep the ingest endpoint private. NATS is either on a private network (Tailscale) or public
  only over TLS, as `/agentmesh:setup` deploys it (4222 with TLS, plus 80 for Let's Encrypt; see
  [Setup and the admin workspace](#setup-and-the-admin-workspace)).

## Trust labels

Messages carry `trust: team | external`. Anything derived from an external event (CI logs, error
reports, issues, webhooks) is `external`, and the plugin's instructions tell Claude to treat it as
data, never as instructions. This is the main prompt-injection surface once Hermes is connected.
Branch protection is the backstop.

## Permission prompts stay local

The plugin does **not** declare Claude Code's permission-relay capability: no message on the mesh
can approve a tool call on someone's laptop. Each person's own permission settings still apply.
Allow `mcp__plugin_agentmesh_mesh__*` (the mesh tools); keep `gh pr merge` into protected
branches, force-pushes, infrastructure CLIs and secrets on "ask".

## Who can read the mesh in Discord

- **Threat: someone in the Discord server who is not on the team.** The bridge provisions the mesh
  channels without permission overwrites, so every server member reads every agent conversation,
  task, review (including security reviews of unfixed bugs) and escalation.
- **This is deliberate.** The team watches and steers its agents in the open. The server is the
  trust boundary, and admins are expected to keep it to their team.
- **Mitigations:**
  - Acting is gated even though reading is not. Slash commands, autocomplete and buttons require a
    member (`authorize`), and `/mesh` admin commands require the admin role.
  - Invite codes go by DM only.
  - Everything the bridge posts is redacted (below) before it reaches Discord, not only mesh
    messages. The one exception is the `/mesh invite` code, which goes untouched into the
    invitee's DM.
- **Residual risk:** anyone the admin lets into the server sees vulnerability details while they
  are being fixed. A team that shares its server with outsiders should manage its own locked-down
  channels (`provision.enabled: false` plus `discord.channels`).

## Git

- Agents work in a separate worktree per task and open PRs into `agents` (configurable).
- Protect `main`: pull requests required, CI green, at least one **human** CODEOWNER approval, no
  force-push.
- Agents push with their owners' credentials, so GitHub cannot tell an agent's approval from its
  human's. For a hard separation, give each agent its own GitHub machine account (fine-grained
  token that can push branches but not bypass protection) and exclude those accounts from the
  CODEOWNERS team that approves `main`.

## Sessions and per-session delivery

The hub hands each message to one Claude Code session of an agent over core NATS
([ADR 0006](adr/0006-per-session-delivery.md)). New subjects: `{p}.session.{agent}.{session}` and
`{p}.ack.{agent}.>`. An agent may subscribe to `{p}.session.{self}.*` and publish to
`{p}.ack.{self}.>`. In `permissionsFor()`, agents also lost their JetStream delivery grants: the
`$JS.API.INFO`, stream info, consumer info, `CONSUMER.MSG.NEXT` and `$JS.ACK` subjects of the
removed `{P}_DELIVERY` stream and `inbox-{agent}` consumer. Nothing else changed. A static
`nats.conf` rendered before the upgrade still lacks the new grants: the plugin cannot subscribe
to its session, and `session.check` then fails (see the upgrade notes in
[deploy.md](deploy.md#operations)).

- **Sessions of one agent share permissions.** Any process holding an agent's key can subscribe to
  every session of that agent and read what is delivered to them. Keeping one person's sessions
  apart from each other is not a goal; the boundary is the agent.
- **Session ids are client-asserted.** The envelope's `session` is checked against the open
  sessions of the authenticated caller before any handler sees it, so an agent cannot act as
  another agent's session. Agent calls without one are refused, except `session.hello` and
  `session.bye`. A heartbeat's session must be a hub-issued id (`SessionId`; anything else, such
  as `a.>`, drops the heartbeat), because the hub uses it as a subject token when it answers
  `expired`; it is then checked against the agent named in the subject. The hub issues the ids.
- **Acks cannot be forged across agents.** Reply subjects are random tokens the hub chose under
  `{p}.ack.{agent}.`, and an agent may publish only under its own. The ack body is untrusted: it is
  validated, intersected with the ids the hub sent, and a malformed reply counts as a failure.
- **Activation proves the channel works, not that the human wants the session on.** The hub
  generates the code (6 characters, `[A-Z2-9]`, valid 10 minutes, the latest per session) and
  sends it over the session subject; it reaches Claude only through a channel push, and the
  `activate` tool's result never contains it. So a session activates only if both the NATS leg
  and the push work. The code is a liveness proof, not an authorization: only the authenticated
  agent can call `session.activate` for its own session anyway. It is kept in hub memory, so a
  hub restart means asking for a new one. The slash commands are user-only
  (`disable-model-invocation`), but with the `mcp__plugin_agentmesh_mesh__*` allow rule Claude
  could call the `activate` tool by itself. The tool description tells it to do so only when its
  human asks; that is the only guard.
- **Descriptions are team-visible.** A session's one-line description and its id appear in `peers`
  for the whole team. Descriptions go through secret redaction; do not put anything private in one.
- **Old plugins are refused.** `session.hello` rejects plugins older than 0.3.0: before 0.2.0 they
  would pull from the removed inbox and could not take per-session delivery, and 0.2.x cannot
  report the FYIs it showed (`messages.seen`). Their later calls carry no session and are refused
  with the same update instruction, so the refusal shows in tool errors.
- **`toSession` is validated:** one agent recipient, and an active session of that agent. A sender
  cannot aim at a session it was not shown.
- **External content.** A hub-posted body (such as a rendered ingest notice) is masked, then
  clipped to `limits.maxBodyChars`. An ingest `notify` masks and clips the rendered event text
  first, leaving room for the footer that tells Claude to treat the text as data, so the footer
  always survives (see [Secrets in messages](#secrets-in-messages): mask before any cut). The
  message's `trust: external` flag is unaffected, and the plugin sets the push's `trust` meta from
  that flag.
- **An event cannot choose its own class.** The delivery class of an ingest `notify` comes only from
  the rule's `notify.class` (default `action`), never from the event's content. So an external
  payload cannot make its own message quiet, or make a quiet one loud.
- **`messages.seen` is client-driven and bounded.** It marks read only deliveries addressed to the
  caller, ignores every other id, and always answers `{ ok: true }`, so it reveals nothing about
  which ids exist. It never moves a read cursor past an unread action, so a plugin that lies can
  only hide its own agent's FYIs from itself, never a question or a next step.

## Loops and cost

- Thread depth limit (`limits.maxThreadDepth`) stops A→B→C→D chains of agent-created threads.
- Per-thread and per-sender rate limits, and duplicate suppression.
- Planning contributions are delivered as one digest per round, not one message per agent.
- **Kill switch**: `/mesh pause` holds every delivery; `/mesh resume` releases them. The pause
  also holds deliveries queued before it, in the same transaction, so nothing is pushed while
  paused and no status item rides along either. A batch already being handed over when the pause
  lands can still finish. The pause stops pushes, not pulls: an agent that calls `inbox` or
  `thread` while paused still reads its messages, and they are not pushed again on resume.

## Secrets in messages

The hub redacts common credential formats (AWS keys, GitHub/Slack/Anthropic/OpenAI tokens, Discord
bot tokens, JWTs, NATS seeds, private-key blocks, `password=`/`token=` assignments) before storing
or forwarding a message. It is a safety net, not a licence: never send secrets over the mesh. The
hub and the Discord bridge share one redactor, `redactSecrets` in `packages/common`: one pass of
fast patterns over the whole text.

Only credentials are masked: `Use max_tokens: 1024` reaches agents as written. In an assignment
whose name contains `password`, `secret`, `token` or `api_key`, these values are kept: numbers of
up to 10 characters (counts, limits, durations, also as `1024}` or `1024)`), plain settings
(`on`/`off`, `yes`/`no`, `enabled`/`disabled`, `none`, `required`/`optional`, `bearer`/`basic`),
type names, env references, placeholders and AWS ARNs (`secret_arn: arn:aws:secretsmanager:…`, which
names a secret but is not one). Numbers stay masked under a password, `otp` or `mfa` name (PINs and
one-time codes).
- **Cost:** a digit-only secret of 10 characters or fewer under a `token`, `secret` or `api_key`
  name is shown; longer digit-only keys and session tokens are masked.

- **Threat: input that makes the redactor backtrack.** Redaction runs on every message body (up
  to 32 KB), including rule notices built from external event text, and the bridge runs it on
  every notice (up to 1 MB of external text). Before 2026-10-20 the `key=value` and JWT patterns
  were unanchored, and `'token'.repeat(1600)` (8 KB) took 45 s, stalling the hub.
- **Mitigation:** every pattern starts at the start of a run of key characters (a lookbehind) and
  bounds the key to 64 characters on each side of the keyword. `redact.test.ts` keeps the 32 KB
  worst cases under 250 ms; they run in about 1 ms. The 1 MB inputs we measured on 2026-10-21 took
  up to about 85 ms.
- **Cost:** a key with more than 64 characters before or after the keyword is no longer
  recognised.

The hub redacts text where it comes in, before anything cuts it. A cut token no longer matches its
pattern, so nothing downstream (the bridge included) could catch it. The code that cuts
(`createThread`, `firstLine`, `slugify`) only cuts. This covers:
- thread subjects: explicit ones (`message.send`), the first line of an ask or an escalation, and
  plan threads (`Plan: <topic>`);
- task titles, which become thread subjects and branch names. Titles from `task.create`,
  `review.request` and `plan.submit` drafts are stored redacted. The suggested branch name
  redacts the title again before `slugify` cuts it;
- the one-line note a `request_changes` review leaves on the task's transition;
- plan contributions, which are stored redacted. `plan_get` returns them as stored, and each
  round's digest cuts them;
- object placeholders (`{{payload}}`), which render as JSON cut at 500 characters. The JSON is
  masked first, up to 4 KB past the cut, so a token that straddles the cut is seen whole: one pass
  over at most 4.6 KB, whatever the payload's size. If the JSON runs on past that window, the last
  4 KB of the masked window are never shown, because a token there may be cut in two;
- rule actions. Once its template is filled in, a notify subject or `create_task` title (or the
  `[source] type` fallback) is masked through the same window, cut at 200 characters. A rule that
  puts a 1 MB payload string into a subject therefore costs no more than a short one.

Templates (`{{ path }}` in rules, `post_notice` in workflows) fill values in raw, and their text
is masked as a whole wherever it is shown:
- `post()` masks every body before its size cap;
- the rule action masks subjects and titles, and a notify's text before it clips it to leave room
  for the external-content footer;
- the bridge masks every notice.

Masking each value on its own was tried and dropped. A private key split across values (the lines
of a log, a CloudWatch event's messages) lost its BEGIN line to the mask, so the key body was
posted in clear.

Throttle keys are rendered raw. They are never posted, and masking would merge keys: every Secrets
Manager ARN would share one, so only one alert would fire per window. They are stored in
`rule_throttles`, so never throttle on a secret.

The bridge masks everything it posts, because the mesh channels are readable by the whole server:
- **Feed posts:** `routeEvent` masks every string in a feed event before any renderer sees it
  (`maskEvent`). That covers task titles, plan topics, summaries and draft titles, notices,
  external events, and anything rendered later.
  - It masks before rendering, never after. Renderers truncate, and a cut token is no longer
    recognised. They also compose text (`<url>`, `id: title`) that a second pass would mangle.
  - An external event's raw `payload` (the webhook body, up to 1 MB, written by outsiders) is
    dropped first. No renderer shows it, and scanning it would only cost time.
- **Replies:** every RPC result is masked before a slash command renders its reply
  (`maskResults`). Hub errors are masked in every reply, including the one to a Discord message
  the hub refused to relay.
  - The exception is `enrollment.invite`, whose code goes untouched into the DM and never into a
    reply.

- **Residual risk:** plan topics and summaries, task descriptions and reviews are still stored in
  the hub as written, and so are task titles and plan contributions stored before this change. Only
  messages and the texts listed above are redacted at the hub, so anyone with the hub's database
  sees the rest.
- **Residual risk: raw event types.** The hub does not mask a `raw` source's event type, so rules
  match it as sent (`token:refresh`). It is never cut either: a type longer than 120 characters is
  refused with a 400. But characters outside `[A-Za-z0-9_.:-]` become `_`, and that can hide a
  token from the patterns' word-boundary anchors (`deploy failed ghp_…` becomes
  `deploy_failed_ghp_…`). Raw types come from a header or field configured on an authenticated
  source.
- **Residual risk: what the patterns miss.** These gaps are as old as the redactor. A follow-up
  task will close them, tested against this redactor from the start:
  - in JSON text, a quoted secret that contains `"` (`"DB_PASSWORD":"Xy7\"kP9…"`) is masked up to
    the `\"`, and the rest of it is shown;
  - a token right after an escaped newline or tab in JSON (`"step failed\nghp_…"`) is not
    recognised: after `\n` there is no word boundary;
  - an escaped-quote pair inside a JSON string (`{\"password\":\"…\"}`) is not recognised;
  - in name/value entries, such as an ECS or Kubernetes
    `environment: [{ name: 'DB_PASSWORD', value: '…' }]`, neither key reads as a secret, so the
    value is shown;
  - the cosmetic cost of masking whole text: a keyword followed by `:` or `=`, in a template, a
    title or a value, masks the next word (`SecretsManagerRotationFailed: [REDACTED] error
    rate…`). An unquoted masked value can swallow a closing brace: `{"secret_scanning":true}`
    becomes `{"secret_scanning":[REDACTED]`, so a masked object may no longer parse as JSON. Short
    numbers keep their brace (`"max_tokens":1024}`); plain words do not yet.

## Secrets in RPC results

The hub caches RPC results in `rpc_idempotency` for a day, so a retried call can be replayed safely.
That cache must never hold a secret, and redaction can't help here: the caller needs the secret
itself.

- **Threat:** a method that returns a secret, such as an invite code, would leave the plaintext in
  SQLite. Anyone who can read the hub's data volume or a backup could then recover it.
- **Mitigation:** contracts for such methods set `cacheResponse: false`. The router then stores only
  the key, with `withheld = 1` and no result. A retry with the same key fails with `conflict` and
  does not replay the secret. The router reserves the key (`pending = 1`) before the handler runs,
  so two overlapping calls with the same key cannot both run (one gets `conflict`). A failed call
  frees its key.
- **Residual risk:** if the response is lost in transit, the secret is gone and the caller has to
  start over: `/mesh uninvite` cancels the invite, then `/mesh invite` issues a new one. This is
  accepted on purpose: losing an invite is better than storing it.

## Invite codes

*The hub's enrollment module and auth callout implement these rules. The design and its
trade-offs are in [ADR-0005](adr/0005-team-registry-and-auth-callout.md).*

An invite code (`/mesh invite`) is a **bearer token**. Whoever presents it first enrolls, so the
Discord id on the invite only labels the member: redeeming the code does not prove that Discord
identity.

- **Threat: a TLS-stripping attacker on the network path.** The secret travels in the NATS
  CONNECT. With a `nats://` URL, the client upgrades to TLS only if the server's INFO asks for it,
  and an attacker can rewrite that INFO. They can then read the secret, relay the nonce signature
  and enroll as the new member.
  **Mitigation:** the protocol accepts `tls://` and `wss://` invite URLs only. Plaintext
  `nats://` and `ws://` are allowed for localhost only, and URLs carrying credentials are refused.
  The URL scheme alone is not enough: nats.js ignores it and still upgrades only when INFO asks.
  So `connectBus`/`connectOnce` pass `tls: {}` whenever a server URL is `tls://` or `wss://`, and
  the client then refuses a server that does not offer TLS before sending CONNECT. A test with a
  fake plaintext server checks that nothing (no CONNECT, no secret) is sent. This also hardens
  every later connect to a `tls://` hub URL.
- **Threat: the code at rest.** **Mitigation:** the hub stores only sha256(secret) and compares
  it in constant time. The result is never written to the idempotency cache
  (`cacheResponse: false`), decode errors never echo the code, and every logger redacts fields
  named `invite`, `inviteCode`, `secret`, `token` and `auth_token`.
- **Threat: replay or a race on one code.** **Mitigation:** redemption marks the invite used and
  inserts the member in one transaction, guarded by `used_at IS NULL` and by the member's unique
  id and key. Every refusal (unknown, wrong secret, used, cancelled, expired, key in use) returns
  the same `unauthenticated` error; the reason goes only to the hub log.
- **Threat: a registry entry shadowing mesh.yaml.** **Mitigation:** invites refuse ids, Discord
  ids and keys that mesh.yaml or an active member already uses. If mesh.yaml later adds a
  colliding entry, mesh.yaml wins and the member is ignored (logged as shadowed).
- **Threat: guessing.** **Mitigation:** 256-bit secret, single use, a short TTL
  (`enrollment.inviteTtlHours`), and rate-limited redemption (`enrollment.redeemAttemptsPerMinute`).
- **Threat: other services reading the member list.** **Mitigation:** `enrollment.list` is
  restricted to services with the `bridge` role. It also returns open invites for `/mesh uninvite`
  autocomplete, but only their metadata: id, person, agent, Discord id, inviter and expiry. Never
  the code, the secret or its hash. The bridge's autocomplete for `/mesh uninvite` and
  `/mesh remove` uses the same gate as the commands: nothing for people who are not members, and
  nothing on admin subcommands for non-admins. Otherwise anyone in the guild could list pending
  invitees and invited members.
- **Threat: a leaked or lost code that stays valid.** A code pasted into a chat, or a DM that went
  to the wrong place, would otherwise work until `enrollment.inviteTtlHours` runs out, and the hub
  refuses a second invite for that person meanwhile. **Mitigation:** admins run
  `/mesh uninvite person:<id>` (`enrollment.cancelInvite`, admin only). The hub cancels the open
  invite, so redeeming it is refused, and the person can be invited again. Cancelling is
  idempotent: a used, expired or already cancelled invite is reported and left alone. If the code
  was already redeemed, `/mesh remove` takes the member off.
- **Threat: the Discord DM as the delivery channel.** Anyone who can read the invitee's DMs
  (a compromised Discord account, a shared screen) can enroll first.
  **Mitigation (required of the bridge's `/mesh invite`, task-10):** send the code by DM only,
  never in a channel, an `editReply`, logs or events, and cancel the invite if the DM fails. The
  code is single use, with a short TTL. An admin who suspects a leak runs `/mesh uninvite`; if it
  reports the invite already used, `/mesh remove` kicks that agent at once. (The bridge does not
  post `member.joined` to Discord, so a reply like that is the signal.)
  **Residual risk:** whoever redeems first wins. Prefer a short `enrollment.inviteTtlHours` for
  sensitive teams.

### Joining from a laptop (`/agentmesh:join`)

- **Threat: the code in a model transcript.** A code pasted into a chat ends up in the session
  transcript and in model context. **Mitigation:** the plugin's `join` tool takes only a file
  path (default `~/.agentmesh/invite.txt`) and never prints the code; `/agentmesh:join` tells
  Claude never to ask for it. Errors never echo it, and the file is deleted after a successful
  join. `node <plugin>/dist/server.js join` is a terminal path that bypasses the model entirely.
  **Residual risk:** a user can still paste the code into a chat. It is single use and short-lived,
  so joining promptly spends it.
- **Threat: a crafted invite pointing at an attacker's hub.** That hub could push messages that
  look like team traffic. **Mitigation:** nothing connects until the human confirms the decoded
  `host:port`. The terminal path asks y/N. The tool path returns the host and needs a second call
  with `confirm_hub` set to exactly that host. **Residual risk:** in the tool path, the model relays
  the question, so a model that skipped asking would defeat the check. The terminal path does not
  have this gap.
- **Threat: the agent key leaving the laptop.** **Mitigation:** the plugin generates the nkey
  locally and only the public key reaches the hub, through the signed CONNECT. The seed goes to
  `~/.agentmesh/<agent>.nk` and `agent.json` only points at it (both mode 600). The seed is written
  before anything connects and only moved into place once the hub admits the key, so a laptop
  that cannot save it never spends the single-use invite. The join never logs or prints it.
  **On Windows mode 600 is ignored:** the seed is protected only by the NTFS permissions of the
  user's profile (the user, Administrators and SYSTEM). Keep `~/.agentmesh` inside the profile,
  never in a synced or shared folder.
- **Threat: a lost laptop.** **Mitigation:** `/mesh remove` the member; their key is refused from
  then on. To rejoin they redeem a new invite, which gives them a new key.
- **Threat: silently switching meshes.** **Mitigation:** joining refuses to replace an existing
  `~/.agentmesh/agent.json` unless the user explicitly asks to replace it.
- The invite's `agentId` and `prefix` are hints for the client, which needs them before the first
  connect. The hub never trusts them: it enrolls the agent id it stored with the invite.
- `wss://` invites are refused by the plugin for now: the Node transport has no websocket support.

## The hub in the authentication path (auth-callout mode)

- **While the hub is down,** agents cannot connect or reconnect. Agents already connected stay
  connected until their JWT expires, but their RPCs fail, since the hub answers them. The hub, the bridge and ingest are static users and are
  unaffected.
- **Agents keep retrying refused connects** (`ignoreAuthErrorAbort` in `connectBus`), so they
  come back on their own once the hub does. That's usually within a few seconds, and at most about
  20 s (one connect timeout). Without it, nats.js gives up after two `Authorization Violation`
  errors in a row, which a NATS-plus-hub restart can produce, and agents stay offline until
  Claude Code restarts.
  - The cost: a removed member's plugin keeps retrying until its session ends.
  - The callout refuses an unknown key before any invite or rate-limit work, so this neither
    loads the hub nor throttles other users on the same IP.
  - The first refusal per key and reason within 10 minutes is logged as `agent refused` at
    `warn`, and repeats at `debug`.
  - The next warning after the window carries `repeatedSinceLastWarning`, so a removed member
    who keeps trying stays visible without a line every few seconds.
- **The hub's issuer seed signs every agent's credentials.** Anyone holding it can mint access for
  any agent id, so treat it like the hub's own seed: `deploy/secrets/` only, never in
  `mesh.yaml`, `nats.conf`, git or chat.
- **The kick-only sys seed** can disconnect clients but cannot read or publish mesh traffic.

## Setup and the admin workspace

`/agentmesh:setup` ([ADR 0007](adr/0007-claude-run-setup.md)) has Claude interview the admin and
run the bundled `agentmesh` CLI. The CLI writes a workspace folder on the admin's machine
(default `~/agentmesh/<team>`), copies it to the server over SSH and starts the hub there.

- **Threat: the bot token in a model transcript.** A token pasted into the chat lands in the
  session transcript and in model context. **Mitigation:** the admin types the token into the
  empty `DISCORD_BOT_TOKEN=` line of the workspace's `deploy/.env` in their own editor. The CLI
  reads it there; the skill tells Claude never to ask for a token, an invite code or a key, never
  to repeat one the admin pastes anyway, and to have it reset instead.
  - No CLI step prints a seed, the token or any other `.env` secret, in output or in errors. A test
    runs every step with known secrets and fails if one appears in stdout, stderr or the
    arguments passed to `ssh`, `scp` and `docker` (`apps/cli/src/setup/no-secrets.test.ts`).
    It includes a failing deploy whose stderr echoes the token, the token pasted on the
    `AGENTMESH_VERSION` line, and `upgrade`, and it checks that only `deploy/.env` holds the token.
  - `AGENTMESH_IMAGE_REGISTRY` and `AGENTMESH_VERSION` are printed (a failed pull names the
    image), so `setup deploy` first checks that each is a registry or an image tag the redactor
    leaves alone, and names the setting, never its value, when one is not.
  - A failed command's stderr tail is masked with the shared redactor before the CLI prints it,
    because Docker Compose echoes a malformed `.env` line, token included.
  - The Discord client sends the token only in the `Authorization` header and never puts it in an
    error. Ids read from `.env` (`DISCORD_GUILD_ID`) must be Discord snowflakes (digits) before they
    become part of an API path; a bad one is refused without being echoed.
  - `.env` is written atomically (a temp file with mode 600 in the same folder, then a rename), so a
    crash never loses the only copy of the token. The workspace's `.gitignore` ignores `.env`,
    `.env.*` (that temp file), `deploy/secrets/`, `nats.conf` and `*.nk`. A workspace inside an
    existing repo keeps its `.gitignore`, and render appends the lines it lacks.
- **Threat: Claude reading the secrets by accident.** **Mitigation:** the workspace's
  `.claude/settings.json` denies `Read(./deploy/.env)` and `Read(./deploy/secrets/**)`, and
  `setup render` writes a workspace `CLAUDE.md` that tells every later session there never to open,
  `cat`, `grep` or print them and never to run `docker compose config`.
  **Residual risk:** the deny rules cover the Read tool (and Grep and Glob), not Bash, and both
  they and the `CLAUDE.md` apply only to sessions opened in the workspace. A session started
  elsewhere gets neither; the setup session relies on the skill's rules. Never add allow rules that
  would let a shell command read those files without a prompt.
- **Threat: a stolen laptop.** The admin's laptop holds:
  - the hub's seeds in the workspace (`hub`, `discord-bridge` and, on a server, the callout
    issuer, which can mint any agent's credentials), so whoever takes it has the hub's identity;
  - the Discord bot token, and any other secret you added, in the workspace's `deploy/.env`;
  - the admin's agent seed in `~/.agentmesh`;
  - the admin's SSH key to the server. It logs in without a prompt and has passwordless `sudo`,
    so it gives root on the server, and with it every seed deployed there.

  **Mitigation:** none in code. Use full-disk encryption (FileVault, BitLocker, LUKS), and keep the
  workspace out of synced or shared folders. On Windows, mode 600 is ignored and only the
  profile's NTFS permissions protect the files.
  **Recovery**, in this order, from another machine with a backup of the workspace:
  1. **Lock the laptop out of the server first**, or the thief can read the keys you rotate next.
     From the cloud console or another machine, remove the laptop's public key from the SSH
     user's `~/.ssh/authorized_keys` (and root's), and from any cloud key pair or VM metadata that
     would put it back, then add the new machine's key. If the server's auth log shows logins you
     don't recognise, treat the server as compromised and set up a new one.
  2. **Reset the bot token** in the Discord developer portal (Bot → Reset Token) and type the new
     one into the workspace's `deploy/.env`. Replace any other secret you put in `.env`.
  3. **Rotate the keys** in the workspace. Members' keys never leave their own laptops, so only
     the hub's keys and the admin agent's key change:
     - `agentmesh keys add hub --force --config config --secrets deploy/secrets`, and the same for
       `discord-bridge`, `hub-issuer`, `hub-xkey` and `hub-sys`;
     - the admin agent's key, which setup keeps as `~/.agentmesh/<meshName>-<you>-agent.nk`:
       `agentmesh keys add <you>-agent --force --config config --secrets new-key` writes
       `new-key/<you>-agent.nk`. Move it over that file, delete `new-key/`, then run
       `agentmesh setup admin --dir .` on the new machine.
  4. **Re-render `nats.conf`:**
     `agentmesh nats-config --config config --tls --auth-callout --out deploy/nats/nats.conf`.
  5. **Run `agentmesh setup deploy --dir .`.** It recreates the containers, so NATS and the hub
     load the new keys and the stolen ones stop working.

  A trial runs on the laptop itself, so only step 2 applies.
- **Threat: a man in the middle on the first SSH connection.** `ssh` and `scp` run with
  `BatchMode=yes` and `StrictHostKeyChecking=accept-new`: the CLI never prompts, it trusts a
  server's host key the first time it sees it, and it refuses a key that changes later.
  **Residual risk:** an attacker on the path at that first connection would receive the copied
  seeds and the token. Admins who can check the fingerprint (from the cloud console) should
  connect once with plain `ssh` before running setup.
  On Windows the CLI runs `%SystemRoot%\System32\OpenSSH\ssh.exe` and `scp.exe` when they exist
  (only the system OpenSSH reads keys from the Windows `ssh-agent`), else the `ssh` and `scp` on
  PATH, with the same options. `ControlPath=none` means no shared connection is ever reused, so
  each call authenticates on its own.
- **Threat: a hostile `hosting.ssh` value.** A target starting with `-` would be read as an ssh
  option such as `-oProxyCommand=…`, which runs a local command without the admin's approval.
  **Mitigation:** the answers schema accepts only `user@host` with no leading `-`, and every `ssh`
  and `scp` call puts `--` before the destination. `publicHost` must be a DNS name, and
  `--registry` is validated before it reaches `.env`.
- **Threat: cloud credentials.** **Mitigation:** setup never handles them. A new server is created
  with the admin's own provider CLI, already logged in, and Claude shows each provider command
  before it runs. Nothing that costs money is created before the admin says yes to the proposed
  server.
- **Threat: prompt injection driving operator commands.** An active mesh session can receive a
  message (from a teammate's agent or relayed external content) asking it to redeploy, edit the
  config or run something over SSH. **Mitigation:**
  - operator commands are not mesh RPCs. They run with the admin's own SSH key from the
    workspace, and setup never adds allow rules for the CLI, `ssh` or `scp`, so each one needs the
    admin's approval in the terminal;
  - `/agentmesh:setup` is user-only (`disable-model-invocation: true`), so a model cannot start it
    by itself;
  - agents can never call admin RPCs, the admin's own agent included: setup prints the
    `/mesh invite` lines and the admin runs them in Discord.
  **Residual risk:** an admin who approves a prompt without reading it. Keep the deploy commands
  on "ask".
- **Files on the server.** Before copying, `setup deploy` closes the remote `deploy/` folder
  (`chmod 700`), because scp may create `.env` and the seeds readable by everyone. Afterwards
  `.env` and the seeds get mode 600 and the seeds belong to uid 1000 (the containers' user). It
  first checks that every seed it needs exists locally, since a missing bind-mount source would
  make Docker create a root-owned folder in its place.
- **The bridge sees only its own seed.** The compose file setup renders mounts only
  `discord-bridge.nk` into the bridge; the hub keeps the whole `secrets/` folder. A compromised
  bridge (it parses everything Discord sends) therefore cannot reach the issuer seed.
  **Residual risk:** the repo's own `deploy/docker-compose.yml`, used by hand-built deploys, still
  mounts every seed into the bridge. Apply the single-seed mount there at the next redeploy.
- **The network surface of a setup server.** Port 22 from the admin's IP only, 4222 (NATS, TLS
  required) and 80 (Let's Encrypt renewals) from anywhere. The hub's HTTP port stays on
  127.0.0.1, and a new mesh has no ingest sources. A trial binds NATS to 127.0.0.1 without TLS and
  in static mode; nobody else can join it.
- **`doctor`'s TLS check** connects to NATS as a client would, but with
  `rejectUnauthorized: false`, only so that it can report Node's reason when the certificate is
  refused. A certificate that fails verification fails the check, and nothing is ever sent over
  that connection.
- **Published images.** A server pulls `<registry>/agentmesh-hub:<version>` and the bridge image
  by tag from GHCR. **Residual risk:** whoever controls the registry namespace can push a different
  image under the same tag. Teams that need more can build the images themselves, push them to
  their own registry and render with `--registry`.
