#!/usr/bin/env bash
# Prepares an Ubuntu VM for the AgentMesh hub: Docker, automatic security updates, per-IP limits
# on new NATS connections, a Let's Encrypt certificate for NATS TLS, and a renewal hook that
# installs renewed certificates and reloads NATS. Warns when sshd accepts password logins.
#
#   sudo PUBLIC_HOST=acme-agentmesh.centralindia.cloudapp.azure.com ./deploy/azure/vm-setup.sh
#
# Idempotent: safe to re-run. Expects the repo at $AGENTMESH_DIR (default /opt/agentmesh).
# The update, firewall and ssh steps match what `agentmesh setup host` runs (a test checks it).
set -euo pipefail

: "${PUBLIC_HOST:?set PUBLIC_HOST to the DNS name of the VM}"
: "${AGENTMESH_DIR:=/opt/agentmesh}"
: "${MESH_USER:=${SUDO_USER:-root}}"
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }

echo "== packages"
apt-get update -qq
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot git >/dev/null
usermod -aG docker "$MESH_USER"

echo "== automatic security updates"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades >/dev/null
printf '%s\n' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' \
  >/etc/apt/apt.conf.d/90agentmesh-auto-upgrades
systemctl enable -q --now apt-daily.timer apt-daily-upgrade.timer ||
  echo "warning (agentmesh): the apt-daily timers could not be enabled; security updates may not run." >&2
UU=
eval "$(apt-config shell UU APT::Periodic::Unattended-Upgrade)"
[ "$UU" = 1 ] ||
  echo "warning (agentmesh): a file in /etc/apt/apt.conf.d turns unattended-upgrades off." >&2

echo "== NATS connection limits"
cat >/usr/local/sbin/agentmesh-firewall <<'EOF'
#!/bin/sh
# Installed by AgentMesh: per-source-IP limits on new connections to NATS from the internet.
# Run by agentmesh-firewall.service at boot and whenever Docker starts. To change a value, set
# it in /etc/default/agentmesh-firewall, then: systemctl restart agentmesh-firewall
set -eu
NATS_PORT=4222
NATS_MAX_CONN_PER_IP=128
NATS_NEW_CONN_RATE=10/sec
NATS_NEW_CONN_BURST=100
EXT_IF=
if [ -r /etc/default/agentmesh-firewall ]; then . /etc/default/agentmesh-firewall; fi
[ -n "$EXT_IF" ] || EXT_IF=$(ip -4 route show default | awk '{ print $5; exit }')
if [ -z "$EXT_IF" ]; then
  echo "agentmesh-firewall: no default route; set EXT_IF in /etc/default/agentmesh-firewall" >&2
  exit 1
fi
if ! iptables -n -L DOCKER-USER >/dev/null 2>&1; then
  echo "agentmesh-firewall: Docker's DOCKER-USER chain is missing; is Docker running?" >&2
  exit 1
fi

CHAIN=AGENTMESH-NATS
iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"
iptables -A "$CHAIN" -p tcp -m connlimit --connlimit-above "$NATS_MAX_CONN_PER_IP" \
  --connlimit-mask 32 -j REJECT --reject-with tcp-reset
iptables -A "$CHAIN" -m hashlimit --hashlimit-above "$NATS_NEW_CONN_RATE" \
  --hashlimit-burst "$NATS_NEW_CONN_BURST" --hashlimit-mode srcip \
  --hashlimit-name agentmesh-nats -j DROP
iptables -A "$CHAIN" -j RETURN

# Replace the jump, in case an earlier run used another interface or port.
iptables -S DOCKER-USER | grep -e "-j $CHAIN\$" | sed 's/^-A /-D /' | while read -r rule; do
  eval "iptables $rule"
done
iptables -I DOCKER-USER 1 -i "$EXT_IF" -p tcp -m conntrack --ctstate NEW \
  --ctorigdstport "$NATS_PORT" --ctdir ORIGINAL -j "$CHAIN"
echo "agentmesh-firewall: limits on new connections to port $NATS_PORT via $EXT_IF"
EOF
chmod 755 /usr/local/sbin/agentmesh-firewall
cat >/etc/systemd/system/agentmesh-firewall.service <<'EOF'
[Unit]
Description=AgentMesh: per-IP limits on new connections to NATS (DOCKER-USER)
After=docker.service
BindsTo=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/agentmesh-firewall

[Install]
WantedBy=docker.service
EOF
systemctl daemon-reload
systemctl enable -q agentmesh-firewall.service
systemctl restart agentmesh-firewall.service

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

echo "== ssh"
if SSHD=$(sshd -T 2>/dev/null); then
  if grep -qx 'passwordauthentication yes' <<<"$SSHD"; then
    echo "warning (agentmesh): sshd accepts password logins. Once your key works, set PasswordAuthentication no in /etc/ssh/sshd_config.d/ and reload ssh." >&2
  fi
  if grep -qx 'permitrootlogin yes' <<<"$SSHD"; then
    echo "warning (agentmesh): sshd lets root log in with a password. Set PermitRootLogin prohibit-password in /etc/ssh/sshd_config.d/ and reload ssh." >&2
  fi
else
  echo "warning (agentmesh): could not read sshd's settings (sshd -T); check PasswordAuthentication and PermitRootLogin by hand." >&2
fi

echo "== done. Re-login (docker group), then: cd $AGENTMESH_DIR/deploy && docker compose up -d --build"
