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
  - turns on automatic security updates and installs the per-IP limits on new NATS connections
    ([Hardening the server](#hardening-the-server));
  - creates `<remoteDir>` (default `/opt/agentmesh`) with `deploy/`, `deploy/nats/`,
    `deploy/secrets/` and `config/`, owned by the SSH user;
  - gets a Let's Encrypt certificate with `certbot certonly --standalone` when there is none yet,
    and installs the renewal hook (`/etc/letsencrypt/renewal-hooks/deploy/agentmesh-nats.sh`) that
    copies it to `deploy/nats/tls/` and reloads NATS;
  - warns, and changes nothing, when `sshd` accepts password logins or root password logins.
    `setup host` prints these warnings after it succeeds.
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

## Hardening the server

Both kinds of deploy get the same hardening. The repo's `deploy/docker-compose.yml` and the one
setup renders differ only in building versus pulling the images (a test keeps them in step);
`agentmesh nats-config` renders the NATS limits in every mode; `setup host` and
`deploy/azure/vm-setup.sh` run the same host steps. The threats are in
[security.md](security.md#the-servers-network-surface-and-limits).

### Containers

- **No privileges.** Every service has `cap_drop: [ALL]`, `security_opt: ["no-new-privileges:true"]`
  and `read_only: true`. Writes go to the service's volume (`/data`) and a small `/tmp` tmpfs:
  64 MB for the hub, where SQLite may spill temporary tables, 16 MB for the others.
- **NATS runs as root** (the image's default), but without capabilities it reads only files root
  owns and world-readable ones. Keep `nats.conf` readable by everyone (it holds only public keys;
  `setup deploy` sets it to 644) and the TLS files owned by root, as the renewal hook installs
  them. A key you copied in yourself, owned by another user with mode 600, stops NATS from
  starting. Running NATS as uid 1000 instead would need the `nats-data` volume and the key
  handed to that user first; it is not done yet.
- **Memory and process caps**, from `deploy/.env` (the compose file has the same defaults). A
  container that reaches its cap is killed and restarted instead of starving sshd and Docker. They
  are ceilings, not reservations, so together they may exceed a 1 GB server's memory. Raise them on
  a bigger server or for a much bigger team.

  | Variable | Default | Why |
  | --- | --- | --- |
  | `NATS_MEM_LIMIT` | `256m` | NATS uses tens of MB for a team; the rest absorbs 1 MB messages and reconnect bursts. |
  | `HUB_MEM_LIMIT` | `512m` | The hub runs at 100–200 MB. |
  | `BRIDGE_MEM_LIMIT` | `384m` | The bridge runs at 100–200 MB. |
  | `PIDS_LIMIT` | `256` | Processes and threads per container; Node uses about 20, NATS a few dozen. |
- **Rotated logs.** Docker's default log never rotates, so a log flood would fill the disk. Each
  service logs with `json-file`, `max-size: 10m`, `max-file: 3`: at most 30 MB.
  `docker compose logs` works as before and shows what is left.

### NATS

`agentmesh nats-config` writes these lines in static, auth-callout and dev mode:

```
max_connections: 1024
max_subscriptions: 100
max_payload: 1MB

jetstream {
  ...
  strict: true
}
```

- **`max_connections: 1024`.** Each Claude Code session is one connection and the hub and each
  service one or two, so a team of 15 uses under 100. `--max-connections <n>` changes it.
- **`max_subscriptions: 100`**, per connection. An agent holds two, the hub and the bridge a handful.
- **`max_payload: 1MB`** is NATS's default, which the hub sizes its deliveries to. It is written out
  so that it is never raised by accident.
- **`strict: true`** pins JetStream's strict mode, which NATS 2.15 already defaults to: the
  JetStream API refuses malformed requests instead of guessing.
- Pings and the write deadline keep NATS's defaults (every 2 minutes; 10 seconds).

### Host firewall

Docker publishes port 4222 through its own iptables rules, which ufw and the INPUT chain never see.
So `setup host` and `vm-setup.sh` put per-source-IP limits in Docker's `DOCKER-USER` chain:

```
iptables -N AGENTMESH-NATS
iptables -A AGENTMESH-NATS -p tcp -m connlimit --connlimit-above 128 --connlimit-mask 32 \
  -j REJECT --reject-with tcp-reset
iptables -A AGENTMESH-NATS -m hashlimit --hashlimit-above 10/sec --hashlimit-burst 100 \
  --hashlimit-mode srcip --hashlimit-name agentmesh-nats -j DROP
iptables -A AGENTMESH-NATS -j RETURN
iptables -I DOCKER-USER 1 -i <default-route interface> -p tcp -m conntrack --ctstate NEW \
  --ctorigdstport 4222 --ctdir ORIGINAL -j AGENTMESH-NATS
```

- **What is checked:** only new TCP connections to port 4222 that arrive on the interface with the
  default route. The hub and the bridge reach NATS over the compose network and never match, and
  neither does a tailnet (`tailscale0`).
- **The limits, per source IP:** at most 128 open connections (more get a TCP reset), and at most 10
  new connections a second, in bursts of up to 100 (more are dropped, and the client's TCP retries).
- **Why these numbers:** a whole office behind one NAT, 15 people with 3 sessions each, holds 45
  connections and reconnects inside one burst after a restart. While the hub is down in
  auth-callout mode, those clients retry every 2–3 seconds, about 20 a second: the limit slows the
  retries but never locks them out, and they are all back within seconds of the hub. A single host
  flooding the port gets 10 TLS handshakes a second.
- **Persistence:** `/usr/local/sbin/agentmesh-firewall` rebuilds the rules from scratch, so it is
  safe to re-run, and `agentmesh-firewall.service` runs it after Docker starts: at boot and after
  every Docker restart. Check with `sudo iptables -S AGENTMESH-NATS`, `sudo iptables -S DOCKER-USER`
  and `systemctl status agentmesh-firewall`.
- **Changing a value:** set it in `/etc/default/agentmesh-firewall`, which setup never writes
  (`NATS_MAX_CONN_PER_IP=256`, `NATS_NEW_CONN_RATE=20/sec`, `NATS_NEW_CONN_BURST=200`, or
  `EXT_IF=eth1` when the default route is not the public interface), then
  `sudo systemctl restart agentmesh-firewall`.
- **Limits of the rules:** IPv4 only; `NATS_BIND=0.0.0.0` publishes NATS on IPv4 alone, so if you
  publish it on IPv6, add the same rules with `ip6tables`. Docker's nftables firewall backend has
  no `DOCKER-USER` chain; the script then stops and says so.

### Updates and SSH

- **Security updates:** `unattended-upgrades` is installed and turned on
  (`/etc/apt/apt.conf.d/90agentmesh-auto-upgrades` and the apt-daily timers). Ubuntu's defaults
  install security updates only and never reboot, and Docker's own repository is not among them, so
  Docker is never upgraded or restarted under the hub. Reboot for kernel updates yourself when
  `/var/run/reboot-required` exists. A later file in `/etc/apt/apt.conf.d` that turns it off wins,
  with a warning.
- **SSH:** the script warns when `sshd -T` shows `passwordauthentication yes` or
  `permitrootlogin yes`, and never changes sshd: on an existing server that could lock you out.
  Once key login works, add a file in `/etc/ssh/sshd_config.d/` with `PasswordAuthentication no`
  and `PermitRootLogin prohibit-password`, then `sudo systemctl reload ssh`.

### Applying it to an existing deploy

- **A setup deploy:**
  1. Update the plugin, so the CLI has the new files.
  2. Run `agentmesh setup host --dir <workspace>` (safe to re-run) for the updates and the firewall.
  3. Get the new compose file: a workspace keeps the one it was first rendered with. If you never
     edited the rendered files by hand, `agentmesh setup render --dir <workspace> --force` rewrites
     them and `nats.conf`; it keeps `.env` and the keys, and in `mesh.yaml` only the public keys and
     your Discord id (it renders the rest from `setup-answers.json` again). It names the four caps as
     missing from `.env`; adding them is optional. Otherwise copy the `x-logging` block and each
     service's `cap_drop` … `logging` lines from the repo's `deploy/docker-compose.yml`, and run
     `agentmesh nats-config --config config --tls --auth-callout --out deploy/nats/nats.conf`.
  4. Run `agentmesh setup deploy --dir <workspace>`.
- **A deploy by hand:**
  1. `git pull`.
  2. `sudo PUBLIC_HOST=<the DNS name> ./deploy/azure/vm-setup.sh` (safe to re-run; on another
     provider, run its update, firewall and ssh steps).
  3. Re-render `nats.conf` with the deploy's flags, for example
     `agentmesh nats-config --config config --tls --auth-callout --out deploy/nats/nats.conf`.
  4. With the Discord bridge, check that `deploy/secrets/discord-bridge.nk` exists: the bridge now
     mounts only that file, and Docker would put an empty directory in place of a missing one.
  5. Optionally add the caps to `deploy/.env` (see `.env.example`).
  6. `docker compose --profile discord up -d --build --force-recreate`, then `docker compose ps`.

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

**To 0.4.4 (reads).** Inactive sessions no longer read team work through `inbox`; they only see it
counted ("N team thread(s) are waiting…"). Claude Desktop members must be on plugin 0.4.2 or later
and activate with pull; a pull session takes team work only while no push session of the agent is
ready. Threads an inactive session already owned stay held for it until it closes or deactivates.

**To 0.5.0 (the mesh window).** The hub adds migration 007 (`sessions.mesh_window`) and routes
unowned work to a member's mesh window first. It still accepts plugins from 0.3.0 on, and a 0.5.0
plugin works with an older hub, which ignores the window's flag. Upgrade the hub first: a window
started before the upgrade keeps the session the old hub stored unflagged, so team work doesn't
prefer it until its plugin says hello again; restart any window started before the hub upgrade.
Each member then:
1. updates the plugin and Claude Code (2.1.295 or later), with `node` on PATH. The plugin's guard
   hook runs on every edit and shell call in every session, and blocks them if it can't start;
2. runs `/agentmesh:window` once, and starts the window each day
   ([getting-started.md](getting-started.md#your-mesh-window));
3. deactivates the other sessions they had activated, and turns off any Desktop inbox poll.

**To 0.6.0 (answers for private sessions).** The hub adds migration 008
(`sessions.private_at_close`, `sessions.claude_session_id`, `orphan_decisions`) and the
`relay.closedAskerEscalationMinutes` option (default 15). It still accepts plugins from 0.3.0 on;
a 0.5.0 window gets no relay pointers and no closed-asker marks, so it works as before. Upgrade
the hub first (with [automatic deploys](adr/0010-automatic-deploys.md), merging the release to
`main` does it). Each member then updates the plugin and restarts their mesh window and open
sessions, so the window runs the 0.6.0 guard and the sessions write their local records. The relay
runs on Windows only; elsewhere a private session learns of an answer from the AgentMesh line on
its next prompt.

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

## Automatic deploys

A hub that runs from a checkout of this repository ([by hand](#deploying-by-hand)) can deploy every
release by itself from GitHub Actions, so nobody SSHes in to upgrade it
([ADR 0010](adr/0010-automatic-deploys.md)). A setup deploy upgrades with `agentmesh upgrade`.

**On every release:**
1. A version bump reaches `main`. The release workflow publishes the images and tags
   `v<version>` ([Published images and versions](#published-images-and-versions)).
2. Its `deploy` job runs `.github/workflows/deploy.yml` with that version, if the repository has a
   `DEPLOY_HOST` variable. Forks and teams without a server skip it.
3. The job runs in the `production` environment, which holds the secrets and deploys only from
   `main`. A run that a release started deploys straight away. A manual run, and any re-run
   (re-running an old release would redeploy an old version), needs a **repository admin** as the
   person who started it.
4. It **verifies the images**. With `gh attestation verify`, it checks that each one carries
   GitHub's signed build provenance, saying that `release.yml` built it on `main`. The release
   workflow attests every image it publishes. An image pushed to the same tag from any other
   workflow or branch (anyone with write access can push one) is refused. The verified digests
   are what the server pulls, so the tag can no longer change what runs.
5. It signs in to Azure with GitHub's OIDC token (no Azure password is stored anywhere) and adds
   an NSG rule that opens port 22 to **this runner's IP only**. It removes the rule when the job
   ends, even if the deploy failed. The admin's own SSH rule is never touched.
6. It connects with the deploy key, checks the server's host key against `DEPLOY_KNOWN_HOSTS`, and
   asks for `deploy <version> <hub digest> <bridge digest>`. On the server, that key's forced
   command is `/usr/local/sbin/agentmesh-deploy`. It runs nothing else, and over SSH it refuses a
   deploy that names no digests.
7. `agentmesh-deploy deploy <version> <digests>`:
   - fetches the tag `v<version>`. It refuses a tag that is not on `main`, and never moves a tag
     the checkout already has;
   - pulls the hub and bridge images by those digests (`agentmesh-hub:<version>@sha256:…`). A
     missing image stops it here, with nothing changed;
   - checks out the tag, so `deploy/docker-compose.yml` matches the release. It also writes
     `deploy/docker-compose.override.yml` (gitignored), which pins the hub and the bridge to those
     images. Compose loads that file by itself, so the `docker compose` commands you run by hand
     use the same images;
   - backs up the database **while the hub keeps running**: SQLite's `VACUUM INTO` takes a
     consistent copy inside the hub container, saved to
     `~/backups/hub-data-<time>-pre-<version>.auto.sqlite.gz` (mode 600; it keeps the last 10). A
     hub that is not running (one that crashed, say) is copied from its volume as `….auto.tgz`
     instead;
   - starts the stack with `up -d --no-build`. Compose swaps the hub and the bridge for the new
     images. NATS keeps running unless the release changed it;
   - waits for the new hub to be **ready**. It asks `/healthz` every 2 seconds, from inside the
     container, for up to 60 seconds. `/healthz` answers 200 only when the hub's database answers,
     a round trip to NATS completes, and its RPC, presence and callout subscriptions are open. A hub
     that exits or restarts fails at once. Then NATS, the hub and the bridge must keep running for
     10 more seconds;
   - rolls back to the previous checkout and images if anything fails after the checkout, and fails
     the job. It never restores the database: hub migrations only add, so an older hub runs on a
     newer schema. The backup is there if you need it ([below](#restoring-a-backup)).
8. A smoke test from the runner checks the path every agent connects through
   (`deploy/auto-deploy/nats-smoke.mjs`). NATS must answer on the public endpoint and present a
   certificate clients accept for `DEPLOY_HOST`, valid for at least 14 more days. It never logs
   in. A failure fails the job, so GitHub alerts you, but it does not roll back: a port or
   certificate problem is not the hub image's doing.

The hub is down only while compose swaps its container: a few seconds. Agents stay connected to
NATS, messages wait in the outbox, and tool calls made in those seconds fail. A release that is
not ready is rolled back within about a minute. The output goes to the job log and to
`~/.local/state/agentmesh-deploy/deploy.log` on the server. A dropped connection or a cancelled run
does not stop a deploy halfway.

**It does not touch** `config/`, `deploy/.env`, `nats.conf`, the seeds or the TLS files. Change
those as before ([Operations](#operations)), and do any server step an upgrade note asks for. A
merge to `main` without a version bump deploys nothing: bump the version to ship hub changes.

**Roll back or redeploy** (a repository admin): Actions → Deploy → Run workflow on `main` with the
version, or `gh workflow run deploy.yml -f version=<version>`. It works for every version the
release workflow attested. Versions published before it did (0.5.0 and older) have no provenance
and are refused. On the server, an admin can run `agentmesh-deploy deploy <version>`, which pulls by
tag without verifying, or `agentmesh-deploy status`. The checkout stays on a detached tag: deploy
with the script, not with `git pull`.

### Restoring a backup

Restoring loses every change since the backup, so do it only when the database itself is broken.
On the server, in `/opt/agentmesh/deploy`, with `<image>` the hub image the stack runs
(`docker compose images hub`):

```bash
docker compose stop hub discord-bridge
VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' \
  "$(docker compose ps -a -q hub)")
# A .sqlite.gz backup (made while the hub ran):
gunzip -c ~/backups/<file>.auto.sqlite.gz | docker run --rm -i -v "$VOLUME:/data" --entrypoint sh \
  <image> -c 'cat > /data/hub.sqlite && rm -f /data/hub.sqlite-wal /data/hub.sqlite-shm'
# A .tgz backup (a copy of the whole volume):
docker run --rm -i -v "$VOLUME:/data" --entrypoint sh <image> \
  -c 'rm -rf /data/* && tar -xzf - -C /data' < ~/backups/<file>.auto.tgz
docker compose up -d
```

### Setting it up on Azure

Run this once from the repo root on the admin's laptop. You need to be signed in to `az` and `gh`
and to have SSH to the VM:

```bash
REPO=<owner>/agentmesh RG=<resource group> NSG=<the VM's NSG> DEPLOY_USER=mesh \
DEPLOY_HOST=<the VM's DNS name> ./deploy/azure/github-deploy-setup.sh
```

It:
- **Azure:** creates the Entra app registration `agentmesh-deploy-<owner>-<repo>`, with a
  federated credential for the repo's `production` environment and no client secret. Its subject
  is the prefix GitHub reports for the repo (`gh api repos/<owner>/<repo>/actions/oidc/customization/sub`)
  plus `:environment:production`. With immutable subjects, the GitHub default for new repos, that
  is `repo:<owner>@<owner id>/<repo>@<repo id>:environment:production`, otherwise
  `repo:<owner>/<repo>:environment:production`. A re-run corrects it. It also creates a custom role, "AgentMesh deploy NSG rules (<rg>)", which can only read, write and
  delete rules, and assigns it on that one NSG.
- **Server:** generates an ed25519 deploy key and installs `agentmesh-deploy` and the key on the
  server (`deploy/auto-deploy/install.sh`; the key's line starts
  `restrict,command="/usr/local/sbin/agentmesh-deploy"`). It reads the server's host key over the
  SSH session it just authenticated.
- **GitHub:** creates the `production` environment (deploys from `main` only) with its secrets,
  and sets the repository variables ([configuration.md](configuration.md#automatic-deploys)).
- **Cleanup:** deletes the private key from the laptop.

Re-running it is safe, and it rotates the deploy key. Run it **before** the next release reaches
`main`; that release is then the first automatic deploy, and `gh run watch` follows it. A stack you
built by hand moves to the published images on its first deploy. To move it sooner, run
`agentmesh-deploy deploy <the version it runs>` on the server.

**Repository settings** that keep anyone else from shipping unreviewed code:
- **`main`:** a ruleset that requires a pull request with one approval and the CI checks, and
  **approval of the most recent push**. Without that last rule, a collaborator could push to your
  open pull request and approve it themselves. Give only the admin role a bypass, and only for
  pull requests.
- **Release tags:** a tag ruleset on `v*` that forbids updating and deleting them. Leave creating
  them allowed: the release workflow creates each tag with the workflow token.
- **Optional:** make an admin a required reviewer of the `production` environment, so each deploy,
  release ones included, waits for an approval.

### Other providers

The workflow's Azure steps run only when `AZURE_NSG` is set. Elsewhere:
1. On the server, from the checkout, run
   `sudo MESH_USER=<user> DEPLOY_PUBKEY='ssh-ed25519 …' ./deploy/auto-deploy/install.sh`.
2. Let GitHub's runners reach port 22. Their addresses change and span many ranges, so either open
   SSH to the internet for key logins only (the deploy key still runs nothing but the deploy), or
   replace the two NSG steps with your provider's API.
3. Create the environment, the secrets and the variables by hand.

## Deploying by hand

The rest of this page is the manual path with the repo's own `deploy/docker-compose.yml`, which
builds the images from source on the VM. Contributors use it, and so do deploys set up before
`/agentmesh:setup` existed.

Like the compose file setup renders, it mounts only `deploy/secrets/discord-bridge.nk` into the
Discord bridge, never the whole folder ([security.md](security.md#setup-and-the-admin-workspace)),
and hardens every container ([Hardening the server](#hardening-the-server)). A deploy set up before
that applies both at its next redeploy
([Applying it to an existing deploy](#applying-it-to-an-existing-deploy)).

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
curl http://<tailscale-ip>:8787/healthz           # {"ok":true,"checks":{…}}; 503 names what is down
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
4. **Firewall:** open only 4222/tcp and SSH from the internet. `vm-setup.sh` also limits new
   connections to 4222 per source IP ([Host firewall](#host-firewall)).
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

- **Logs**: `docker compose logs -f hub` (JSON lines; `AGENTMESH_LOG_LEVEL=debug` for more). Docker
  keeps the last 30 MB per service.
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
    A session receives messages only once it is activated. Since 0.5.0 that is each member's
    [mesh window](getting-started.md#your-mesh-window), which activates itself.
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
