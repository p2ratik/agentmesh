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

Laptops use `nats_url = nats://<vm-tailnet-name>:4222`.

## Public webhooks (optional)

GitHub can't reach a tailnet address. Either let Hermes (on the tailnet) forward events, or put a
TLS reverse proxy (Caddy, nginx) in front of `/v1/ingest/github` only. HMAC verification
(`auth: { type: hmac-sha256 }`) rejects anything not signed with your webhook secret.

## Operations

- **Logs**: `docker compose logs -f hub` (JSON lines; `AGENTMESH_LOG_LEVEL=debug` for more).
- **Config changes**: edit `config/`, run `agentmesh validate`, then `docker compose restart hub
  discord-bridge`. New agents get their NATS inbox automatically on restart.
- **New participant**: `agentmesh keys add <id>`, `agentmesh nats-config`, then
  `docker compose kill -s HUP nats` (reload) and restart the hub.
- **Auth-callout mode** (invite-only onboarding): the hub admits agents itself instead of
  `nats.conf` listing them. Read `docs/security.md` before switching a live deploy. To switch:
  1. Run `agentmesh keys add hub-issuer`, `hub-xkey` and `hub-sys`
     (`--secrets deploy/secrets`), and set `enrollment.natsUrl` to the public `tls://` address.
  2. Render `agentmesh nats-config --tls --auth-callout`.
  3. Copy `config/`, `nats.conf` and the three new seeds to the VM.
  4. Restart NATS, then the hub. A full restart, not a reload: the accounts change. The hub reads
     the seeds from `AGENTMESH_SECRETS_DIR` (compose sets it to `/secrets`) and refuses to start if
     one is missing or does not match `hub.authCallout`.
  Existing agents keep their keys: the callout admits every key in mesh.yaml.
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
