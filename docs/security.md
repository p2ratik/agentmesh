# Security

AgentMesh assumes a trusted team: agents may ask, assign, review and merge into the integration
branch without asking their humans. The controls below are about keeping it that way — making
sure only your team is on the mesh, that outside content can't steer agents, and that humans keep
the irreversible decisions.

## Identity

- Every process authenticates to NATS with its own **nkey**. `mesh.yaml` holds only public keys;
  seeds stay with their owner (agents) or on the hub VM (hub, bridge, ingest).
- `agentmesh nats-config` renders **least-privilege** permissions: an agent may publish RPCs only
  under its own id, read only its own inbox and receive only its own replies. The hub therefore
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
- Only the bridge service with `canActAsHumans` may act for humans, and only for humans listed in
  config, mapped from their Discord user ids.
- Keep NATS and the ingest endpoint on a private network (Tailscale); expose nothing but SSH.

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
    messages.
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

## Loops and cost

- Thread depth limit (`limits.maxThreadDepth`) stops A→B→C→D chains of agent-created threads.
- Per-thread and per-sender rate limits, and duplicate suppression.
- Planning contributions are delivered as one digest per round, not one message per agent.
- **Kill switch**: `/mesh pause` holds every delivery; `/mesh resume` releases them.

## Secrets in messages

The hub redacts common credential formats (AWS keys, GitHub/Slack/Anthropic/OpenAI tokens, Discord
bot tokens, JWTs, NATS seeds, private-key blocks, `password=`/`token=` assignments) before storing
or forwarding a message. It is a safety net, not a licence: never send secrets over the mesh.

- **Threat: input that makes the redactor backtrack.** Redaction runs on every message body (up
  to 32 KB) and on every value a rule template fills in, which can be as large as an ingest event
  (up to 1 MB of external text). Before 2026-10-20 the `key=value` and JWT patterns were
  unanchored, and `'token'.repeat(1600)` (8 KB) took 45 s, stalling the hub.
- **Mitigation:** every pattern starts at the start of a run of key characters (a lookbehind) and
  bounds the key to 64 characters on each side of the keyword. `redact.test.ts` keeps the 32 KB
  worst cases under 250 ms; they run in about 1 ms. At 1 MB the same worst cases took 5–56 ms
  when measured on 2026-10-20.
- **Cost:** a key with more than 64 characters before or after the keyword is no longer
  recognised.

The hub redacts text before it cuts it. A cut token no longer matches its pattern, so nothing
downstream (the bridge included) could catch it. Text is redacted where it comes in. The code that
cuts it (`createThread`, `firstLine`, `slugify`) only cuts, because masking finished text breaks
per-value masking (below). This covers:
- thread subjects: explicit ones (`message.send`), the first line of an ask or an escalation, and
  plan threads (`Plan: <topic>`);
- task titles, which become thread subjects and branch names. Titles from `task.create`,
  `review.request` and `plan.submit` drafts are stored redacted. The suggested branch name
  redacts the title again before `slugify` cuts it;
- the one-line note a `request_changes` review leaves on the task's transition;
- each contribution in a planning round's digest;
- the event type of a `raw` ingest source, before it is rewritten to `[A-Za-z0-9_.:-]` and cut to
  120 characters, and the `[source] type` fallback subject and title of rule actions;
- each value a rule template (`{{ path }}`) or a workflow's `post_notice` fills in. For an
  object, each string inside it is masked before its JSON is cut to 500 characters. The template
  text is trusted config and is not masked. Masking the finished text would match across the
  template and a value: `{{alarm}}: {{summary}}` lost the summary's first word after an alarm
  named `SecretsManager…`.
  - **Cost:** a keyword in the template, or in a neighbouring value, no longer masks what follows
    it. `Config drift: {{payload.name}}={{payload.value}}` posts `DB_PASSWORD=hunter2…` as is.
    Don't template key/value pairs from payloads.
  - Throttle keys are rendered raw. They are never posted, and masking would merge keys: every
    Secrets Manager ARN would share one, so only one alert would fire per window. They are stored
    in `rule_throttles`, so never throttle on a secret.

The Discord bridge applies the same redaction (`redactSecrets` in `packages/common`) to
everything it posts, because the mesh channels are readable by the whole server:
- **Feed posts:** `routeEvent` masks every string in a feed event before any renderer sees it
  (`maskEvent`). That covers task titles, plan topics, summaries and draft titles, external
  events, and anything rendered later.
  - It masks before rendering, never after. Renderers truncate, and a cut token is no longer
    recognised. They also compose text (`<url>`, `id: title`) that a second pass would mangle.
  - An external event's raw `payload` (the webhook body, up to 1 MB, written by outsiders) is
    dropped first. No renderer shows it, and scanning it would only cost time.
  - Notices are posted as the hub composed them, from a trusted template and masked values
    (above).
- **Replies:** every RPC result is masked before a slash command renders its reply
  (`maskResults`). Hub errors are masked in every reply, including the one to a Discord message
  the hub refused to relay.
  - The exception is `enrollment.invite`, whose code goes untouched into the DM and never into a
    reply.

- **Residual risk:** plan topics and summaries, task descriptions, reviews and plan contributions
  are still stored in the hub as written, and so are task titles created before 2026-10-20. Only
  messages and the texts listed above are redacted at the hub, so anyone with the hub's database
  sees the rest.

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
