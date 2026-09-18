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
# Usage: netbird-swap.sh <main-primary-ip|self> <port> [fail-threshold]
#   main-primary-ip: main's wt0 mesh IP (NOT the hostname - avoids any
#                     dependency on NetBird's own DNS, which is exactly
#                     what breaks during the conflict this script exists
#                     to avoid triggering in the first place). Use the
#                     literal string "self" ONLY on main itself - main
#                     can't check "reachability to main", and swapping
#                     main's own daemon is far more disruptive (drops
#                     ALL fleet peer tunnels at once, not just one
#                     client's), so "self" mode requires TWO independent
#                     signals to agree (local netbird status AND NetBird
#                     Cloud's own API) before considering itself down -
#                     see check_self_healthy below.
#   port:             the port this host actually needs from main
#                     (2096 for dynapannel, 8880 for a fleet VPS).
#                     Ignored (pass "-") when target is "self".
#   fail-threshold:   consecutive failed checks before acting (default 6,
#                     i.e. 2 minutes at the standard 20s timer interval -
#                     short enough to matter during a real outage, long
#                     enough that a single transient blip like the ~20s
#                     one on 2026-09-15 09:44 does not trigger a swap)
set -euo pipefail

MAIN_IP="${1:?usage: netbird-swap.sh <main-primary-ip|self> <port> [fail-threshold]}"
PORT="${2:?usage: netbird-swap.sh <main-primary-ip|self> <port> [fail-threshold]}"
THRESHOLD="${3:-6}"

STATE_DIR="${NETBIRD_SWAP_STATE_DIR:-/var/lib/netbird-swap}"
STATE_FILE="$STATE_DIR/state"
COUNT_FILE="$STATE_DIR/count"

LOG() { echo "$(date -u +%FT%TZ) netbird-swap: $*"; logger -t netbird-swap "$*"; }

# Stagger daemon restarts across ~90s when a real outage hits all 58 hosts
# (main + dynapannel + 56 fleet VPS) simultaneously, so they don't hammer
# main's backup daemon all at once while it's cold-starting. 90s / 58 hosts
# ≈ 1.5s per host on average. Only applies to client mode (MAIN_IP!=self);
# main doesn't use jitter (single host, no herd to stagger). Uses /dev/urandom
# (not $RANDOM, which is seeded per-bash and correlates across near-simultaneous
# invocations) to extract random delay, then re-checks the trigger condition
# before acting — if it resolved during the wait, the swap is cancelled entirely.
JITTER_MAX="${NETBIRD_SWAP_JITTER_MAX:-90}"
# Validate that JITTER_MAX is numeric to avoid cryptic failures under set -euo pipefail
case "$JITTER_MAX" in ''|*[!0-9]*) JITTER_MAX=90;; esac

# Random delay before executing a client-mode swap, so that when main has a
# real outage the 50+ hosts watching it don't all restart their WireGuard
# daemon in the same second and hammer main's backup daemon while it's
# already cold-starting. /dev/urandom, not $RANDOM: $RANDOM is seeded per
# bash process and hosts invoked at nearly the same wall-clock time (which is
# exactly the scenario this exists for) can end up correlated. Not applied in
# self mode (MAIN_IP=self) - a single host has no herd to stagger.
jitter_seconds() {
    if [ "$JITTER_MAX" -le 0 ]; then
        echo 0
        return
    fi
    echo $(( $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % (JITTER_MAX + 1) ))
}

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

# main-only ("self" mode) health check. Unhealthy ONLY if BOTH signals
# agree something is wrong: main's own primary daemon shows Management
# AND Signal disconnected, AND NetBird Cloud's own API is unreachable
# independently. Either signal alone looking fine is enough to call it
# healthy - this is the deliberately more conservative counterpart to
# check_main_reachable, because a false positive here is much costlier
# (drops every fleet peer's tunnel to main at once).
check_self_healthy() {
    local st mgmt_bad=0 sig_bad=0
    st=$(netbird status 2>/dev/null || echo "")
    echo "$st" | grep -qE "Management:[[:space:]]*Connected" || mgmt_bad=1
    echo "$st" | grep -qE "Signal:[[:space:]]*Connected" || sig_bad=1
    if [ "$mgmt_bad" = 0 ] && [ "$sig_bad" = 0 ]; then
        return 0
    fi
    check_netbird_cloud_recovered
}

check_primary_ok() {
    if [ "$MAIN_IP" = "self" ]; then
        check_self_healthy
    else
        check_main_reachable
    fi
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

# Idempotent safety net, called right after every daemon start below. The
# fleet's fix-iptables-post-netbird.sh (ExecStartPost on the netbird unit)
# rebuilds the INPUT chain on every netbird restart and does NOT include a
# generic (all-interface) ESTABLISHED,RELATED accept - only an -i wt0
# scoped one. Without the generic rule, return traffic from any host whose
# IP falls in blocked_asn (this hit 1.1.1.1 and 8.8.8.8's DNS responses
# live on 2026-09-16 during this script's own testing) gets dropped,
# breaking all outbound connectivity including NetBird's own reconnection.
# A fleet-wide dashboard poller (ensureEstablishedFleet, hourly) already
# guards against this long-term, but every restart this script triggers
# reopens the gap for up to that full hour - so assert it here too,
# immediately, every time.
ensure_established_rule() {
    iptables -C INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || {
        iptables -I INPUT 1 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
        command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null 2>&1
        LOG "re-asserted generic ESTABLISHED,RELATED accept rule (was missing after daemon restart)"
    }
}

if [ "$STATE" = "primary" ]; then
    if check_primary_ok; then
        [ "$COUNT" = "0" ] || echo 0 > "$COUNT_FILE"
        exit 0
    fi
    COUNT=$((COUNT + 1))
    echo "$COUNT" > "$COUNT_FILE"
    LOG "primary path to $MAIN_IP:$PORT unreachable ($COUNT/$THRESHOLD)"
    if [ "$COUNT" -ge "$THRESHOLD" ]; then
        if [ "$MAIN_IP" = "self" ]; then
            LOG "threshold reached - swapping to backup (stop netbird, start netbird-backup)"
        else
            J=$(jitter_seconds)
            LOG "threshold reached - jitter ${J}s before swap to backup"
            sleep "$J"
            if check_primary_ok; then
                LOG "condition resolved during jitter wait - swap to backup cancelled"
                echo 0 > "$COUNT_FILE"
                exit 0
            fi
            LOG "threshold still reached after jitter - swapping to backup (stop netbird, start netbird-backup)"
        fi
        systemctl stop netbird
        systemctl start netbird-backup
        ensure_established_rule
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
        if [ "$MAIN_IP" != "self" ]; then
            J=$(jitter_seconds)
            LOG "recovery threshold reached - jitter ${J}s before swap back to primary"
            sleep "$J"
            if ! check_netbird_cloud_recovered; then
                LOG "condition resolved during jitter wait - swap back cancelled, staying on backup"
                echo 0 > "$COUNT_FILE"
                exit 0
            fi
        fi
        LOG "attempting swap back to primary (stop netbird-backup, start netbird)"
        systemctl stop netbird-backup
        systemctl start netbird
        ensure_established_rule
        # 45s, not 10s: a fresh reconnect after real downtime (the outage
        # that triggered the swap, plus however long we stayed on backup)
        # needs real time to renegotiate management/signal/P2P - verified
        # live on 2026-09-16 that 10s was not enough and caused a spurious
        # revert-to-backup even though the primary was actually fine.
        sleep 45
        if check_primary_ok; then
            echo primary > "$STATE_FILE"
            echo 0 > "$COUNT_FILE"
            LOG "swapped back to primary, verified reachable"
        else
            LOG "primary still not reachable after restart - reverting to backup"
            systemctl stop netbird
            systemctl start netbird-backup
            ensure_established_rule
            echo backup > "$STATE_FILE"
            echo 0 > "$COUNT_FILE"
        fi
    fi
fi
