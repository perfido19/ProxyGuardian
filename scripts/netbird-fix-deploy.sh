#!/bin/bash
# netbird-fix-deploy.sh — Configura restart nginx post-avvio NetBird e cleanup ipset orfani
# Uso: bash <(curl -s https://raw.githubusercontent.com/perfido19/ProxyGuardian/main/scripts/netbird-fix-deploy.sh)

set -e

# ── Colori ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info() { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}   $*"; }

[ "$(id -u)" -eq 0 ] || { echo "Esegui come root (sudo)"; exit 1; }

# ── 1. Drop-in systemd: restart nginx dopo avvio NetBird ─────────────────────
info "Creo netbird.service.d/restart-nginx.conf..."
mkdir -p /etc/systemd/system/netbird.service.d
cat > /etc/systemd/system/netbird.service.d/restart-nginx.conf << 'EOF'
[Service]
ExecStartPost=/bin/bash -c 'sleep 3 && systemctl restart nginx'
EOF
chmod 644 /etc/systemd/system/netbird.service.d/restart-nginx.conf
ok "restart-nginx.conf creato"

# ── 2. Script cleanup chain iptables e ipset orfani di NetBird ───────────────
info "Creo /usr/local/bin/netbird-ipset-cleanup.sh..."
cat > /usr/local/bin/netbird-ipset-cleanup.sh << 'EOF'
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
EOF
chmod +x /usr/local/bin/netbird-ipset-cleanup.sh
ok "netbird-ipset-cleanup.sh creato"

# ── 3. Servizio systemd di cleanup (eseguito prima di netbird.service) ────────
info "Creo netbird-cleanup.service..."
cat > /etc/systemd/system/netbird-cleanup.service << 'EOF'
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
EOF
chmod 644 /etc/systemd/system/netbird-cleanup.service
ok "netbird-cleanup.service creato"

# ── 4. Ricarica systemd e abilita il servizio ─────────────────────────────────
info "systemctl daemon-reload && enable netbird-cleanup..."
systemctl daemon-reload
systemctl enable netbird-cleanup.service
ok "netbird-cleanup.service abilitato"

echo ""
echo -e "${GREEN}Done: $(hostname)${NC}"
