#!/usr/bin/env bash
# Installs the endpoint for automatic deploys on the hub server (docs/deploy.md#automatic-deploys):
#   /usr/local/sbin/agentmesh-deploy   the deploy script (root-owned: a merge cannot change it)
#   /etc/default/agentmesh-deploy      its settings, written once and never replaced
#   ~MESH_USER/.ssh/authorized_keys    the GitHub Actions key, able to run only that script
#
#   sudo MESH_USER=mesh DEPLOY_PUBKEY='ssh-ed25519 AAAA…' ./deploy/auto-deploy/install.sh
#
# deploy/azure/github-deploy-setup.sh runs it for you over SSH. Safe to re-run: it replaces the
# script and the key line it added before (so a re-run rotates the key).
set -euo pipefail

: "${DEPLOY_PUBKEY:?set DEPLOY_PUBKEY to the public line of the deploy key}"
: "${MESH_USER:=${SUDO_USER:-}}"
: "${AGENTMESH_DIR:=/opt/agentmesh}"
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
[ -n "$MESH_USER" ] && id "$MESH_USER" >/dev/null 2>&1 ||
  { echo "set MESH_USER to the user who runs docker compose for the hub" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
MARK=agentmesh-github-deploy

# Only the key type and body are kept; the comment becomes the marker this script replaces.
read -r KEY_TYPE KEY_BODY _ <<<"$DEPLOY_PUBKEY"
[[ $KEY_TYPE == ssh-ed25519 && $KEY_BODY =~ ^[A-Za-z0-9+/]+=*$ ]] ||
  { echo "DEPLOY_PUBKEY must be an ssh-ed25519 public key line" >&2; exit 1; }

echo "== deploy script"
install -o root -g root -m 755 "$HERE/agentmesh-deploy.sh" /usr/local/sbin/agentmesh-deploy

echo "== settings"
if [ ! -e /etc/default/agentmesh-deploy ]; then
  cat >/etc/default/agentmesh-deploy <<EOF
# Settings for /usr/local/sbin/agentmesh-deploy (docs/configuration.md#automatic-deploys).
# Uncomment a line to change it from the default shown.
AGENTMESH_DIR=$AGENTMESH_DIR
#IMAGE_REGISTRY=ghcr.io/p2ratik
#COMPOSE_PROFILES=discord
#GIT_REMOTE=origin
#RELEASE_BRANCH=main
#BACKUP_DIR=\$HOME/backups
#KEEP_BACKUPS=10
#HEALTH_TIMEOUT=60
EOF
  chmod 644 /etc/default/agentmesh-deploy
else
  echo "kept the existing /etc/default/agentmesh-deploy"
fi

echo "== deploy key for $MESH_USER"
HOME_DIR=$(getent passwd "$MESH_USER" | cut -d: -f6)
SSH_DIR=$HOME_DIR/.ssh
AUTH=$SSH_DIR/authorized_keys
install -d -o "$MESH_USER" -g "$(id -gn "$MESH_USER")" -m 700 "$SSH_DIR"
touch "$AUTH"
# `restrict` turns off forwarding, the pty and X11; `command=` replaces whatever the client asks
# to run with the deploy script, which reads the request from SSH_ORIGINAL_COMMAND.
LINE="restrict,command=\"/usr/local/sbin/agentmesh-deploy\" $KEY_TYPE $KEY_BODY $MARK"
{ grep -v " $MARK\$" "$AUTH" || true; echo "$LINE"; } >"$AUTH.new"
chown "$MESH_USER:$(id -gn "$MESH_USER")" "$AUTH.new"
chmod 600 "$AUTH.new"
mv "$AUTH.new" "$AUTH"

echo "== checks"
sudo -u "$MESH_USER" docker info >/dev/null 2>&1 ||
  echo "warning (agentmesh): $MESH_USER cannot run docker; add it to the docker group." >&2
[ -f "$AGENTMESH_DIR/deploy/docker-compose.yml" ] ||
  echo "warning (agentmesh): no repo checkout at $AGENTMESH_DIR; set AGENTMESH_DIR in /etc/default/agentmesh-deploy." >&2
echo "== done. Test it: sudo -u $MESH_USER agentmesh-deploy status"
