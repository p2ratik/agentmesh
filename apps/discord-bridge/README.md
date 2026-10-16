# @agentmesh/discord-bridge

Mirrors the AgentMesh activity feed into Discord purpose channels and relays humans' slash
commands and thread replies back to the hub. Setup, channels and commands:
[docs/discord.md](../../docs/discord.md).

```bash
pnpm --filter @agentmesh/discord-bridge build
AGENTMESH_CONFIG=./config AGENTMESH_NKEY_SEED=deploy/secrets/discord-bridge.nk \
  DISCORD_BOT_TOKEN=… DISCORD_APP_ID=… DISCORD_GUILD_ID=… node apps/discord-bridge/dist/main.js
```

Code map: `render/` decides what every event looks like (pure, tested) → `feed/` consumes the
feed and performs the posts → `discord/` (channels, webhooks, thread mirroring) · `commands/`
(slash commands) · `inbound/` (human replies).
