# ADR 0013 — Off-site backups to a private git repository

**Status:** accepted · 2026-11-13.

## Context

The hub's state (tasks, threads, the team registry) lives in one SQLite file on the hub server,
and the secrets needed to run it again (`deploy/.env`, the nkey seeds, `config/`) live next to it.
The only backups were the pre-deploy ones in `~/backups`, on the same disk.

In November 2026 the team's hub ran on a free-trial VM. The provider stopped it over billing, and
the data was recovered only because the disk still existed. Teams of 5–15 people self-host on
whatever account is at hand, so a server that vanishes with its disk is a real case.

## Decision

- **Every hour, an encrypted copy leaves the server for a private git repository the admin owns.**
  A systemd timer runs `/usr/local/sbin/agentmesh-backup`. It is root-owned, installed by
  `deploy/backup/install.sh`, and runs as the user who runs docker compose.
- **One copy holds everything needed to rebuild:** a `VACUUM INTO` snapshot of `hub.sqlite` that
  passed `PRAGMA quick_check`, plus `config/`, `deploy/.env`, `deploy/secrets/`, `nats.conf` and
  the compose override. These go into one `tar.gz`, encrypted with age to the admin's public key.
  The server never holds a key that decrypts.
- **Two branches.** `hourly` is one commit, force-pushed every run, so at most an hour is lost.
  `main` gets one fast-forward commit per UTC day, kept for good. The repository grows at the
  daily rate (about 1 MB a day today), not the hourly one.
- **A watch workflow in the backup repository** fails, and GitHub emails the admin, when `hourly`
  is more than 3 hours old. It catches both a broken script and a dead server, with nothing on the
  server.
- **No raw WAL copies.** `VACUUM INTO` already includes everything committed to the WAL. The WAL
  file sits on the same disk, and copying it while the hub writes can give an inconsistent pair.

## Alternatives considered

- **Daily only.** Simplest, but a server that dies just before the run loses a day.
- **Continuous replication (Litestream to object storage).** Seconds of loss, but it adds a
  service and a storage vendor, and object storage on the same cloud account dies with it.
  Rejected for now: an hour is acceptable for this data.
- **GitHub Actions pulling from the server.** A hacked server could then not delete backups. But
  it needs SSH open to GitHub's runners every hour. Rejected: a ruleset on `main` gives most of
  the protection without that.
- **Unencrypted copies in a private repository.** Rejected: principle 1 keeps secrets out of git,
  private or not.
- **Pruning old daily copies.** Not built: at today's size the repository grows by a few hundred
  MB a year. Add it when that matters.

## Consequences

- A lost server costs at most an hour of work, and a new server can be rebuilt from the backup
  repository and the admin's private key alone.
- The private key is now critical: losing it makes every backup useless. The docs ask for a
  password-manager copy and a restore test.
- The hourly force-push leaves unreferenced objects on GitHub until its garbage collection runs.
- The schedule, the paths and the repository are settings on the server, not in the code.
