/** Quotes a value for bash and sh: single quotes, each embedded `'` written as `'\''`. */
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The certbot deploy hook: install the renewed certificate where NATS reads it, then reload
 * NATS. The same hook as `deploy/azure/vm-setup.sh` installs.
 */
function renewalHook(publicHost: string, remoteDir: string): string {
  return [
    '#!/bin/sh',
    '# Installed by agentmesh setup host: copy the renewed certificate for NATS and reload it.',
    'set -e',
    `LIVE=${quote(`/etc/letsencrypt/live/${publicHost}`)}`,
    `TLS_DIR=${quote(`${remoteDir}/deploy/nats/tls`)}`,
    'install -d -m 755 "$TLS_DIR"',
    'install -m 644 "$LIVE/fullchain.pem" "$TLS_DIR/fullchain.pem"',
    'install -m 640 "$LIVE/privkey.pem" "$TLS_DIR/privkey.pem"',
    `docker compose -f ${quote(`${remoteDir}/deploy/docker-compose.yml`)} kill -s HUP nats >/dev/null 2>&1 || true`,
    '',
  ].join('\n');
}

/**
 * The script `setup host` pipes to `sudo bash -s` on the server, generalised from
 * `deploy/azure/vm-setup.sh`: Docker, certbot, the workspace folders owned by the ssh user,
 * the certificate for NATS TLS and its renewal hook. Every value is baked in single-quoted.
 * Safe to re-run.
 */
export function renderHostScript(i: {
  publicHost: string;
  remoteDir: string;
  user: string;
}): string {
  return `#!/usr/bin/env bash
# Prepares this server for the AgentMesh hub. Written by agentmesh setup host; safe to re-run.
set -euo pipefail

PUBLIC_HOST=${quote(i.publicHost)}
AGENTMESH_DIR=${quote(i.remoteDir)}
MESH_USER=${quote(i.user)}
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
command -v apt-get >/dev/null || {
  echo "This server has no apt-get. Ubuntu 24.04 is the tested target." >&2
  exit 1
}

echo "== packages"
# A new server is still busy with cloud-init and unattended-upgrades: wait for apt's lock.
cloud-init status --wait >/dev/null 2>&1 || true
echo 'DPkg::Lock::Timeout "300";' >/etc/apt/apt.conf.d/90agentmesh-lock-timeout
apt-get update -qq
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
docker compose version >/dev/null 2>&1 || {
  echo "Docker has no Compose v2. Install it (apt-get install docker-compose-v2), then run setup host again." >&2
  exit 1
}
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot >/dev/null
usermod -aG docker "$MESH_USER"

echo "== $AGENTMESH_DIR"
mkdir -p "$AGENTMESH_DIR/deploy/nats" "$AGENTMESH_DIR/deploy/secrets" "$AGENTMESH_DIR/config"
chown "$MESH_USER:" "$AGENTMESH_DIR" "$AGENTMESH_DIR/deploy" "$AGENTMESH_DIR/deploy/nats" \\
  "$AGENTMESH_DIR/deploy/secrets" "$AGENTMESH_DIR/config"

echo "== certificate renewal hook"
HOOK=/etc/letsencrypt/renewal-hooks/deploy/agentmesh-nats.sh
mkdir -p "$(dirname "$HOOK")"
printf '%s' ${quote(renewalHook(i.publicHost, i.remoteDir))} >"$HOOK"
chmod 755 "$HOOK"

echo "== certificate for $PUBLIC_HOST"
if [ ! -d "/etc/letsencrypt/live/$PUBLIC_HOST" ]; then
  certbot certonly --standalone --non-interactive --agree-tos \\
    --register-unsafely-without-email -d "$PUBLIC_HOST"
fi
"$HOOK"

echo "== done"
`;
}
