# Deploying the hub

The hub is three small containers — NATS, the hub, the Discord bridge — on one always-on machine.
Claude Code sessions stay on developers' laptops; only the queue and coordinator run here.

There are two ways to run it:
- **`/agentmesh:setup`** (recommended). The admin answers Claude's questions, and the `agentmesh`
  CLI bundled in the plugin prepares any Ubuntu server over SSH, copies a workspace folder to it
  and starts the published images. See [getting-started.md](getting-started.md) and
  [ADR 0007](adr/0007-claude-run-setup.md).
- **By hand from this repository.** The repo's `deploy/docker-compose.yml` still builds the images
  from source. It is for contributors and for deploys set up by hand before setup existed; see
  [Deploying by hand](#deploying-by-hand).

In the commands below, `agentmesh` is `node <plugin dir>/dist/cli.js`. The plugin dir is under
`~/.claude/plugins/cache/agentmesh/agentmesh/<version>/`; use the newest version, and never
`npx agentmesh` (an unrelated npm package). The commands the CLI prints in its hints, and the
workspace's `CLAUDE.md`, name the exact path it ran from. Every setup command takes
`--dir <workspace>` (default `~/agentmesh/<team>`).

## The server

What setup expects, and what Claude proposes when it creates a new cloud server:

- **Ubuntu 24.04 LTS** (the tested target), **1–2 GB RAM** and **about 20 GB of disk**. The hub and
  bridge use ~100–200 MB each, NATS less. The hub database holds undelivered messages; JetStream
  keeps only the activity feed and ingest backlog.
- **A static public IP and a DNS name** that points at it.
- **SSH key login.** `ssh` and `scp` run without prompts (`BatchMode=yes`), so the admin's key must
  work without one, for example through an ssh agent. If you can read the server's host key
  fingerprint (in the cloud console), connect once with plain `ssh` and compare it. Then test the
  key the way setup connects:
  `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -- <user@host> true`. On Windows, run
  that test with `%SystemRoot%\System32\OpenSSH\ssh.exe`, the binary the CLI uses. The user
  needs `sudo` without a password. They give up after 15 seconds when port 22 does not answer, and
  never reuse a shared connection (`ControlPath=none`). On Windows, setup runs the system OpenSSH
  (`%SystemRoot%\System32\OpenSSH\ssh.exe` and `scp.exe`) when it is installed, because only that
  one can use keys loaded into the Windows `ssh-agent` service; Git for Windows' `ssh` cannot.
- **Inbound traffic:** port 22 from the admin's IP only, and ports 4222 (NATS over TLS) and 80
  (Let's Encrypt) from anywhere.

Good fits: AWS Lightsail (1 GB or 2 GB Linux plan) or EC2 `t4g.small` (ARM); Azure `B1s`, `B1ms`
or `Standard_B2als_v2`. Check current pricing in your region.

**The DNS name** is one of:
- **your own subdomain**, with an A record pointing at the server. `setup host` refuses to start
  until the name resolves.
- **the provider's free name, where one exists**, such as Azure's
  `<label>.<region>.cloudapp.azure.com`. AWS's `amazonaws.com` names cannot get a Let's Encrypt
  certificate, so on AWS use your own domain.

**Creating it.** For a new cloud server, Claude writes the provider commands from this list for the
admin's own cloud CLI, shows each one and runs nothing that costs money before the admin says yes.
`deploy/azure/provision.sh` stays as the tested Azure reference. There is no script per provider.

## What setup does on the server

- **`agentmesh setup host`** checks that the DNS name resolves, then pipes a script to
  `sudo bash -s` over SSH. The script is safe to re-run. It:
  - refuses a server without `apt-get`;
  - waits for cloud-init, and up to 5 minutes for apt's lock (`DPkg::Lock::Timeout` in
    `/etc/apt/apt.conf.d/90agentmesh-lock-timeout`), which a new server's updates hold;
  - installs Docker and certbot, and adds the SSH user to the `docker` group. A Docker without
    Compose v2 (Ubuntu's `docker.io` alone) stops it: install `docker-compose-v2` and re-run;
  - creates `<remoteDir>` (default `/opt/agentmesh`) with `deploy/`, `deploy/nats/`,
    `deploy/secrets/` and `config/`, owned by the SSH user;
  - gets a Let's Encrypt certificate with `certbot certonly --standalone` when there is none yet,
    and installs the renewal hook (`/etc/letsencrypt/renewal-hooks/deploy/agentmesh-nats.sh`) that
    copies it to `deploy/nats/tls/` and reloads NATS.
- **`agentmesh setup deploy`**:
  1. checks the config with the workspace's real `deploy/.env` values, so an empty token,
     application id or server id fails before anything is copied, and checks that every seed the
     server needs exists;
  2. closes `<remoteDir>/deploy` to other users (`chmod 700`) and takes back the seeds a previous
     deploy gave to uid 1000;
  3. copies `config/` to a fresh `<remoteDir>/config.new`, and `deploy/docker-compose.yml`,
     `deploy/.env`, `deploy/nats/nats.conf` and `deploy/secrets/*.nk` with `scp`;
  4. replaces the server's `config/` with `config.new`, so a file deleted from the workspace is
     gone there too (the hub loads every YAML file in the include folders), and a copy that fails
     halfway leaves the old `config/` in place;
  5. sets `.env` and the seeds to mode 600, gives the seeds to uid 1000 (the containers' user), and
     runs `docker compose --profile discord pull` and `up -d --force-recreate` in
     `<remoteDir>/deploy`.

  On a trial it runs the same pull and `up -d --force-recreate` in the workspace's `deploy/`. A
  failed step is not marked done, and a re-run continues.
- **A server rebuilt under the same name.** `ssh` first refuses its new host key. Check the new
  fingerprint (in the provider's console), remove the old one with `ssh-keygen -R <host>`, then
  run `setup host` again: `setup deploy` stops while `<remoteDir>/deploy/secrets` is missing.
- **Every deploy restarts the stack.** NATS, the hub and the bridge read `config/`, `nats.conf`
  and the seeds only when they start, and a plain `up -d` keeps a container whose image and
  compose settings did not change. So `setup deploy` recreates all three containers, even when only
  `config/` changed. Agents lose their connection for a few seconds and reconnect on their own.
- **The mode.** A server runs NATS with TLS in auth-callout mode (`nats-config --tls
  --auth-callout`), so members join by invite. The hub's HTTP port stays on 127.0.0.1, and a new
  mesh has no ingest sources. A trial runs NATS on 127.0.0.1 without TLS, in static mode.

## Published images and versions

- **CI publishes the images.** When a version bump reaches `main`, the release workflow builds
  `ghcr.io/<owner>/agentmesh-hub:<version>` and `ghcr.io/<owner>/agentmesh-discord-bridge:<version>`
  for linux/amd64 and linux/arm64, pushes them and tags the commit `v<version>`. Every package,
  the plugin and the images share one version.
- **The workspace's compose file pulls them:**
  `${AGENTMESH_IMAGE_REGISTRY}/agentmesh-hub:${AGENTMESH_VERSION}` and the bridge image, both
  values from the workspace's `deploy/.env` ([configuration.md](configuration.md#deployenv)).
  - `AGENTMESH_IMAGE_REGISTRY` defaults to `ghcr.io/p2ratik`. `setup render --registry <r>` sets
    another on the first render, for example a registry where you push images you built yourself
    (`docker build -f deploy/Dockerfile --target hub .` and `--target discord-bridge`).
  - `AGENTMESH_VERSION` is the pin: the plugin's version when setup rendered the workspace.
    `setup deploy` always uses it, so updating the plugin never upgrades the hub silently.
- **A failed pull** names the image it tried and the two settings, so you can check that the
  version exists in that registry. A value in those two lines that is not a registry or a
  version (the bot token pasted on the wrong line, say) stops `setup deploy` before anything
  runs, and is never printed.

## Upgrading a setup deploy

```bash
agentmesh upgrade --dir <workspace> [--to <version>]
```

It sets `AGENTMESH_VERSION` to `--to`, or to the CLI's own version, prints
`Hub version <old> → <new>`, then runs `setup deploy`. If that deploy fails (a version not yet
published, say), the old version goes back into `deploy/.env`, so later config-only deploys keep
working. Nothing else moves the pin. Hub migrations
run on start. When a release raises the hub's minimum plugin version (as 0.3.0 did), members
update their plugins first.

## Checking and changing a setup deploy

- **`agentmesh doctor --dir <workspace>`** prints a ✓ or ✗ line per check, with what to do for
  each ✗, and exits 1 if any fails. It changes nothing. It checks that:
  - the DNS name resolves and NATS answers TLS on 4222 with a certificate clients accept, valid
    for at least 14 more days (a server only);
  - `nats`, `hub` and `discord-bridge` are running and the hub is healthy (`docker compose ps`,
    over ssh on a server);
  - the Discord server has the category and channels the config names. It reads the bot token
    and `DISCORD_GUILD_ID` from `deploy/.env` and never prints them; a `DISCORD_GUILD_ID` that is
    not a Discord id (digits) is refused without being echoed;
  - the admin's agent key connects to NATS.
- **`agentmesh setup status --dir <workspace>`** shows which steps are done and what to run next.
- **Config changes.** The workspace is the source of truth. Edit the files in `config/`, then run
  `agentmesh setup deploy --dir <workspace>`. It checks the config with the real `.env` values
  before it copies anything, then recreates the containers, so the hub loads the new config.
  `agentmesh validate` does not work in a workspace: it reads only the shell's environment, not
  `deploy/.env`, so it reports the Discord values as missing.
- **Members** join and leave with `/mesh invite`, `/mesh uninvite` and `/mesh remove`; nothing
  changes on the server.

## Deploying by hand

The rest of this page is the manual path with the repo's own `deploy/docker-compose.yml`, which
builds the images from source on the VM. Contributors use it, and so do deploys set up before
`/agentmesh:setup` existed.

**Follow-up for these deploys:** the repo's compose file still mounts the whole `deploy/secrets/`
folder into the Discord bridge. The compose file setup renders mounts only `discord-bridge.nk`
there ([security.md](security.md#setup-and-the-admin-workspace)); apply the same mount at your next
redeploy.

### 1. Prepare the VM

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

### 2. Copy the mesh

Put the repository on the VM with:

- `config/` — your mesh config (from `agentmesh init`),
- `deploy/.env` — secrets and binds (from `.env.example`),
- `deploy/secrets/*.nk` — the hub, bridge and ingest seeds,
- `deploy/nats/nats.conf` — from `agentmesh nats-config`.

Seeds must be readable by uid 1000 (the containers run as the image's `node` user). On Ubuntu VMs
the first user already is uid 1000; otherwise `sudo chown 1000:1000 deploy/secrets/*.nk`.

Tailscale setup: in `deploy/.env` set `NATS_BIND` and `HUB_HTTP_BIND` to the VM's Tailscale IP.
For invites, use the [public TLS endpoint](#public-tls-endpoint-for-invites) settings instead.

### 3. Start

```bash
cd deploy
docker compose up -d --build                     # NATS + hub
docker compose --profile discord up -d --build   # + Discord bridge
docker compose ps
curl http://<tailscale-ip>:8787/healthz           # {"ok":true}
```

Laptops use `nats_url = nats://<vm-tailnet-name>:4222`. For invite-only onboarding, NATS needs a
public TLS endpoint instead (next section).

### Public TLS endpoint (for invites)

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

### Public webhooks (optional)

GitHub can't reach a tailnet address. Either let Hermes (on the tailnet) forward events, or put a
TLS reverse proxy (Caddy, nginx) in front of `/v1/ingest/github` only. HMAC verification
(`auth: { type: hmac-sha256 }`) rejects anything not signed with your webhook secret.

## Operations

These apply to both kinds of deploy. Run the `docker compose` commands in the deploy folder on the
server (`/opt/agentmesh/deploy` for a setup deploy). A setup deploy changes its config and
version through its workspace instead ([above](#checking-and-changing-a-setup-deploy)).

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

- **Upgrades** (by hand; a setup deploy runs [`agentmesh upgrade`](#upgrading-a-setup-deploy)):
  `git pull && docker compose up -d --build`. Hub migrations run on start
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
