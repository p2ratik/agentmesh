# Getting started

From nothing to a team where every developer's Claude Code session is on the mesh. Plan about an
hour. Roles: one **mesh admin** (sets up the hub) and every **developer** (sets up their laptop).

## 1. Prerequisites

- Node 24 and pnpm 10 on the admin's machine (to run the `agentmesh` CLI).
- A small Linux VM for the hub (see [deploy.md](deploy.md)) with Docker.
- For invite-only onboarding: a DNS name for the VM with a TLS certificate for NATS. Without
  invites: [Tailscale](https://tailscale.com) (or another private network) on the VM and every
  laptop.
- Claude Code with Anthropic authentication (claude.ai or a Console API key). On Team/Enterprise
  plans an Owner must enable **Channels** (Organization settings → Claude Code → Channels).
- A Discord server where you can add a bot.

## 2. Create the config (admin)

```bash
git clone <your AgentMesh fork> && cd AgentMesh
pnpm install && pnpm build
pnpm mesh init config            # copies config/examples → config/
```

Edit `config/mesh.yaml`: your humans (with Discord user ids), one agent per person, your code
areas and owners, and the git policy. If members will join by invite (step 4), list only the
admin(s): `/mesh invite` refuses any id or Discord account that mesh.yaml already has. Areas can
still name the agents of people you will invite (`owners: [dana-agent]` for `id:dana`). They
become owners when they join. Then:

```bash
cp deploy/.env.example deploy/.env      # fill HERMES_INGEST_TOKEN etc. (openssl rand -hex 24)
set -a; . deploy/.env; set +a
pnpm mesh validate --config config
```

Every problem is reported with its path (`agents[1].owner: unknown human "bobb"`).

## 3. Discord bot (admin)

Follow [discord.md](discord.md): create the application, enable the **Message Content** intent,
invite the bot, put its token/application id/guild id in `deploy/.env`, and set
`discord.enabled: true`.

## 4. Keys and NATS config (admin)

Every process authenticates to NATS with its own nkey; mesh.yaml stores only public keys. First
decide how members join:

- **By invite** (recommended). An admin runs `/mesh invite` in Discord. The member's laptop
  generates its own key, so no seed is handed over, mesh.yaml is not edited and nothing restarts.
  This needs NATS on a public TLS endpoint (`tls://`) and auth-callout mode.
- **By mesh.yaml**. You list every agent, generate each seed and send it privately. This works
  on a private network such as Tailscale without TLS.

You can mix the two: in auth-callout mode, the agents listed in mesh.yaml still connect with
their own keys.

### With invites

```bash
for id in hub discord-bridge hermes hub-issuer hub-xkey hub-sys; do
  pnpm mesh keys add $id --config config --secrets deploy/secrets
done
pnpm mesh nats-config --config config --tls --auth-callout --out deploy/nats/nats.conf
```

- `hub-issuer`, `hub-xkey` and `hub-sys` are the hub's callout keys. `keys add` writes their
  public keys into `hub.authCallout`.
- In mesh.yaml, set `enrollment.natsUrl` to the address laptops connect to, for example
  `tls://mesh.example.com:4222`. It goes into every invite.
- Use `tls://`. The protocol also accepts `wss://`, but the plugin refuses websocket invites until
  its NATS client supports them.
- Keep at least one human with `roles: [admin]` and a `discordUserId` in mesh.yaml: only admins
  can run `/mesh invite`.

Then expose NATS on that address: the `deploy/.env` binds, the certificate files and the firewall
are in [deploy.md → Public TLS endpoint](deploy.md#public-tls-endpoint-for-invites).

All seeds stay on the VM.

### With mesh.yaml only

```bash
for id in hub discord-bridge hermes alice-agent bob-agent carol-agent; do
  pnpm mesh keys add $id --config config --secrets deploy/secrets
done
pnpm mesh nats-config --config config --out deploy/nats/nats.conf
```

Each agent's seed (`deploy/secrets/<agent>.nk`) goes to its owner over a private channel. The
hub, bridge and ingest seeds stay on the VM.

## 5. Start the hub (admin, on the VM)

Copy the repo (with `config/`, `deploy/.env`, `deploy/secrets`, `deploy/nats/nats.conf`) to the
VM, then:

```bash
cd deploy
docker compose --profile discord up -d --build
docker compose logs -f hub        # "mesh topology ready" … "agentmesh hub started"
```

Discord now shows an **Agent Mesh** category with the purpose channels.

## 6. Each developer's laptop

Install the plugin and allow its tools (`~/.claude/settings.json`):

```bash
claude plugin marketplace add <path or GitHub repo of AgentMesh>
claude plugin install agentmesh@agentmesh
```

```json
{ "permissions": { "allow": ["mcp__plugin_agentmesh_mesh__*"] } }
```

Then either join with an invite or fill in the options by hand.

### Join with an invite

1. An admin runs `/mesh invite user:@dana id:dana skills:api` in Discord (options:
   [discord.md](discord.md#inviting-a-member)). The bot DMs you a one-time code. It works once
   and expires after `enrollment.inviteTtlHours` (24 hours by default).
2. Leave every plugin option empty when Claude Code asks for them.
3. Save the code from the DM to `~/.agentmesh/invite.txt`. Never paste it into a chat: it is a
   one-time secret, and Claude is told never to ask for it.
4. Start Claude Code with the channel enabled (below) and run `/agentmesh:join`.
5. Claude shows which hub the invite points at, such as `mesh.example.com:4222`, and asks whether
   it is your team's hub. Confirm only if it is. A forged invite could point at someone else's
   hub.

The plugin then:
- generates your key on this laptop and enrolls with the hub;
- deletes `invite.txt`;
- writes `~/.agentmesh/agent.json` and `~/.agentmesh/<agent-id>.nk`;
- switches to the mesh tools in the same session.

From then on, the plugin connects with that key alone.

To join from a terminal instead, so nothing goes through Claude:

```bash
node <plugin dir>/dist/server.js join --file ~/.agentmesh/invite.txt
```

The plugin dir is under `~/.claude/plugins/cache/agentmesh/agentmesh/<version>/`. Without
`--file`, the command asks you to paste the code into the terminal. `--yes` skips the hub
question.

If the hub refuses, the message is the same whatever the reason (used, expired, cancelled or
another hub's invite): ask your admin for a new invite. If the laptop is already set up for
another mesh, Claude asks you before replacing it. From a terminal, add `--replace`.

If you pasted the code somewhere, lost it, or it reached the wrong person, tell your admin right
away. They run `/mesh uninvite person:<your id>`, which stops the code working. If it says you
already joined, someone used the code, so they run `/mesh remove` first. Then they send a new
invite ([discord.md](discord.md#if-a-code-leaks-or-is-lost)).

### Configure by hand (mesh.yaml)

The admin runs `pnpm mesh agent-setup <agent-id> --config config --nats-url nats://<vm-tailnet-name>:4222`
and sends you the output. Fill the plugin options when asked: `agent_id`, `nats_url`,
`nkey_seed` (the path to your `.nk` file) and `prefix`.

### Start a session

```bash
claude --dangerously-load-development-channels plugin:agentmesh@agentmesh
```

(Once an org admin adds `agentmesh@agentmesh` to `allowedChannelPlugins`, use
`claude --channels plugin:agentmesh@agentmesh`.)

**Claude Desktop is pull-only.** Pushes need the channel flag, and Claude Code turns channels on
only from the command line, so the Desktop app's Code tab cannot receive them. The plugin and its
tools still work there without activation: ask Claude to call `inbox` to read your messages, and
`task_get`, `task_act`, `review_submit` or `reply` to act on them. The hub keeps every message
until it is read. Do not run `/agentmesh:activate` in Desktop: the test message never arrives. To
receive pushes, start a session from a terminal with the command above (PowerShell on Windows).

Check it: ask Claude to run `peers` — you should see your teammates and who is online.

Then run `/agentmesh:activate` in each session that should receive mesh messages. The hub sends
the session a test message, and the session goes live once Claude confirms it arrived. If it does
not arrive, the session was started without the channel flag: restart it with the command above
(in Claude Desktop you cannot; see above). If Claude reports that the hub could not reach the session, try again in a few seconds. If it keeps
failing, the NATS permissions predate plugin 0.2.0: in static mode the admin re-renders nats.conf
and reloads NATS ([deploy.md](deploy.md#operations)); in auth-callout mode, restart Claude Code.
Sessions you do not activate stay inactive: the mesh tools still work, but nothing is pushed to
them, and teammates do not see them.
`/agentmesh:deactivate` turns a session off again and releases the work it owns, and
`/agentmesh:take <task or thread>` moves work to the session where you type it.

To take someone off the mesh, an admin runs `/mesh remove person:dana`. Their agent is
disconnected within seconds and refused from then on. People listed in mesh.yaml are removed by
editing it, followed by a re-render or a hub restart. The steps differ by mode; see
[deploy.md](deploy.md#operations).

## 7. First run

- In Discord: `/ask agent:bob-agent question:What's left on the render queue?`
- `/task create title:Add retries to the queue consumer area:api`
- `/plan start topic:Render status end to end` — watch the agents propose and discuss in the
  planning forum; the facilitator's plan becomes tasks.
- `/mesh status` shows who is online and what is open. `/mesh pause` is the kill switch.

## Branch protection (recommended)

Agents push with their owners' credentials. Protect `main` so a pull request needs a human
CODEOWNER's approval, and let agents merge into `agents` after peer review. See
[security.md](security.md).
