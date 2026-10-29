/**
 * Host hardening that `setup host` and `deploy/azure/vm-setup.sh` both apply; a test keeps
 * vm-setup.sh's copy identical. Bash text and files for the server, no IO here.
 */

/** The prefix of the scripts' warnings; `setup host` shows these lines to the admin. */
export const WARNING = 'warning (agentmesh):';

/**
 * Security updates every day: unattended-upgrades with its periodic settings in a file of our
 * own (re-written on every run) and the apt timers on. A later file in apt.conf.d that turns it
 * off wins, so that is only reported. Ubuntu's default origins hold security updates only, so
 * Docker itself is never upgraded (and restarted) by it.
 */
export const AUTO_UPDATES = `echo "== automatic security updates"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades >/dev/null
printf '%s\\n' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' \\
  >/etc/apt/apt.conf.d/90agentmesh-auto-upgrades
systemctl enable -q --now apt-daily.timer apt-daily-upgrade.timer ||
  echo "${WARNING} the apt-daily timers could not be enabled; security updates may not run." >&2
UU=
eval "$(apt-config shell UU APT::Periodic::Unattended-Upgrade)"
[ "$UU" = 1 ] ||
  echo "${WARNING} a file in /etc/apt/apt.conf.d turns unattended-upgrades off." >&2
`;

/**
 * Warns about password logins and never changes them: on an existing server that could lock
 * the admin out.
 */
export const SSH_CHECK = `echo "== ssh"
if SSHD=$(sshd -T 2>/dev/null); then
  if grep -qx 'passwordauthentication yes' <<<"$SSHD"; then
    echo "${WARNING} sshd accepts password logins. Once your key works, set PasswordAuthentication no in /etc/ssh/sshd_config.d/ and reload ssh." >&2
  fi
  if grep -qx 'permitrootlogin yes' <<<"$SSHD"; then
    echo "${WARNING} sshd lets root log in with a password. Set PermitRootLogin prohibit-password in /etc/ssh/sshd_config.d/ and reload ssh." >&2
  fi
else
  echo "${WARNING} could not read sshd's settings (sshd -T); check PasswordAuthentication and PermitRootLogin by hand." >&2
fi
`;

/**
 * The per-source-IP limits on new connections to NATS. Docker publishes ports through its own
 * iptables rules, which ufw and the INPUT chain never see, so the rules go in Docker's
 * DOCKER-USER chain, applied by a script that a systemd unit runs whenever Docker starts.
 */
export const FIREWALL_SCRIPT_PATH = '/usr/local/sbin/agentmesh-firewall';
export const FIREWALL_UNIT_PATH = '/etc/systemd/system/agentmesh-firewall.service';

/**
 * Re-applies the rules from scratch, so it is safe to run any number of times. Only new TCP
 * connections that arrive on the internet-facing interface (the default route's) for the
 * published port enter the AGENTMESH-NATS chain: the hub and the bridge reach NATS over the
 * compose network and never match. A source IP gets at most 128 open connections and 10 new
 * ones a second, in bursts of up to 100: a 15-person office behind one NAT, a few sessions
 * each, reconnects at once without hitting either. /etc/default/agentmesh-firewall overrides
 * the values and is never written by setup.
 */
export const FIREWALL_SCRIPT = `#!/bin/sh
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
iptables -A "$CHAIN" -p tcp -m connlimit --connlimit-above "$NATS_MAX_CONN_PER_IP" \\
  --connlimit-mask 32 -j REJECT --reject-with tcp-reset
iptables -A "$CHAIN" -m hashlimit --hashlimit-above "$NATS_NEW_CONN_RATE" \\
  --hashlimit-burst "$NATS_NEW_CONN_BURST" --hashlimit-mode srcip \\
  --hashlimit-name agentmesh-nats -j DROP
iptables -A "$CHAIN" -j RETURN

# Replace the jump, in case an earlier run used another interface or port.
iptables -S DOCKER-USER | grep -e "-j $CHAIN\\$" | sed 's/^-A /-D /' | while read -r rule; do
  eval "iptables $rule"
done
iptables -I DOCKER-USER 1 -i "$EXT_IF" -p tcp -m conntrack --ctstate NEW \\
  --ctorigdstport "$NATS_PORT" --ctdir ORIGINAL -j "$CHAIN"
echo "agentmesh-firewall: limits on new connections to port $NATS_PORT via $EXT_IF"
`;

/** Runs the script after Docker starts, at boot and after every Docker restart. */
export const FIREWALL_UNIT = `[Unit]
Description=AgentMesh: per-IP limits on new connections to NATS (DOCKER-USER)
After=docker.service
BindsTo=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${FIREWALL_SCRIPT_PATH}

[Install]
WantedBy=docker.service
`;
