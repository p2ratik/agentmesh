# Deploying the hub

The hub is three small containers — NATS, the hub, the Discord bridge — on one always-on machine.
Claude Code sessions stay on developers' laptops; only the queue and coordinator run here.

## Size and cost

A 1–2 GB RAM VM is plenty (the hub and bridge use ~100–200 MB each; NATS less). Good fits:

- **AWS**: Lightsail (1 GB or 2 GB Linux plan) or EC2 `t4g.small` (ARM, Ubuntu).
- **Azure**: `B1s` or `B1ms` (Ubuntu).

Check current pricing in your region. Give it ~20 GB of disk (the hub database holds undelivered
messages; JetStream keeps only the activity feed and ingest backlog).

## 1. Prepare the VM

```bash
# Ubuntu: Docker + compose plugin
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# Tailscale setup only: private network between the VM and the laptops
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4          # e.g. 100.101.102.103 — use it for NATS_BIND / HUB_HTTP_BIND
```

Firewall (Tailscale setup): allow only SSH from the internet (security group / NSG). NATS (4222)
and the ingest endpoint (8787) are reached over the tailnet. For invite-only onboarding, NATS is
public instead; see [Public TLS endpoint](#public-tls-endpoint-for-invites).

## 2. Copy the mesh

Put the repository on the VM with:

- `config/` — your mesh config (from `agentmesh init`),
- `deploy/.env` — secrets and binds (from `.env.example`),
- `deploy/secrets/*.nk` — the hub, bridge and ingest seeds,
- `deploy/nats/nats.conf` — from `agentmesh nats-config`.

Seeds must be readable by uid 1000 (the containers run as the image's `node` user). On Ubuntu VMs
the first user already is uid 1000; otherwise `sudo chown 1000:1000 deploy/secrets/*.nk`.

Tailscale setup: in `deploy/.env` set `NATS_BIND` and `HUB_HTTP_BIND` to the VM's Tailscale IP.
For invites, use the [public TLS endpoint](#public-tls-endpoint-for-invites) settings instead.

## 3. Start

```bash
cd deploy
docker compose up -d --build                     # NATS + hub
docker compose --profile discord up -d --build   # + Discord bridge
docker compose ps
curl http://<tailscale-ip>:8787/healthz           # {"ok":true}
```

Laptops use `nats_url = nats://<vm-tailnet-name>:4222`. For invite-only onboarding, NATS needs a
public TLS endpoint instead (next section).

## Public TLS endpoint (for invites)

Invites point laptops at `enrollment.natsUrl`, a `tls://` address on the internet, so NATS has to
be reachable there with a certificate for that name:

1. **Certificate:** put it in `deploy/nats/tls/` as `fullchain.pem` and `privkey.pem`.
   `deploy/azure/vm-setup.sh` gets one from Let's Encrypt and installs a renewal hook.
2. **`deploy/.env`:**
   - `NATS_BIND=0.0.0.0`, so compose publishes 4222 on every interface.
   - `NATS_PUBLIC_HOST=<the certificate's DNS name>`, e.g. `mesh.example.com`. Inside compose,
     the hub and the bridge then dial NATS by that name (a network alias), so TLS hostname
     verification passes.
   - Keep `HUB_HTTP_BIND=127.0.0.1`. The ingest endpoint stays private.
3. **`nats.conf`:** render it with `--tls` (and `--auth-callout` for invites):
   `agentmesh nats-config --config config --tls --auth-callout --out deploy/nats/nats.conf`.
4. **Firewall:** open only 4222/tcp and SSH from the internet.
5. **Apply:** `.env` changes (ports, the alias, environment) need recreated containers;
   `docker compose restart` does not apply them. Run
   `docker compose --profile discord up -d --force-recreate` (drop `--profile discord` without
   the bridge).

## Public webhooks (optional)

GitHub can't reach a tailnet address. Either let Hermes (on the tailnet) forward events, or put a
TLS reverse proxy (Caddy, nginx) in front of `/v1/ingest/github` only. HMAC verification
(`auth: { type: hmac-sha256 }`) rejects anything not signed with your webhook secret.

## Operations

- **Logs**: `docker compose logs -f hub` (JSON lines; `AGENTMESH_LOG_LEVEL=debug` for more).
- **Config changes**: edit `config/`, run `agentmesh validate`, then `docker compose restart hub
  discord-bridge`. New agents are picked up on restart.
- **Re-rendering `nats.conf`**: always use the flags the deploy was set up with. On an invite
  deploy that is `--tls --auth-callout`. A render without `--auth-callout` switches modes, which
  needs the [ADR-0005 procedure](adr/0005-team-registry-and-auth-callout.md#migrating-a-live-deploy).
  A plain reload of such a render locks invited members out and strands the `APP` streams.
- **New member**:
  - Auth-callout mode: an admin runs `/mesh invite` in Discord and the member runs
    `/agentmesh:join` ([getting-started.md](getting-started.md#join-with-an-invite)). Nothing
    changes on the VM. `/mesh remove` takes them off again.
  - Static mode: `agentmesh keys add <id>`, then
    `agentmesh nats-config --config config --out deploy/nats/nats.conf` (add `--tls` if the
    deploy uses it), then `docker compose kill -s HUP nats` (reload), then restart the hub.
- **New service** (an ingest source, a second bridge): `agentmesh keys add <id>`, re-render with
  the deploy's flags (above), `docker compose kill -s HUP nats`, then restart the hub.
- **Removing someone listed in mesh.yaml**: delete them from `config/mesh.yaml`, then:
  - Static mode: re-render with the deploy's flags, `docker compose kill -s HUP nats`, then
    restart the hub.
  - Auth-callout mode: restart the hub. Their next connect is refused, but a session that is
    already connected lasts until its NATS credentials expire (`enrollment.userJwtTtlMinutes`).
  - Invited members are removed with `/mesh remove` instead.
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
  - **To per-session delivery (plugin 0.2.0),** in this order
    ([ADR 0006](adr/0006-per-session-delivery.md)):
    1. `git pull`.
    2. Static mode only: agents need new NATS permissions (their session and ack subjects).
       Re-render `nats.conf` with the deploy's flags, for example
       `agentmesh nats-config --config config --tls --out deploy/nats/nats.conf`, then reload
       NATS with `docker compose kill -s HUP nats`, before restarting the hub. Without this a
       plugin cannot listen on its session, and `/agentmesh:activate` fails with a hint about
       NATS permissions.
    3. `docker compose up -d --build` restarts the hub.
    4. Every member updates the plugin (`claude plugin update agentmesh@agentmesh`) and restarts
       their Claude Code sessions. In auth-callout mode that restart also gives each plugin a new
       user JWT carrying the new permissions.

    The hub refuses `session.hello` from older plugins, and their other calls with the same
    update instruction. On start the hub deletes the old `{P}_DELIVERY` stream; anything still
    queued there is not pushed, but it stays in the hub database and members read it with `inbox`.
    Each session must then run `/agentmesh:activate` to receive messages.
    `limits.deliveryRetentionDays` is ignored now and can be dropped from `mesh.yaml`.
  - **To plugin 0.3.0 (delivery classes, FYI ride-along).** The new hub refuses plugins older than
    0.3.0, so update the plugins first, then the hub. A 0.3.0 plugin works against a 0.2.x hub
    (everything arrives as action, as before), so nobody is refused in between:
    1. Every member updates the plugin (`claude plugin update agentmesh@agentmesh`, once per Claude
       config directory) and restarts their sessions.
    2. `git pull` and `docker compose up -d --build` restart the hub.

    No NATS permission change is needed.

## Switching an existing deploy to invites (`--auth-callout`)

With `nats-config --auth-callout`, the hub admits agents itself (an auth callout) instead of
`nats.conf` listing every agent. That is what lets `/mesh invite` add members without a YAML
edit or a restart.

What you need:
- NATS on a [public TLS endpoint](#public-tls-endpoint-for-invites) (`.env` binds, the
  certificate, the firewall);
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
