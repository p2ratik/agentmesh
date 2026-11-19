#!/usr/bin/env bash
# Installs off-site backups on the hub server (docs/deploy.md#off-site-backups):
#   /usr/local/sbin/agentmesh-backup        the backup script (root-owned: a merge cannot change it)
#   /etc/default/agentmesh-backup           its settings, written once and never replaced
#   agentmesh-backup.{service,timer}        systemd units: every hour, as MESH_USER
#   ~MESH_USER/.ssh/agentmesh-backup        the key that may push to the backup repository, and
#                                           GitHub's published host keys next to it
#
#   sudo MESH_USER=ubuntu BACKUP_REMOTE=git@github.com:<owner>/<repo>.git \
#        AGE_RECIPIENT=age1… ./deploy/backup/install.sh
#
# Safe to re-run: it replaces the script and the units, keeps the settings and the key, and prints
# the key's public line to add to the backup repository as a deploy key with write access.
set -euo pipefail

: "${MESH_USER:=${SUDO_USER:-}}"
: "${AGENTMESH_DIR:=/opt/agentmesh}"
: "${BACKUP_REMOTE:=}"
: "${AGE_RECIPIENT:=}"
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
[ -n "$MESH_USER" ] && id "$MESH_USER" >/dev/null 2>&1 ||
  { echo "set MESH_USER to the user who runs docker compose for the hub" >&2; exit 1; }
[ -z "$AGE_RECIPIENT" ] || [[ $AGE_RECIPIENT =~ ^age1[0-9a-z]{58}$ ]] ||
  { echo "AGE_RECIPIENT must be an age public key (age1…)" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
GROUP=$(id -gn "$MESH_USER")
HOME_DIR=$(getent passwd "$MESH_USER" | cut -d: -f6)
KEY=$HOME_DIR/.ssh/agentmesh-backup

echo "== packages"
command -v age >/dev/null && command -v git >/dev/null ||
  { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq age git >/dev/null; }

echo "== backup script"
install -o root -g root -m 755 "$HERE/agentmesh-backup.sh" /usr/local/sbin/agentmesh-backup

echo "== settings"
if [ ! -e /etc/default/agentmesh-backup ]; then
  cat >/etc/default/agentmesh-backup <<EOF
# Settings for /usr/local/sbin/agentmesh-backup (docs/configuration.md#off-site-backups).
# Neither value is secret: the repository's address and the admin's public key.
AGENTMESH_DIR=$AGENTMESH_DIR
BACKUP_REMOTE=$BACKUP_REMOTE
AGE_RECIPIENT=$AGE_RECIPIENT
#BACKUP_PATHS="config deploy/.env deploy/secrets deploy/nats/nats.conf deploy/docker-compose.override.yml"
#BACKUP_SSH_KEY=\$HOME/.ssh/agentmesh-backup
EOF
  chmod 644 /etc/default/agentmesh-backup
else
  echo "kept the existing /etc/default/agentmesh-backup"
fi

echo "== key for the backup repository"
install -d -o "$MESH_USER" -g "$GROUP" -m 700 "$HOME_DIR/.ssh"
if [ ! -e "$KEY" ]; then
  sudo -u "$MESH_USER" ssh-keygen -q -t ed25519 -N '' -C "agentmesh-backup@$(hostname)" -f "$KEY"
fi
# GitHub's host keys as GitHub publishes them over HTTPS, so the first push trusts nothing unseen.
META=$(curl -fsS https://api.github.com/meta) || { echo "cannot read https://api.github.com/meta" >&2; exit 1; }
grep -o '"ssh-ed25519 [A-Za-z0-9+/=]*"' <<<"$META" | tr -d '"' | sed 's/^/github.com /' >"$KEY.known_hosts.new"
[ -s "$KEY.known_hosts.new" ] || { echo "no ssh-ed25519 key in GitHub's metadata" >&2; exit 1; }
chown "$MESH_USER:$GROUP" "$KEY.known_hosts.new"
chmod 644 "$KEY.known_hosts.new"
mv "$KEY.known_hosts.new" "$KEY.known_hosts"

echo "== systemd timer"
cat >/etc/systemd/system/agentmesh-backup.service <<EOF
[Unit]
Description=AgentMesh off-site backup (docs/deploy.md#off-site-backups)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$MESH_USER
ExecStart=/usr/local/sbin/agentmesh-backup run
# The plaintext lives only here (tmpfs, mode 700, removed when the run ends).
RuntimeDirectory=agentmesh-backup
RuntimeDirectoryMode=0700
StateDirectory=agentmesh-backup
UMask=0077
Nice=10
TimeoutStartSec=15min
EOF
cat >/etc/systemd/system/agentmesh-backup.timer <<EOF
[Unit]
Description=AgentMesh off-site backup, every hour

[Timer]
OnCalendar=hourly
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
. /etc/default/agentmesh-backup
if [ -n "${BACKUP_REMOTE:-}" ] && [ -n "${AGE_RECIPIENT:-}" ]; then
  systemctl enable --now agentmesh-backup.timer >/dev/null
  echo "the timer is on: $(systemctl show -p NextElapseUSecRealtime --value agentmesh-backup.timer)"
else
  echo "warning (agentmesh): set BACKUP_REMOTE and AGE_RECIPIENT in /etc/default/agentmesh-backup," \
    "then: sudo systemctl enable --now agentmesh-backup.timer" >&2
fi

echo "== checks"
sudo -u "$MESH_USER" docker info >/dev/null 2>&1 ||
  echo "warning (agentmesh): $MESH_USER cannot run docker; add it to the docker group." >&2
[ -f "$AGENTMESH_DIR/deploy/docker-compose.yml" ] ||
  echo "warning (agentmesh): no repo checkout at $AGENTMESH_DIR; set AGENTMESH_DIR in /etc/default/agentmesh-backup." >&2
echo "== done. Add this key to the backup repository (Settings > Deploy keys), with write access:"
cat "$KEY.pub"
echo "   Then run one backup now: sudo systemctl start agentmesh-backup && agentmesh-backup status"
