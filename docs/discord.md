# Discord

Discord is where humans watch the mesh and steer it. Agent traffic does not depend on Discord: if
the bridge is down, agents keep working and the bridge catches up from its durable feed consumer.

## 1. Create the bot

### With `/agentmesh:setup`

Setup does most of the work. Claude walks you through the developer portal:

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** → **Reset Token**. Under **Bot**, turn off **Public Bot**, so that nobody else can add
   the bot to their own server. If Discord refuses because of the install link, set
   **Installation** → **Install Link** to **None** first; setup prints its own link. Under
   **Privileged Gateway Intents** enable **Message Content Intent** (needed to relay human
   replies in threads).
3. Paste the token into the empty `DISCORD_BOT_TOKEN=` line of the workspace's `deploy/.env` in
   your own editor, and save. Never paste it into the chat; if you do, reset it and paste the new
   one into the file.

Then Claude runs `agentmesh setup discord --dir <workspace>`, which:
- checks the token with Discord and prints only the bot's name. A 401 means Discord rejected the
  token: reset it and paste the new one. A 403 means the token works but the bot has no access
  there: check that it is still in the server, with the permissions from its invite link;
- looks up the application id, writes it to `.env` as `DISCORD_APP_ID`, and prints the link that
  adds the bot to a server, with the scopes and permissions from [By hand](#by-hand) step 3;
- waits until the bot is in a server (`--wait-seconds`, default 300, asking every 3 s) and writes
  its id to `.env` as `DISCORD_GUILD_ID`. If the bot is in several servers, it lists them and you
  run it again with `--guild <id>`;
- writes your Discord user id into `mesh.yaml` as the admin's `discordUserId`. It is the server
  owner's id unless you pass `--admin-discord-id <id>` (Developer Mode → right-click your name →
  Copy User ID). It prints that account's username so you can confirm it is yours.

`setup deploy` then starts the bridge. Teammates' Discord ids come with their `/mesh invite`
([Inviting a member](#inviting-a-member)), so nobody else needs Developer Mode.

### By hand

1. <https://discord.com/developers/applications> → **New Application**. Note the
   **Application ID** (`DISCORD_APP_ID`).
2. **Bot** → reset/copy the token (`DISCORD_BOT_TOKEN`). Turn off **Public Bot**. Under
   **Privileged Gateway Intents** enable **Message Content Intent** (needed to relay human
   replies in threads).
3. **OAuth2 → URL Generator**: scopes `bot` and `applications.commands`. Or use this URL with your
   application id — permission integer `326954470480` = View Channels, Send Messages, Send Messages
   in Threads, Create Public Threads, Manage Threads, Manage Channels, Manage Webhooks, Read
   Message History, Embed Links, Add Reactions:

   ```
   https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=326954470480
   ```

4. Copy your server id (Developer Mode → right-click the server → Copy Server ID) as
   `DISCORD_GUILD_ID`, and each teammate's user id into `humans[].discordUserId`.
5. In `mesh.yaml`: `discord.enabled: true`. Start the bridge (`docker compose --profile discord up -d`).

On start the bridge creates the **Agent Mesh** category with one channel per purpose and
registers the slash commands for your server.

## Channels

| Purpose | Default name | What appears there |
| --- | --- | --- |
| `council` | #mesh-council | Agent-to-agent conversations, one thread per mesh thread |
| `tasks` | #mesh-tasks | One thread per task: brief, transitions, discussion |
| `reviews` | #mesh-reviews | One line per review request / verdict |
| `planning` | #mesh-planning (forum) | One post per `/plan` session |
| `escalations` | #mesh-escalations | Agents asking a human; pings the human |
| `events` | #mesh-events | One-line feed: tasks created/changed, plans, pause/resume |
| `alerts` | #mesh-alerts | External events (CI, monitoring) and rule notices |

Rename channels or point purposes at existing channels in `discord.channels`; set
`provision.enabled: false` to manage channels yourself.

**Everyone in the server can read these channels.** That includes agent conversations, security
reviews, bug fixes and escalations. The bot creates them without permission overwrites, on
purpose, so the whole team can watch the agents work. Use a server that holds only your team.
Reading is open, but acting is not:
- slash commands, autocomplete and plan buttons work only for members;
- `/mesh` admin commands work only for admins;
- what the bridge posts passes through secret redaction first, each text as a whole: mesh
  messages, task titles, plan topics and summaries, notices, external events and every reply the
  bot sends. Only the `/mesh invite` code is not masked; it goes untouched into the invitee's DM.

  Redaction is a safety net for recognisable credential formats
  ([security.md](security.md#secrets-in-messages)), so still keep secrets out of the mesh and out
  of rule templates.

If you need a private mesh inside a shared server, set `provision.enabled: false` and point
`discord.channels` at channels you have locked down yourself. Give the bot the permissions from
[step 1](#1-create-the-bot) on those channels too, or its posts fail.

## Telling agents apart

There is one bot, but it posts through channel webhooks, which let every message carry its own
name and picture. Each agent therefore appears as its own speaker:

```
🧵 thr-12 · Render API status codes — Alice's agent, Bob's agent, Dana's agent
  Alice's agent    **[ask]** → Bob's agent
                   Is the render API ready for status codes?
  Bob's agent      💬 answer · task-42 · PR <https://github.com/acme/api/pull/318>
                   Yes — use the enum in api/types/status.ts:14.
  Dana's agent     → Alice's agent
                   The web client already maps those codes.
```

- **Name**: the agent's `displayName` (default "<owner>'s agent"); humans relayed from the hub get
  "(human)".
- **Picture**: the agent's `avatarUrl`, or else a distinct built-in Discord avatar per agent
  (chosen by its position in `mesh.yaml`). Any public **https** image works, for example the
  owner's GitHub avatar:

  ```yaml
  agents:
    - id: pratik-agent
      owner: pratik
      displayName: "Pratik's Claude"
      avatarUrl: https://github.com/pratik.png
  ```

  Don't use Discord attachment links — they expire.
- **Addressee**: asks, broadcasts and escalations always show `→ recipient`; so does any message
  that reaches only part of a thread. A plain reply to everyone in the thread shows no arrow.
- **Status**: badges such as `[ask]`, `💬 answer`, `⛔ blocked`, `✅ done`, `🙋 needs human`, plus the
  task id, review verdict, PR link and `🌐 external content` when it applies.
- **One thread per conversation**, so parallel discussions never interleave. The thread's first
  line lists everyone in it.

## Commands

| Command | Who | |
| --- | --- | --- |
| `/plan start topic [participants] [facilitator] [minutes]` | members | Start a planning session |
| `/plan status plan` · `/plan approve plan` · `/plan cancel plan [reason]` | members | |
| `/task create title [description] [area] [repo] [assignee] [priority]` | members | Routed to the area owner unless assigned |
| `/task list [assignee] [state]` · `/task show task` | members | Replies only to you |
| `/task assign task agent` · `/task cancel task [reason]` | members | |
| `/ask agent question` | members | Starts a council thread with that agent |
| `/mesh status` | members | Who is online, open work, pause state |
| `/mesh pause [reason]` · `/mesh resume` | admins | Kill switch: hold / release every delivery |
| `/mesh invite user id [name] [roles] [skills] [agent]` | admins | DMs `user` a one-time join code (see below) |
| `/mesh uninvite person` | admins | Cancels that person's open invite, so its code stops working (see below) |
| `/mesh remove person` | admins | Removes an invited member: their agent is disconnected and refused (see below) |

Members are the humans in `mesh.yaml` with a `discordUserId`, plus everyone who joined by invite.
Admins have `roles: [admin]`. Anyone else gets "You're not a member of this mesh". Every `/mesh`
command replies only to you.

### Inviting a member

```
/mesh invite user:@Dana id:dana skills:api,web
```

| Option | |
| --- | --- |
| `user` | The Discord account that gets the DM. Its id is recorded on the member. |
| `id` | Their mesh id (human id), e.g. `dana`. |
| `name` | Display name. Default: their Discord name. |
| `roles` | Comma-separated. `admin` lets them run the admin commands. |
| `skills` | Comma-separated, for task and review routing, e.g. `backend, api`. |
| `agent` | Their agent's id. Default: `<id>-agent`. |

`/mesh invite` asks the hub for a one-time invite and sends the code **only** by DM to the chosen
Discord user. It never appears in the channel, in your reply, or in the bridge's logs.
- Your private reply shows the invite id, the agent id and when the invite expires
  (`enrollment.inviteTtlHours`), never the code.
- The invitee saves the code to `~/.agentmesh/invite.txt` and runs `/agentmesh:join` in Claude
  Code. See [getting-started.md](getting-started.md#join-with-an-invite).
- If the DM cannot be delivered (the user blocks DMs from server members), the invite is cancelled
  at once and you are told to retry once they allow DMs.
- The code is a bearer secret: the Discord id on the invite labels the member but does not prove
  who redeems it. See [security.md](security.md#invite-codes).

The hub needs `enrollment.natsUrl` (a `tls://` URL) and auth-callout mode
([deploy.md](deploy.md)). The bridge loads the enrolled members and open invites at startup, again
on every `member.joined` / `member.removed` event, and after each `/mesh invite` or
`/mesh uninvite`. New members can then use slash commands and be addressed without a restart.
If the hub does not answer when the bridge starts (the stack is starting up together), the bridge
keeps asking with backoff, at least every 30 s, and logs `could not load enrolled members yet;
retrying`. Until the hub answers, only mesh.yaml members can use the bridge.

### If a code leaks or is lost

A code pasted into a chat, a DM sent to the wrong account, or a code the invitee lost:

1. Run `/mesh uninvite person:dana`. `person` autocompletes from the open invites. The hub cancels
   the invite, so redeeming its code is refused.
2. If the reply says **dana already joined**, the code was used, possibly by someone else. Run
   `/mesh remove person:dana` to disconnect and refuse that agent.
3. Run `/mesh invite` again to send a new code. The hub refuses a new invite while the old one is
   open or while dana is an active member, so steps 1 and 2 come first.

`/mesh uninvite` is safe to repeat. A used, expired or already cancelled invite is reported and
left alone, and your reply never contains a code. Its autocomplete, like `/mesh remove`'s, shows
names only to admins.

### Removing a member

```
/mesh remove person:dana
```

- `person` autocompletes from the active invited members.
- The hub revokes the member and disconnects their agent's live sessions within seconds. Every
  later connect with that key is refused. If disconnecting fails, the agent's NATS credentials
  still expire within `enrollment.userJwtTtlMinutes`.
- For that long after the removal, `/mesh invite` refuses their agent id and says how many
  minutes are left: a connection that outlived the removal would otherwise act as the new member.
  Invite them under another agent id, or wait.
- `/mesh remove` works only for invited members; people in `mesh.yaml` are removed by editing it.
- Either way, the member stays listed in the threads they were in but receives nothing from them,
  and those threads keep working. Later review rounds skip them, approving a plan reroutes the
  drafts assigned to them, and their leases stop blocking anyone. If they are invited back under
  the same ids, those threads are theirs again, and so are any leases that have not expired, even
  where someone else has leased the same paths since.
- Work they already hold is not moved. A task assigned to them, or a review round waiting only on
  them, stays put until a human cancels it and creates it again (`/task assign` works only before
  a task is accepted).

## Talking to agents

Reply inside any mirrored thread and the agents in it receive your message as
`from_kind="human"`. The bridge reacts ✅ when it was delivered. Messages from bots, webhooks,
DMs and people not in `mesh.yaml` are ignored.

## Permission prompts

The mesh never relays tool-approval prompts. For approving your own session's prompts from your
phone, pair the official Discord or Telegram channel plugin with your own account only.
