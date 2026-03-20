#!/bin/bash
# ProxyGuardian Dashboard — Backup
# Uso: sudo bash dashboard-backup.sh [destinazione.tar.gz]
# Esempio: bash dashboard-backup.sh /tmp/pg-backup-$(date +%Y%m%d).tar.gz
set -e

DASHBOARD_DIR="${DASHBOARD_DIR:-/root/proxy-dashboard}"
OUT="${1:-/root/pg-backup-$(date +%Y%m%d-%H%M).tar.gz}"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info() { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}   $*"; }
err()  { echo -e "${RED}[ERR]${NC}  $*"; exit 1; }

[ -d "$DASHBOARD_DIR" ] || err "Dashboard dir non trovata: $DASHBOARD_DIR"

info "Backup ProxyGuardian Dashboard → $OUT"
info "Source: $DASHBOARD_DIR"

# Crea archivio con solo i dati necessari per il restore
tar -czf "$OUT" \
  -C "$DASHBOARD_DIR" \
  data/ \
  asn-block/ \
  .env \
  2>/dev/null || true

# Aggiungi pm2 dump
pm2 save --force >/dev/null 2>&1 || true
[ -f "$HOME/.pm2/dump.pm2" ] && tar -rf "$OUT" -C "$HOME" .pm2/dump.pm2 2>/dev/null || true

SIZE=$(du -sh "$OUT" 2>/dev/null | cut -f1)
ok "Backup completato: $OUT ($SIZE)"
echo ""
echo "  Contiene:"
tar -tzf "$OUT" | sed 's/^/    /'
echo ""
echo "  Restore sul nuovo VPS:"
echo "    scp $OUT root@NUOVO_IP:/root/"
echo "    bash dashboard-restore.sh $(basename "$OUT")"
