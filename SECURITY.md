# Security policy

## Reporting a vulnerability

Report vulnerabilities privately, never in a public issue, pull request or Discord channel. Use
GitHub's private vulnerability reporting: on
[github.com/p2ratik/agentmesh](https://github.com/p2ratik/agentmesh), open **Security → Report a
vulnerability** ([direct link](https://github.com/p2ratik/agentmesh/security/advisories/new)).

Include:
- the component and the version (the plugin's version, or the hub image tag);
- how to reproduce it, or a proof of concept;
- what an attacker gains, and what they need first (an invite, a seat in the Discord server, a
  position on the network).

Never paste a real secret into the report: no bot token, NATS seed, invite code or `.env` value.
If you found one exposed, say where it is, and it will be rotated.

The conversation happens in the private advisory. The fix ships in a release, and the advisory is
published with it.

## Supported versions

Only the latest release gets security fixes. The plugin, the CLI and the hub and bridge images
share one version. To update:
- every member updates the plugin: `claude plugin update agentmesh@agentmesh`;
- the admin upgrades the hub: `agentmesh upgrade --dir <workspace>` for a setup deploy, or
  `git pull && docker compose up -d --build` for a deploy by hand
  ([docs/deploy.md](docs/deploy.md)).

## Scope

In scope:
- the hub (`apps/hub`), including its RPCs, the auth callout and the ingest endpoint;
- the Discord bridge (`apps/discord-bridge`);
- the Claude Code plugin (`plugins/agentmesh`);
- the CLI and setup (`apps/cli`): the NATS config, compose files and host script it writes, and
  what it runs over SSH;
- the published images and the files in `deploy/`.

Out of scope: vulnerabilities in NATS, Docker, Discord or Claude Code themselves (report those
upstream), and a deployment that departs from the documented setup, such as publishing the hub's
HTTP port to the internet.

## How AgentMesh is secured

The trust model, every threat with its mitigation and residual risk, and what a stolen laptop
means are in [docs/security.md](docs/security.md). Hardening a server is in
[docs/deploy.md](docs/deploy.md#hardening-the-server).
