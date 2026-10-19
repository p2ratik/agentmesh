# Deploying the hub

The hub is three small containers — NATS, the hub, the Discord bridge — on one always-on machine.
Claude Code sessions stay on developers' laptops; only the queue and coordinator run here.

## Size and cost

A 1–2 GB RAM VM is plenty (the hub and bridge use ~100–200 MB each; NATS less). Good fits:

- **AWS**: Lightsail (1 GB or 2 GB Linux plan) or EC2 `t4g.small` (ARM, Ubuntu).
- **Azure**: `B1s` or `B1ms` (Ubuntu).

Check current pricing in your region. Give it ~20 GB of disk (JetStream keeps undelivered
messages for `limits.deliveryRetentionDays`, 14 by default).

## 1. Prepare the VM

```bash
# Ubuntu: Docker + compose plugin
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# Tailscale: private network between the VM and the laptops
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4          # e.g. 100.101.102.103 — use it for NATS_BIND / HUB_HTTP_BIND
```

Firewall: allow only SSH from the internet (security group / NSG). NATS (4222) and the ingest
endpoint (8787) are reached over the tailnet.

## 2. Copy the mesh

Put the repository on the VM with:

- `config/` — your mesh config (from `agentmesh init`),
- `deploy/.env` — secrets and binds (from `.env.example`),
- `deploy/secrets/*.nk` — the hub, bridge and ingest seeds,
- `deploy/nats/nats.conf` — from `agentmesh nats-config`.

Seeds must be readable by uid 1000 (the containers run as the image's `node` user). On Ubuntu VMs
the first user already is uid 1000; otherwise `sudo chown 1000:1000 deploy/secrets/*.nk`.

In `deploy/.env` set `NATS_BIND` and `HUB_HTTP_BIND` to the VM's Tailscale IP.

## 3. Start

```bash
cd deploy
docker compose up -d --build                     # NATS + hub
docker compose --profile discord up -d --build   # + Discord bridge
docker compose ps
curl http://<tailscale-ip>:8787/healthz           # {"ok":true}
```

Laptops use `nats_url = nats://<vm-tailnet-name>:4222`. For invite-only onboarding, NATS needs a
public TLS endpoint instead; see
[Switching an existing deploy to invites](#switching-an-existing-deploy-to-invites---auth-callout).

## Public webhooks (optional)

GitHub can't reach a tailnet address. Either let Hermes (on the tailnet) forward events, or put a
TLS reverse proxy (Caddy, nginx) in front of `/v1/ingest/github` only. HMAC verification
(`auth: { type: hmac-sha256 }`) rejects anything not signed with your webhook secret.

## Operations

- **Logs**: `docker compose logs -f hub` (JSON lines; `AGENTMESH_LOG_LEVEL=debug` for more).
- **Config changes**: edit `config/`, run `agentmesh validate`, then `docker compose restart hub
  discord-bridge`. New agents get their NATS inbox automatically on restart.
- **New member**:
  - In auth-callout mode, an admin runs `/mesh invite` in Discord and the member runs
    `/agentmesh:join` ([getting-started.md](getting-started.md#join-with-an-invite)). Nothing
    changes on the VM. `/mesh remove` takes them off again.
  - Otherwise, and for every new service: `agentmesh keys add <id>`, `agentmesh nats-config`,
    then `docker compose kill -s HUP nats` (reload) and restart the hub.
- **Kill switch**: `/mesh pause` in Discord holds every delivery; `/mesh resume` releases them.
- **Backups**: the state is in two volumes. Stop the hub for a consistent copy
  (`docker compose stop hub`, then start it again):

  ```bash
  docker run --rm -v agentmesh_hub-data:/data -v $PWD:/backup alpine \
    tar czf /backup/hub-data-$(date +%F).tgz -C /data .
  docker run --rm -v agentmesh_nats-data:/data -v $PWD:/backup alpine \
    tar czf /backup/nats-data-$(date +%F).tgz -C /data .
  ```

- **Upgrades**: `git pull && docker compose up -d --build`. Hub migrations run on start
  (append-only), and JetStream streams/consumers are updated in place.

## Switching an existing deploy to invites (`--auth-callout`)

With `nats-config --auth-callout`, the hub admits agents itself (an auth callout) instead of
`nats.conf` listing every agent. That is what lets `/mesh invite` add members without a YAML
edit or a restart.

What you need:
- NATS on a public TLS endpoint;
- the three callout keys (`hub-issuer`, `hub-xkey`, `hub-sys`);
- `enrollment.natsUrl` set to the `tls://` address laptops use.

What stays the same:
- Agents already in mesh.yaml keep their keys: the callout admits them.
- The hub, the bridge and ingest stay static NATS users.

The switch moves everyone from NATS's default account (`$G`) to `APP`, so it needs a full restart
and a pause first.

**Follow [Migrating a live deploy in ADR-0005](adr/0005-team-registry-and-auth-callout.md#migrating-a-live-deploy).**
It is the single source for the steps: pausing and draining, the restart order, removing the old
`$G` streams, and rolling back. Read the threat notes in [security.md](security.md) first.

In this compose setup:
- The hub reads the three seeds from `AGENTMESH_SECRETS_DIR` (compose sets it to `/secrets`, which
  is `deploy/secrets`).
- The hub refuses to start if a seed is missing or does not match `hub.authCallout`.
- The JetStream store is in the `agentmesh_nats-data` volume.

While the hub is down, no agent can connect or reconnect; see
[security.md](security.md#the-hub-in-the-authentication-path-auth-callout-mode).
