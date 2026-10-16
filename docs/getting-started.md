# Getting started

From nothing to a team where every developer's Claude Code session is on the mesh. Plan about an
hour. Roles: one **mesh admin** (sets up the hub) and every **developer** (sets up their laptop).

## 1. Prerequisites

- Node 24 and pnpm 10 on the admin's machine (to run the `agentmesh` CLI).
- A small Linux VM for the hub (see [deploy.md](deploy.md)) with Docker.
- [Tailscale](https://tailscale.com) (or another private network) on the VM and every laptop.
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
areas and owners, and the git policy. Then:

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

Every process authenticates to NATS with its own nkey; mesh.yaml stores only public keys.

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

The admin runs `pnpm mesh agent-setup <agent-id> --config config --nats-url nats://<vm-tailnet-name>:4222`
and sends the output. In short:

```bash
claude plugin marketplace add <path or GitHub repo of AgentMesh>
claude plugin install agentmesh@agentmesh
```

Fill the plugin options when asked: `agent_id`, `nats_url`, `nkey_seed` (path to your `.nk`
file), `prefix`. Allow the mesh tools in `~/.claude/settings.json`:

```json
{ "permissions": { "allow": ["mcp__plugin_agentmesh_mesh__*"] } }
```

Start your session with the channel enabled:

```bash
claude --dangerously-load-development-channels plugin:agentmesh@agentmesh
```

(Once an org admin adds `agentmesh@agentmesh` to `allowedChannelPlugins`, use
`claude --channels plugin:agentmesh@agentmesh`.)

Check it: ask Claude to run `peers` — you should see your teammates and who is online.

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
