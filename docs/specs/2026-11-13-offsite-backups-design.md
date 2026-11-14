# Off-site backups of the hub — design

**Status:** approved and built · 2026-11-13 ([ADR 0013](../adr/0013-offsite-backups.md)).

## Why

A hub on a free-trial or prepaid VM can disappear with its disk when the account lapses. The only
copy of the hub's state (tasks, threads, the team registry) and of the secrets needed to run it
again then lives on that VM. Today the only backups are the pre-deploy ones in `~/backups` on the
same disk.

## Goals

- Every hour, an encrypted copy of everything needed to rebuild the hub leaves the server for a
  private git repository the admin owns. At most an hour of work is lost if the server dies.
- One copy per day is kept for good. Hourly copies replace each other.
- The admin hears about it when backups stop, whether the script broke or the server died.
- A restore is a documented handful of commands on any machine with the decryption key.

## Non-goals

- Point-in-time recovery (continuous WAL shipping, Litestream). An hour of loss is accepted.
- Backing up the NATS volume. JetStream holds only the feed to the bridge; the hub's outbox in
  SQLite is the source of truth, so a fresh stream loses at most some Discord mirror posts.
- Backing up TLS certificates: certbot issues new ones on the new server.
- Pruning old daily copies (about 250 MB a year at today's 700 KB per copy).

## Anti-goals

- No secret, and no unencrypted byte of a backup, in the public AgentMesh repository, in a log,
  or in the backup repository.
- No key on the server that can decrypt a backup.

## Approaches considered

1. **Daily push only.** Simplest, but a server that dies before the nightly run loses up to a day.
2. **Hourly copy that replaces itself, plus a permanent daily copy (chosen).** At most an hour
   lost; the repository grows only at the daily rate.
3. **GitHub Actions pulls from the server.** A hacked server could not delete old backups, but it
   needs SSH open to GitHub's runners, which this deploy does not have. Dropped.

Raw WAL copies were ruled out: the WAL lives on the same disk, and a copy taken while the hub
writes can be inconsistent. `VACUUM INTO` already includes everything committed to the WAL.

## Design

**What a backup holds:** one `tar.gz`, encrypted with [age](https://age-encryption.org) to the
admin's public key:
- `hub.sqlite`, a `VACUUM INTO` snapshot taken while the hub keeps serving, the same way
  `agentmesh-deploy` takes it. It must pass `PRAGMA quick_check` before it is shipped, so a broken
  snapshot never replaces a good copy.
- The paths in `BACKUP_PATHS`, relative to the checkout. Default: `config deploy/.env
  deploy/secrets deploy/nats/nats.conf deploy/docker-compose.override.yml`.

The plaintext exists only in the service's `RuntimeDirectory` (tmpfs, mode 700, removed when the
run ends) and is streamed through `tar | gzip | age`.

**The backup repository** has two branches, each holding one file, `hub-backup.tar.gz.age`:
- `hourly`: a single orphan commit, force-pushed every run. Older hourly copies are gone.
- `main`: one commit per UTC day, message `daily YYYY-MM-DD`, made by the first run of that day.
  Fast-forward only, so an admin whose GitHub plan allows it can forbid force-pushes and deletion
  on `main`.

Each run works in a fresh temporary clone (`--depth 1`), so the server keeps no git state. The
daily copy is pushed before the hourly one: on an empty repository the first branch pushed becomes
the default, and the watch workflow must live on `main`. The last daily date is kept in the
service's state directory and written only after a successful push.

**On the server** (same pattern as `deploy/auto-deploy/`):
- `deploy/backup/agentmesh-backup.sh` → `/usr/local/sbin/agentmesh-backup` (root-owned). Actions:
  `run` (the timer's) and `status` (last success, from its state file).
- `deploy/backup/install.sh` installs the script, the `agentmesh-backup.service` (oneshot, as the
  user who runs docker compose) and `.timer` (hourly, `Persistent=true`, a small random delay),
  writes `/etc/default/agentmesh-backup` once, and creates an ed25519 deploy key for the backup
  repository, printing its public line. It needs `age` and `git` (apt).
- Settings in `/etc/default/agentmesh-backup`: `AGENTMESH_DIR` (`/opt/agentmesh`),
  `BACKUP_REMOTE` (required, an SSH git URL), `AGE_RECIPIENT` (required, an `age1…` public key),
  `BACKUP_PATHS` (above), `BACKUP_SSH_KEY` (`~/.ssh/agentmesh-backup`).
- The snapshot uses its own temporary file name, so it cannot collide with a deploy's backup.
- The snapshot code is a copy of `agentmesh-deploy`'s, with a comment pointing at it, plus the
  `quick_check`. Sharing one file would have changed the deploy key's install path for 15 lines.
- `install.sh` pins GitHub's SSH host keys from `api.github.com/meta` (over HTTPS), next to the
  key, so the first push trusts no unseen host key.

**Alerting:** a workflow template, `deploy/backup/backup-watch.yml`, which the admin copies into the
backup repository. Every 2 hours it reads the `hourly` branch's commit time through the GitHub
API and fails if it is older than 3 hours. GitHub emails the admin when a scheduled workflow
fails. This catches both a broken script and a dead server. It costs about 360 Actions minutes a
month, within a private repository's free allowance.

**Restore** (docs): clone the backup repository, `age -d -i key.txt hub-backup.tar.gz.age | tar
-xz`. Use `git show <daily commit>:hub-backup.tar.gz.age` for an older day. Then put
`hub.sqlite` into the `hub-data` volume as in "Restoring a backup" in `docs/deploy.md`, and the
files into the checkout.

**Key custody:** the admin generates the age key pair on their own machine (`age-keygen`) and
keeps the private key in a password manager as well as on disk. Only the public key goes to the
server.

## Security notes (for `docs/security.md`)

- A backup holds every secret of the deploy. It is encrypted before it leaves the server, and the
  server cannot decrypt it. GitHub sees only the size and the time of each copy.
- The deploy key can write only to the backup repository. A hacked server can still delete or
  overwrite copies with it. Protecting `main` limits that to the hourly copy; the admin's own
  clone is a further copy.
- Losing the private age key makes every backup useless; hence the password manager.

## Docs and tests

- `docs/deploy.md`: a new "Off-site backups" section (setup and restore). It replaces the old
  "Backups" bullet. `docs/configuration.md`: the settings. `docs/security.md`: the notes above.
  ADR 0013.
- Tests in `tests/deploy/`, following `agentmesh-deploy.test.ts`: the scripts parse; required
  settings are enforced before anything runs; with stub `docker` and `age` and a local bare
  repository as the remote, two runs on one day make one daily commit and replace the hourly one,
  and a run on the next day adds a second daily commit; a snapshot that fails its check pushes
  nothing.

## Left to the builder

The exact state file and log lines, how the empty backup repository's first run is handled, and
the timer's random delay.
