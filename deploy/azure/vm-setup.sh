#!/usr/bin/env bash
# Prepares an Ubuntu VM for the AgentMesh hub: Docker, a Let's Encrypt certificate for NATS
# TLS, and a renewal hook that installs renewed certificates and reloads NATS.
#
#   sudo PUBLIC_HOST=acme-agentmesh.centralindia.cloudapp.azure.com ./deploy/azure/vm-setup.sh
#
# Idempotent: safe to re-run. Expects the repo at $AGENTMESH_DIR (default /opt/agentmesh).
set -euo pipefail

: "${PUBLIC_HOST:?set PUBLIC_HOST to the VM's DNS name}"
: "${AGENTMESH_DIR:=/opt/agentmesh}"
: "${MESH_USER:=${SUDO_USER:-root}}"
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }

echo "== packages"
apt-get update -qq
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot git >/dev/null
usermod -aG docker "$MESH_USER"

echo "== certificate renewal hook"
TLS_DIR="$AGENTMESH_DIR/deploy/nats/tls"
HOOK=/etc/letsencrypt/renewal-hooks/deploy/agentmesh-nats.sh
mkdir -p "$(dirname "$HOOK")"
cat >"$HOOK" <<EOF
#!/bin/sh
# Installed by AgentMesh vm-setup.sh: copy the renewed certificate for NATS and reload it.
set -e
install -d -m 755 "$TLS_DIR"
install -m 644 /etc/letsencrypt/live/$PUBLIC_HOST/fullchain.pem "$TLS_DIR/fullchain.pem"
install -m 640 /etc/letsencrypt/live/$PUBLIC_HOST/privkey.pem "$TLS_DIR/privkey.pem"
docker compose -f "$AGENTMESH_DIR/deploy/docker-compose.yml" kill -s HUP nats >/dev/null 2>&1 || true
EOF
chmod 755 "$HOOK"

echo "== certificate for $PUBLIC_HOST"
if [ ! -d "/etc/letsencrypt/live/$PUBLIC_HOST" ]; then
  certbot certonly --standalone --non-interactive --agree-tos \
    --register-unsafely-without-email -d "$PUBLIC_HOST"
fi
"$HOOK"

echo "== done. Re-login (docker group), then: cd $AGENTMESH_DIR/deploy && docker compose up -d --build"
