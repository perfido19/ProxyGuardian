#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# netbird-ipset-cleanup-install.sh
#
# Installa su un VPS standalone (NON parte della fleet ProxyGuardian):
#   1) Script cleanup ipset/iptables orfani NetBird
#   2) netbird-cleanup.service  → cleanup al boot, PRIMA di netbird
#   3) drop-in netbird.service   → ExecStartPre cleanup + auto-restart on failure
#   4) netbird-watchdog.service/.timer → ogni 60s controlla netbird; se giù o
#      disconnesso esegue cleanup e riavvia netbird
#
# Estratto da agent/index.ts (NETBIRD_IPSET_CLEANUP_SH / NETBIRD_CLEANUP_SERVICE).
#
# Uso:  sudo bash netbird-ipset-cleanup-install.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Devi eseguire come root (sudo)." >&2
  exit 1
fi

# ── 1. Script di cleanup ─────────────────────────────────────────────────────
cat > /usr/local/bin/netbird-ipset-cleanup.sh <<'CLEANUP'
#!/bin/bash
declare -A CHAIN_TABLE=(
    [NETBIRD-ACL-INPUT]=filter
    [NETBIRD-RT-FWD-IN]=filter
    [NETBIRD-RT-FWD-OUT]=filter
    [NETBIRD-RT-NAT]=nat
    [NETBIRD-RT-RDR]=nat
    [NETBIRD-RT-PRE]=mangle
    [NETBIRD-RT-MSSCLAMP]=mangle
)
for chain in "${!CHAIN_TABLE[@]}"; do
    table="${CHAIN_TABLE[$chain]}"
    iptables -t "$table" -S | grep "$chain" | grep "^-A" | while read -r rule; do
        iptables -t "$table" ${rule/-A/-D} 2>/dev/null
    done
    iptables -t "$table" -F "$chain" 2>/dev/null
    iptables -t "$table" -X "$chain" 2>/dev/null
done
for ipset in $(ipset list -n 2>/dev/null | grep -i netbird); do
    ipset flush "$ipset" 2>/dev/null
    ipset destroy "$ipset" 2>/dev/null
done
CLEANUP
chmod +x /usr/local/bin/netbird-ipset-cleanup.sh

# ── 2. Watchdog: controlla netbird, ripara se serve ──────────────────────────
cat > /usr/local/bin/netbird-watchdog.sh <<'WATCHDOG'
#!/bin/bash
# Netbird sano se: servizio attivo E stato "Connected"/"Management: Connected".
need_repair=0

if ! systemctl is-active --quiet netbird; then
    need_repair=1
else
    status="$(netbird status 2>/dev/null || true)"
    # Se status vuoto o non riporta connessione management → problema
    if ! echo "$status" | grep -qiE 'Management:[[:space:]]*Connected|Daemon[[:space:]]+status:[[:space:]]*Connected'; then
        need_repair=1
    fi
fi

if [[ "$need_repair" -eq 1 ]]; then
    logger -t netbird-watchdog "NetBird problema rilevato → cleanup + restart"
    /usr/local/bin/netbird-ipset-cleanup.sh || true
    systemctl restart netbird || true
fi
WATCHDOG
chmod +x /usr/local/bin/netbird-watchdog.sh

# ── 3. Unit cleanup al boot (prima di netbird) ───────────────────────────────
cat > /etc/systemd/system/netbird-cleanup.service <<'SERVICE'
[Unit]
Description=Cleanup orphaned NetBird ipsets before start
Before=netbird.service
DefaultDependencies=no
After=network-pre.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/netbird-ipset-cleanup.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
SERVICE

# ── 4. Drop-in netbird.service: cleanup pre-start + auto-restart ──────────────
mkdir -p /etc/systemd/system/netbird.service.d
cat > /etc/systemd/system/netbird.service.d/cleanup-restart.conf <<'DROPIN'
[Unit]
Wants=netbird-cleanup.service
After=netbird-cleanup.service

[Service]
# Ogni avvio (anche restart) ripulisce ipset/iptables orfani prima di partire
ExecStartPre=/usr/local/bin/netbird-ipset-cleanup.sh
# Auto-riavvio se netbird cade
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=0
DROPIN

# ── 5. Watchdog service + timer (ogni 60s) ───────────────────────────────────
cat > /etc/systemd/system/netbird-watchdog.service <<'WDSERVICE'
[Unit]
Description=NetBird watchdog (cleanup + restart se disconnesso)
After=netbird.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/netbird-watchdog.sh
WDSERVICE

cat > /etc/systemd/system/netbird-watchdog.timer <<'WDTIMER'
[Unit]
Description=Esegue netbird-watchdog ogni 60s

[Timer]
OnBootSec=90
OnUnitActiveSec=60
AccuracySec=10

[Install]
WantedBy=timers.target
WDTIMER

# ── 6. Abilita tutto ─────────────────────────────────────────────────────────
systemctl daemon-reload
systemctl enable netbird-cleanup.service
systemctl enable --now netbird-watchdog.timer

echo "── Installato ──────────────────────────────────────────────"
echo "Cleanup:   /usr/local/bin/netbird-ipset-cleanup.sh"
echo "Watchdog:  /usr/local/bin/netbird-watchdog.sh (timer ogni 60s)"
echo
echo "Test manuale cleanup:   sudo /usr/local/bin/netbird-ipset-cleanup.sh"
echo "Stato watchdog timer:   systemctl status netbird-watchdog.timer"
echo "Log watchdog:           journalctl -t netbird-watchdog -f"
echo "Riavvio pulito netbird: sudo systemctl restart netbird"
