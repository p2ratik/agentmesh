import type { Hosting } from '../answers';

/**
 * The workspace's `deploy/docker-compose.yml`: the repo's compose file, but it pulls the
 * published images instead of building from source, so a server needs only Docker.
 */
export function renderCompose(): string {
  return `# Written by \`agentmesh setup render\`. NATS JetStream, the AgentMesh hub and the Discord bridge.
# The images are \${AGENTMESH_IMAGE_REGISTRY}/agentmesh-*:\${AGENTMESH_VERSION} from .env;
# \`agentmesh upgrade\` moves the version. \`agentmesh setup deploy\` starts the stack.
#
# Expects (relative to this directory):
#   .env              rendered by setup; holds DISCORD_BOT_TOKEN
#   nats/nats.conf    from \`agentmesh nats-config\`
#   nats/tls/         fullchain.pem + privkey.pem when NATS requires TLS (a server)
#   secrets/*.nk      from \`agentmesh keys add\`
#   the mesh config   at $AGENTMESH_CONFIG_DIR (../config)
#
# Every service runs without Linux capabilities, cannot gain privileges, has a read-only root
# filesystem (writes go to its volume and a small /tmp), and has memory, process and log caps.
# The caps come from .env.
name: agentmesh

# Docker's default log never rotates, so a log flood would fill the disk: 3 files of 10 MB.
x-logging: &logging
  driver: json-file
  options: { max-size: "10m", max-file: "3" }

services:
  nats:
    image: nats:2.15.1-alpine
    command: ["-c", "/etc/nats/nats.conf"]
    volumes:
      # Mount the directory, not nats.conf itself: a replaced file gets a new inode that a
      # single-file bind mount never sees, so \`kill -s HUP\` would reload the stale config.
      - ./nats:/etc/nats:ro
      - nats-data:/data
    ports:
      # A server: 0.0.0.0 (nats.conf requires TLS). A trial: 127.0.0.1.
      - "\${NATS_BIND:-127.0.0.1}:4222:4222"
    networks:
      default:
        # With TLS the hub must connect by the certificate's name; this alias resolves it
        # to this container from inside the compose network.
        aliases: ["\${NATS_PUBLIC_HOST:-nats}"]
    # The image runs NATS as root: without capabilities it can still read root's own files
    # (the TLS key) and anything world-readable (nats.conf), but no one else's.
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    read_only: true
    tmpfs: ["/tmp:size=16m"]
    mem_limit: \${NATS_MEM_LIMIT:-256m}
    pids_limit: \${PIDS_LIMIT:-256}
    logging: *logging
    restart: unless-stopped

  hub:
    image: \${AGENTMESH_IMAGE_REGISTRY}/agentmesh-hub:\${AGENTMESH_VERSION}
    env_file: .env
    environment:
      AGENTMESH_CONFIG: /config
      AGENTMESH_DATA_DIR: /data
      AGENTMESH_NATS_URL: nats://\${NATS_PUBLIC_HOST:-nats}:4222
      AGENTMESH_NKEY_SEED: /secrets/hub.nk
      # Auth-callout mode reads hub-issuer.nk, hub-xkey.nk and hub-sys.nk from here.
      AGENTMESH_SECRETS_DIR: /secrets
    volumes:
      - \${AGENTMESH_CONFIG_DIR:-../config}:/config:ro
      - ./secrets:/secrets:ro
      - hub-data:/data
    ports:
      # Ingest endpoint for Hermes/GitHub. Keep it private, or put a TLS proxy in front.
      - "\${HUB_HTTP_BIND:-127.0.0.1}:8787:8787"
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    read_only: true
    # SQLite may spill temporary tables here; the database itself is in /data.
    tmpfs: ["/tmp:size=64m"]
    mem_limit: \${HUB_MEM_LIMIT:-512m}
    pids_limit: \${PIDS_LIMIT:-256}
    logging: *logging
    depends_on: [nats]
    restart: unless-stopped

  discord-bridge:
    profiles: [discord]
    image: \${AGENTMESH_IMAGE_REGISTRY}/agentmesh-discord-bridge:\${AGENTMESH_VERSION}
    env_file: .env
    environment:
      AGENTMESH_CONFIG: /config
      AGENTMESH_NATS_URL: nats://\${NATS_PUBLIC_HOST:-nats}:4222
      AGENTMESH_NKEY_SEED: /secrets/discord-bridge.nk
    volumes:
      - \${AGENTMESH_CONFIG_DIR:-../config}:/config:ro
      # Only the bridge's own seed, never the whole secrets/ directory: the hub's seeds live
      # there (in auth-callout mode hub-issuer.nk signs any NATS identity), out of a bridge's reach.
      - ./secrets/discord-bridge.nk:/secrets/discord-bridge.nk:ro
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    read_only: true
    tmpfs: ["/tmp:size=16m"]
    mem_limit: \${BRIDGE_MEM_LIMIT:-384m}
    pids_limit: \${PIDS_LIMIT:-256}
    logging: *logging
    depends_on: [hub]
    restart: unless-stopped

volumes:
  nats-data: {}
  hub-data: {}
`;
}

/**
 * The workspace's `deploy/.env`. Every comment sits on its own line above the setting:
 * a value is never followed by text, so the admin can paste the token after the `=`.
 */
export function renderEnv(i: { hosting: Hosting; version: string; registry: string }): string {
  const server = i.hosting.mode === 'server' ? i.hosting : null;
  return `# Never commit this file or paste its values into a chat.

# The Discord bot token: paste it after the = sign and save. Claude never reads this file.
DISCORD_BOT_TOKEN=
# The bot's application id; \`agentmesh setup discord\` fills it in.
DISCORD_APP_ID=
# The Discord server the mesh uses; \`agentmesh setup discord\` fills it in.
DISCORD_GUILD_ID=

# Where the hub and Discord bridge images come from.
AGENTMESH_IMAGE_REGISTRY=${i.registry}
# The hub version this workspace runs; only \`agentmesh upgrade\` changes it.
AGENTMESH_VERSION=${i.version}
# The mesh config directory, relative to this one (mounted read-only at /config).
AGENTMESH_CONFIG_DIR=../config
# Where NATS listens: 0.0.0.0 on a server (TLS), 127.0.0.1 on a trial.
NATS_BIND=${server ? '0.0.0.0' : '127.0.0.1'}
# The NATS certificate's DNS name on a server; empty on a trial.
NATS_PUBLIC_HOST=${server?.publicHost ?? ''}
# The hub's ingest endpoint stays private to this machine.
HUB_HTTP_BIND=127.0.0.1
# Log level of the hub and the Discord bridge: debug, info, warn or error.
AGENTMESH_LOG_LEVEL=info
# Memory cap of the NATS container, in Docker units such as 256m or 1g (sized for 1-2 GB).
NATS_MEM_LIMIT=256m
# Memory cap of the hub container.
HUB_MEM_LIMIT=512m
# Memory cap of the Discord bridge container.
BRIDGE_MEM_LIMIT=384m
# The most processes and threads each container may run.
PIDS_LIMIT=256
`;
}

/** The workspace's `.gitignore`: the files that hold secrets, and `.env`'s atomic-write temp file. */
export const WORKSPACE_GITIGNORE =
  'deploy/.env\ndeploy/.env.*\ndeploy/secrets/\ndeploy/nats/nats.conf\n*.nk\n';

/**
 * A `.gitignore` (empty when there is none) with the lines of WORKSPACE_GITIGNORE it lacks
 * appended. A workspace in an existing repo keeps its own lines. Pure.
 */
export function withSecretLines(existing: string): string {
  const has = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = WORKSPACE_GITIGNORE.split('\n').filter((line) => line && !has.has(line));
  if (missing.length === 0) return existing;
  const body = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
  return `${body}${missing.join('\n')}\n`;
}

/** The workspace's `.claude/settings.json`: Claude must not open the token or the seeds. */
export function renderClaudeSettings(): string {
  const deny = ['Read(./deploy/.env)', 'Read(./deploy/secrets/**)'];
  return `${JSON.stringify({ permissions: { deny } }, null, 2)}\n`;
}
