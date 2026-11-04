# ADR 0010 — Automatic deploys from GitHub Actions

**Status:** accepted · 2026-11-04.

## Context

The release workflow already publishes the hub and bridge images for every version bump that
reaches `main`. A hub deployed from a checkout of the repo (Opzami's, for one) still had to be
upgraded by hand. The admin first added their current IP to the NSG, then SSHed in and ran
`git pull` and `docker compose build` (several minutes on a small VM), then `up -d`. Every
release waited for that, and the admin's IP changes often.

Constraints:
- SSH is open only to the admin's IP.
- The repository is public, so its Actions logs are public.
- Merges to `main` need a reviewed pull request.
- Principle 1: least privilege, and no secrets in logs.

## Decision

- **The release workflow deploys what it just published.** A `deploy` job runs after the images
  and the tag exist, when the repository sets `DEPLOY_HOST`. The same workflow (`deploy.yml`) runs
  by hand to redeploy or roll back to any released version.
- **The server pulls images; it never builds.** It checks out the release tag, for the compose
  file. A gitignored `docker-compose.override.yml` points the hub and the bridge at
  `<registry>/agentmesh-*:<version>`.
- **SSH stays closed except to the runner.** The job signs in to Azure through OIDC federation,
  with no stored credential. It adds an NSG rule for its own `/32` and removes it when it ends.
  The Azure identity's custom role covers rules on that one NSG and nothing else.
- **The deploy key can only deploy.** Its forced command is a root-owned script that accepts
  `deploy <x.y.z> <hub digest> <bridge digest>` or `status`. It refuses tags that are not on
  `main`.
- **Only images release.yml built on main.** Anyone with write access can push to the image
  package from a branch workflow. So the release workflow signs each image with GitHub's build
  provenance, and the deploy job verifies it (`gh attestation verify --signer-workflow …release.yml
  --source-ref refs/heads/main`) before sending the digests; the server pulls by digest.
- **Only admins deploy by hand.** A manual run or any re-run needs a repository admin, so nobody
  else can redeploy an old version. A release's own run deploys the version it published.
  Rulesets on `main` (approval of the most recent push) and on `v*` tags (no moving or deleting)
  keep write access from shipping unreviewed code.
- **Short downtime, gated on readiness.** The script backs up the database while the hub keeps
  serving (SQLite `VACUUM INTO`), so the hub is down only while compose swaps its container.
  `/healthz` became a readiness check: database, a NATS round trip, and the RPC, presence and
  callout subscriptions. The script polls it every 2 s and rolls back to the previous images when
  it fails.
- **A smoke test from outside.** After the deploy, the runner checks that NATS answers on the
  public endpoint with a certificate clients accept. A failure alerts; it does not roll back.
- **Blue-green and canary were rejected.** The hub is the single writer: RPCs use a NATS queue
  group, and the outbox has no row claims. So two hub versions cannot run side by side, and a
  canary of one person on a 5–15 person team gives no signal.
- **Secrets live in a `production` environment** that deploys only from `main`.

## Alternatives considered

- **A timer on the server that polls for new tags.** It needs no inbound access and no
  credentials in GitHub. Rejected: the team asked for GitHub Actions, and deploys would have no
  status or log in GitHub and no button to roll back. It also delays each release by the polling
  interval. It remains the fallback for a team that cannot let a runner in.
- **Open port 22 to the internet, key-only.** It is simpler: no cloud identity. Rejected: it puts
  sshd in front of every scanner, for a job that runs a few minutes a week. GitHub's runner
  address ranges are too many and change too often to list in an NSG.
- **A self-hosted runner on the VM.** Rejected: on a public repository, a fork's pull request can
  target a self-hosted runner. A user-owned repository cannot restrict a runner to one workflow.
  The runner would hold Docker (root) on the hub.
- **`az vm run-command` from the workflow.** It needs no SSH at all. Rejected: the workflow would
  choose the script, and that script runs as root, so a compromised job owns the VM. With a forced
  command, the server decides what runs.
- **Tailscale for the runner.** Rejected for now: it adds a vendor and an OAuth client for one
  job.

## Consequences

- Every release reaches the server a few minutes after its merge. The hub is down for a few
  seconds, a release that is not ready is rolled back within about a minute, and no human SSH is
  needed.
- Hub changes ship only with a version bump. Config, `.env`, `nats.conf` and the seeds stay manual.
- The setup is Azure-specific (`deploy/azure/github-deploy-setup.sh`). Other providers install
  the same server script and replace the two NSG steps or open SSH another way.
- Versions released before provenance (0.5.0 and older) cannot be deployed from Actions; an admin
  deploys them on the server. The server trusts the digests the deploy job sends and does not verify
  provenance itself (see [security.md](../security.md#automatic-deploys)).
