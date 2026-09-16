#!/bin/bash
# phase2-deploy-host.sh - full per-host setup for the NetBird dual-daemon
# failover, incorporating every lesson from the Phase 1 pilot (see
# docs/superpowers/plans/2026-09-15-netbird-dual-daemon-failover-phase1-notes.md).
# Runs ON the target fleet VPS. Idempotent and defensive: skips/warns
# instead of corrupting state when something doesn't match what's expected.
#
# Usage: phase2-deploy-host.sh <management-url> <setup-key> <wt1-port> <main-wt0-ip> <main-wt1-ip> <swap-port> <threshold>
# Requires netbird-backup-install.sh, netbird-swap.sh, and
# netbird-swap.service.template already copied alongside this script.
set -euo pipefail

MGMT_URL="${1:?}"
SETUP_KEY="${2:?}"
WT1_PORT="${3:?}"
MAIN_WT0_IP="${4:?}"
MAIN_WT1_IP="${5:?}"
SWAP_PORT="${6:?}"
THRESHOLD="${7:-6}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG() { echo "[phase2] $*"; }

# --- Step 0: pre-flight - abort if primary isn't healthy already. Never
# install onto a host that's already broken, that's a separate problem. ---
if ! netbird status 2>/dev/null | grep -qE "Management:[[:space:]]*Connected"; then
    LOG "ABORT: primary netbird not Connected on this host - not touching it"
    exit 2
fi

# --- Step 1: safety first - generic ESTABLISHED,RELATED rule. Missing
# this caused a real outage on Smarters during Phase 1 (fix-iptables-
# post-netbird.sh only adds an -i wt0 scoped one). Do this BEFORE any
# netbird restart activity below. ---
if ! iptables -C INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null; then
    iptables -I INPUT 1 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    LOG "added missing generic ESTABLISHED,RELATED rule"
fi

# --- Step 2: disable the fleet watchdog - it fights the swap script by
# auto-restarting netbird within ~1min of any stop, found on Smarters. ---
if systemctl list-unit-files netbird-watchdog.timer >/dev/null 2>&1; then
    systemctl stop netbird-watchdog.timer 2>/dev/null || true
    systemctl disable netbird-watchdog.timer 2>/dev/null || true
    LOG "disabled netbird-watchdog.timer"
fi

# --- Step 3: install netbird-backup (idempotent - the installer itself
# refuses if /var/lib/netbird-backup/backup.json already exists). ---
if [ ! -f /var/lib/netbird-backup/backup.json ]; then
    "$SCRIPT_DIR/netbird-backup-install.sh" "$MGMT_URL" "$SETUP_KEY" "$WT1_PORT"
    LOG "netbird-backup installed"
else
    LOG "netbird-backup already installed, skipping install"
fi

# --- Step 4: swap design = never both running. Stop+disable backup right
# after enrollment; only netbird-swap.sh starts it, on demand. ---
systemctl stop netbird-backup 2>/dev/null || true
systemctl disable netbird-backup 2>/dev/null || true

# --- Step 5: open wt1's WireGuard UDP port, persisted. ---
if ! iptables -C INPUT -p udp --dport "$WT1_PORT" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT -p udp --dport "$WT1_PORT" -j ACCEPT
fi
command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null 2>&1

# --- Step 6: install + enable the swap script/timer. ---
cp "$SCRIPT_DIR/netbird-swap.sh" /usr/local/sbin/netbird-swap.sh
chmod +x /usr/local/sbin/netbird-swap.sh
sed -e "s/__MAIN_IP__/${MAIN_WT0_IP}/" -e "s/__PORT__/${SWAP_PORT}/" -e "s/__THRESHOLD__/${THRESHOLD}/" \
    "$SCRIPT_DIR/netbird-swap.service.template" > /etc/systemd/system/netbird-swap.service
cp "$SCRIPT_DIR/netbird-swap.timer" /etc/systemd/system/netbird-swap.timer
mkdir -p /var/lib/netbird-swap
echo primary > /var/lib/netbird-swap/state
echo 0 > /var/lib/netbird-swap/count
systemctl daemon-reload
systemctl enable --now netbird-swap.timer
LOG "netbird-swap timer enabled"

# --- Step 7: nginx upstream fix - literal IPs, no hostname dependency,
# backup entry pointing at main's wt1. Defensive: only touch it if the
# exact expected pattern is found, never force a rewrite. ---
NGINX_CONF=/etc/nginx/nginx.conf
EXPECTED_LINE="        server main.netbird.cloud:8880;"
if grep -qF "$EXPECTED_LINE" "$NGINX_CONF" 2>/dev/null; then
    cp "$NGINX_CONF" "${NGINX_CONF}.bak-wt1-$(date +%Y%m%d%H%M%S)"
    python3 - "$NGINX_CONF" "$MAIN_WT0_IP" "$MAIN_WT1_IP" << 'PYEOF'
import sys
f, wt0, wt1 = sys.argv[1], sys.argv[2], sys.argv[3]
c = open(f).read()
old = "    upstream backend {\n        server main.netbird.cloud:8880;\n"
new = f"    upstream backend {{\n        server {wt0}:8880;\n        server {wt1}:8880 backup;\n"
n = c.count(old)
if n != 1:
    print(f"UNEXPECTED_COUNT={n}")
    sys.exit(1)
open(f, "w").write(c.replace(old, new, 1))
print("OK")
PYEOF
    if nginx -t 2>&1 | grep -q "syntax is ok"; then
        nginx -s reload
        LOG "nginx upstream fixed and reloaded"
    else
        LOG "WARNING: nginx -t failed after upstream edit - reverted, NOT reloaded"
        cp "${NGINX_CONF}.bak-wt1-"* "$NGINX_CONF" 2>/dev/null || true
    fi
else
    LOG "WARNING: nginx.conf doesn't match the expected upstream pattern - skipped, needs manual review"
fi

LOG "done"
netbird status | grep -E "Management|Peers count"
systemctl is-active netbird-swap.timer
systemctl is-active netbird-backup || true
