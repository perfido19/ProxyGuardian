#!/bin/bash
# netbird-swap.sh - active/passive failover between the primary NetBird
# daemon (wt0, NetBird Cloud) and the backup daemon (wt1, self-hosted,
# see netbird-backup-install.sh). The two are NEVER run simultaneously -
# NetBird's Linux client manages DNS resolver config and iptables chains
# as global host resources, not scoped per instance, so running both at
# once causes the primary to lose its DNS registration and, on restart,
# fail to recreate its iptables chains (already owned by the other
# instance). See docs/superpowers/plans/2026-09-15-netbird-dual-daemon-failover-phase1-notes.md
# for the incident this was learned from.
#
# This script ONLY ever starts/stops netbird and netbird-backup. It never
# touches fail2ban, nginx, or any other service as a side effect - that
# exact pattern caused a real production incident on 2026-09-15
# (fix-iptables-post-netbird.sh restarting fail2ban on every netbird
# restart, see project_main_netbird_zero_peers_2026-09-15).
#
# Detection is impact-based with hysteresis in both directions, NOT a
# single check (a single-check trigger, like fail2ban's old maxretry=1,
# reacts to transient blips that the primary would recover from on its
# own within seconds - see the same incident above).
#
# Usage: netbird-swap.sh <main-primary-ip> <port> [fail-threshold]
#   main-primary-ip: main's wt0 mesh IP (NOT the hostname - avoids any
#                     dependency on NetBird's own DNS, which is exactly
#                     what breaks during the conflict this script exists
#                     to avoid triggering in the first place)
#   port:             the port this host actually needs from main
#                     (2096 for dynapannel, 8880 for a fleet VPS)
#   fail-threshold:   consecutive failed checks before acting (default 5)
set -euo pipefail

MAIN_IP="${1:?usage: netbird-swap.sh <main-primary-ip> <port> [fail-threshold]}"
PORT="${2:?usage: netbird-swap.sh <main-primary-ip> <port> [fail-threshold]}"
THRESHOLD="${3:-5}"

STATE_DIR=/var/lib/netbird-swap
STATE_FILE="$STATE_DIR/state"
COUNT_FILE="$STATE_DIR/count"

LOG() { echo "$(date -u +%FT%TZ) netbird-swap: $*"; logger -t netbird-swap "$*"; }

mkdir -p "$STATE_DIR"
[ -f "$STATE_FILE" ] || echo primary > "$STATE_FILE"
[ -f "$COUNT_FILE" ] || echo 0 > "$COUNT_FILE"
STATE=$(cat "$STATE_FILE")
COUNT=$(cat "$COUNT_FILE")

# Real TCP-level reachability check against main - not "netbird status",
# which can show Management: Disconnected while established tunnels keep
# working fine (verified live during the 2026-09-15 NetBird Cloud outage).
check_main_reachable() {
    timeout 5 bash -c "cat < /dev/null > /dev/tcp/$MAIN_IP/$PORT" 2>/dev/null
}

# Independent recovery signal while on backup: NetBird Cloud's own API,
# not our own primary daemon (which we'd have to disruptively restart
# just to test - this way we only attempt the real swap-back once we
# already have external evidence the outage is over).
#
# api.netbird.io/api/health has no real route and normally answers 404 -
# that 404 IS the healthy signal (confirmed live during the 2026-09-15
# outage: 503 while down, 404 once recovered). Only a connection failure
# (curl prints 000) or an explicit 503 means the service itself is down;
# any other real HTTP response means the server answered.
check_netbird_cloud_recovered() {
    local code
    code=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 5 https://api.netbird.io/api/health 2>/dev/null || echo 000)
    [ "$code" != "000" ] && [ "$code" != "503" ]
}

if [ "$STATE" = "primary" ]; then
    if check_main_reachable; then
        [ "$COUNT" = "0" ] || echo 0 > "$COUNT_FILE"
        exit 0
    fi
    COUNT=$((COUNT + 1))
    echo "$COUNT" > "$COUNT_FILE"
    LOG "primary path to $MAIN_IP:$PORT unreachable ($COUNT/$THRESHOLD)"
    if [ "$COUNT" -ge "$THRESHOLD" ]; then
        LOG "threshold reached - swapping to backup (stop netbird, start netbird-backup)"
        systemctl stop netbird
        systemctl start netbird-backup
        echo backup > "$STATE_FILE"
        echo 0 > "$COUNT_FILE"
        LOG "swapped to backup"
    fi
else
    if ! check_netbird_cloud_recovered; then
        [ "$COUNT" = "0" ] || echo 0 > "$COUNT_FILE"
        exit 0
    fi
    COUNT=$((COUNT + 1))
    echo "$COUNT" > "$COUNT_FILE"
    LOG "NetBird Cloud API looks recovered ($COUNT/$THRESHOLD consecutive checks)"
    if [ "$COUNT" -ge "$THRESHOLD" ]; then
        LOG "attempting swap back to primary (stop netbird-backup, start netbird)"
        systemctl stop netbird-backup
        systemctl start netbird
        sleep 10
        if check_main_reachable; then
            echo primary > "$STATE_FILE"
            echo 0 > "$COUNT_FILE"
            LOG "swapped back to primary, verified reachable"
        else
            LOG "primary still not reachable after restart - reverting to backup"
            systemctl stop netbird
            systemctl start netbird-backup
            echo backup > "$STATE_FILE"
            echo 0 > "$COUNT_FILE"
        fi
    fi
fi
