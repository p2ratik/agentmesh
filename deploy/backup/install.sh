#!/usr/bin/env bash
# Installs off-site backups on the hub server (docs/deploy.md#off-site-backups):
#   /usr/local/sbin/cosmicwave-backup        the backup script (root-owned: a merge cannot change it)
#   /etc/default/cosmicwave-backup           its settings, written once and never replaced
#   cosmicwave-backup.{service,timer}        systemd units: every hour, as MESH_USER
#   ~MESH_USER/.ssh/cosmicwave-backup        the key that may push to the backup repository, and
#                                           GitHub's published host keys next to it
#
#   sudo MESH_USER=ubuntu BACKUP_REMOTE=git@github.com:<owner>/<repo>.git \
#        AGE_RECIPIENT=age1… ./deploy/backup/install.sh
#
# Safe to re-run: it replaces the script and the units, keeps the settings and the key, and prints
# the key's public line to add to the backup repository as a deploy key with write access. On a
# server set up before the rename it takes the old install over: its units and script are removed,
# and its settings, key and state carry across.
set -euo pipefail

: "${MESH_USER:=${SUDO_USER:-}}"
: "${COSMICWAVE_DIR:=/opt/cosmicwave}"
: "${BACKUP_REMOTE:=}"
: "${AGE_RECIPIENT:=}"
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
[ -n "$MESH_USER" ] && id "$MESH_USER" >/dev/null 2>&1 ||
  { echo "set MESH_USER to the user who runs docker compose for the hub" >&2; exit 1; }
[ -z "$AGE_RECIPIENT" ] || [[ $AGE_RECIPIENT =~ ^age1[0-9a-z]{58}$ ]] ||
  { echo "AGE_RECIPIENT must be an age public key (age1…)" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../legacy-names.sh"
GROUP=$(id -gn "$MESH_USER")
HOME_DIR=$(getent passwd "$MESH_USER" | cut -d: -f6)
KEY=$HOME_DIR/.ssh/cosmicwave-backup

echo "== packages"
command -v age >/dev/null && command -v git >/dev/null ||
  { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq age git >/dev/null; }

echo "== backup script"
install -o root -g root -m 755 "$HERE/cosmicwave-backup.sh" /usr/local/sbin/cosmicwave-backup
# An install from before the rename: stop its timer and any run, then carry its settings, key and
# state across, so the deploy key already added to the backup repository keeps working. An old
# unit that cannot be stopped or disabled is removed anyway, with a warning (its script goes too).
for unit in agentmesh-backup.timer agentmesh-backup.service; do
  if [ -e "/etc/systemd/system/$unit" ]; then
    systemctl disable --now "$unit" ||
      echo "warning (cosmicwave): could not stop or disable the old $unit; removing it anyway." >&2
    rm -f "/etc/systemd/system/$unit"
  fi
done
carry_settings /etc/default/agentmesh-backup /etc/default/cosmicwave-backup
for f in "" .pub .known_hosts; do carry_path "$HOME_DIR/.ssh/agentmesh-backup$f" "$KEY$f"; done
carry_path /var/lib/agentmesh-backup /var/lib/cosmicwave-backup
rm -f /usr/local/sbin/agentmesh-backup

echo "== settings"
if [ ! -e /etc/default/cosmicwave-backup ]; then
  cat >/etc/default/cosmicwave-backup <<EOF
# Settings for /usr/local/sbin/cosmicwave-backup (docs/configuration.md#off-site-backups).
# Neither value is secret: the repository's address and the admin's public key.
COSMICWAVE_DIR=$COSMICWAVE_DIR
BACKUP_REMOTE=$BACKUP_REMOTE
AGE_RECIPIENT=$AGE_RECIPIENT
#BACKUP_PATHS="config deploy/.env deploy/secrets deploy/nats/nats.conf deploy/docker-compose.override.yml"
#BACKUP_SSH_KEY=\$HOME/.ssh/cosmicwave-backup
EOF
  chmod 644 /etc/default/cosmicwave-backup
else
  echo "kept the existing /etc/default/cosmicwave-backup"
fi

echo "== key for the backup repository"
install -d -o "$MESH_USER" -g "$GROUP" -m 700 "$HOME_DIR/.ssh"
if [ ! -e "$KEY" ]; then
  sudo -u "$MESH_USER" ssh-keygen -q -t ed25519 -N '' -C "cosmicwave-backup@$(hostname)" -f "$KEY"
fi
# GitHub's host keys as GitHub publishes them over HTTPS, so the first push trusts nothing unseen.
META=$(curl -fsS https://api.github.com/meta) || { echo "cannot read https://api.github.com/meta" >&2; exit 1; }
grep -o '"ssh-ed25519 [A-Za-z0-9+/=]*"' <<<"$META" | tr -d '"' | sed 's/^/github.com /' >"$KEY.known_hosts.new"
[ -s "$KEY.known_hosts.new" ] || { echo "no ssh-ed25519 key in GitHub's metadata" >&2; exit 1; }
chown "$MESH_USER:$GROUP" "$KEY.known_hosts.new"
chmod 644 "$KEY.known_hosts.new"
mv "$KEY.known_hosts.new" "$KEY.known_hosts"

echo "== systemd timer"
cat >/etc/systemd/system/cosmicwave-backup.service <<EOF
[Unit]
Description=Cosmicwave off-site backup (docs/deploy.md#off-site-backups)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$MESH_USER
ExecStart=/usr/local/sbin/cosmicwave-backup run
# The plaintext lives only here (tmpfs, mode 700, removed when the run ends).
RuntimeDirectory=cosmicwave-backup
RuntimeDirectoryMode=0700
StateDirectory=cosmicwave-backup
UMask=0077
Nice=10
TimeoutStartSec=15min
EOF
cat >/etc/systemd/system/cosmicwave-backup.timer <<EOF
[Unit]
Description=Cosmicwave off-site backup, every hour

[Timer]
OnCalendar=hourly
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
. /etc/default/cosmicwave-backup
if [ -n "${BACKUP_REMOTE:-}" ] && [ -n "${AGE_RECIPIENT:-}" ]; then
  systemctl enable --now cosmicwave-backup.timer >/dev/null
  echo "the timer is on: $(systemctl show -p NextElapseUSecRealtime --value cosmicwave-backup.timer)"
else
  echo "warning (cosmicwave): set BACKUP_REMOTE and AGE_RECIPIENT in /etc/default/cosmicwave-backup," \
    "then: sudo systemctl enable --now cosmicwave-backup.timer" >&2
fi

echo "== checks"
sudo -u "$MESH_USER" docker info >/dev/null 2>&1 ||
  echo "warning (cosmicwave): $MESH_USER cannot run docker; add it to the docker group." >&2
[ -f "$COSMICWAVE_DIR/deploy/docker-compose.yml" ] ||
  echo "warning (cosmicwave): no repo checkout at $COSMICWAVE_DIR; set COSMICWAVE_DIR in /etc/default/cosmicwave-backup." >&2
echo "== done. Add this key to the backup repository (Settings > Deploy keys), with write access:"
cat "$KEY.pub"
echo "   Then run one backup now: sudo systemctl start cosmicwave-backup && cosmicwave-backup status"
