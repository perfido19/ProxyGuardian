#!/bin/bash
# Installs the second NetBird daemon (wt1, self-hosted backup) on a host.
# Does NOT touch the primary daemon (/var/lib/netbird/default.json, wt0,
# unix:///var/run/netbird.sock) in any way - completely separate config,
# socket, log, systemd unit, and WireGuard interface.
#
# Real netbird 0.77.x CLI (verified against the running primary on main):
#   the long-lived process is "netbird service run" (systemd manages this),
#   NOT "netbird up --foreground-mode". "netbird up" is a one-shot CLI call
#   that talks to an already-running daemon (via --daemon-addr) to enroll/
#   connect it. Default config lives at /var/lib/netbird/default.json, not
#   /etc/netbird - there is no /etc/netbird directory in this version.
set -euo pipefail

MGMT_URL="${1:?usage: netbird-backup-install.sh <management-url> <setup-key> <wt1-udp-port>}"
SETUP_KEY="${2:?usage: netbird-backup-install.sh <management-url> <setup-key> <wt1-udp-port>}"
WT1_PORT="${3:?usage: netbird-backup-install.sh <management-url> <setup-key> <wt1-udp-port>}"

if [ -f /var/lib/netbird-backup/backup.json ]; then
    echo "netbird-backup already installed (/var/lib/netbird-backup/backup.json exists) - aborting, remove it first if you want to reinstall"
    exit 1
fi

if ! command -v netbird >/dev/null 2>&1; then
    echo "netbird binary not found - install the primary NetBird client first"
    exit 1
fi

mkdir -p /var/lib/netbird-backup
mkdir -p /var/log/netbird-backup

# Install the systemd unit for the long-lived backup daemon process.
cp "$(dirname "$0")/netbird-backup.service.template" /etc/systemd/system/netbird-backup.service
systemctl daemon-reload
systemctl enable netbird-backup
systemctl start netbird-backup

# Give the daemon a moment to open its control socket before we talk to it.
for i in $(seq 1 10); do
    [ -S /var/run/netbird-backup.sock ] && break
    sleep 1
done
if [ ! -S /var/run/netbird-backup.sock ]; then
    echo "netbird-backup.service did not open its control socket in time"
    systemctl status netbird-backup --no-pager || true
    exit 1
fi

# One-time enrollment against the backup daemon's own socket. --interface-name
# and --wireguard-port here are what actually create wt1 on a dedicated port
# separate from wt0 (which already owns the netbird default, 51820).
netbird up \
  --daemon-addr unix:///var/run/netbird-backup.sock \
  --management-url "$MGMT_URL" \
  --setup-key "$SETUP_KEY" \
  --interface-name wt1 \
  --wireguard-port "$WT1_PORT"

sleep 3
netbird status --daemon-addr unix:///var/run/netbird-backup.sock
