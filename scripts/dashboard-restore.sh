#!/bin/bash
# ProxyGuardian Dashboard — Restore su nuovo VPS
# Uso: sudo bash dashboard-restore.sh <backup.tar.gz>
# Prerequisiti: git, Node.js 20+, npm, pm2
set -e

BACKUP="${1:-}"
DASHBOARD_DIR="${DASHBOARD_DIR:-/root/proxy-dashboard}"
REPO_URL="https://github.com/perfido19/ProxyGuardian.git"
BRANCH="${BRANCH:-main}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERR]${NC}  $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || err "Esegui come root"
[ -n "$BACKUP" ] || err "Uso: $0 <backup.tar.gz>"
[ -f "$BACKUP" ] || err "File backup non trovato: $BACKUP"

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}   ProxyGuardian Dashboard — Restore${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Node.js 20+ ──────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 20 ]; then
  info "Installazione Node.js 20..."
  apt-get update -qq
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y nodejs >/dev/null 2>&1
fi
ok "Node.js $(node -v)"

# ── PM2 ──────────────────────────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  info "Installazione PM2..."
  npm install -g pm2 >/dev/null 2>&1
fi
ok "PM2 $(pm2 -v)"

# ── Clone repo ───────────────────────────────────────────────────────────────
if [ -d "$DASHBOARD_DIR/.git" ]; then
  info "Repo già presente, aggiorno..."
  git -C "$DASHBOARD_DIR" pull
else
  info "Clone repo da GitHub..."
  git clone "$REPO_URL" -b "$BRANCH" "$DASHBOARD_DIR"
fi
ok "Repo clonato in $DASHBOARD_DIR"

# ── npm install ───────────────────────────────────────────────────────────────
info "Installazione dipendenze..."
cd "$DASHBOARD_DIR"
npm install --silent
ok "Dipendenze installate"

# ── Ripristina dati dal backup ───────────────────────────────────────────────
info "Ripristino dati da $BACKUP..."
tar -xzf "$BACKUP" -C "$DASHBOARD_DIR" data/ asn-block/ .env 2>/dev/null || warn "Alcuni file non estratti (normale se non presenti nel backup)"
ok "Dati ripristinati"
echo "  Contenuto data/:"
ls -lh "$DASHBOARD_DIR/data/" 2>/dev/null | grep -v '^total' | sed 's/^/    /'

# ── Genera SESSION_SECRET se non presente nel .env ───────────────────────────
if ! grep -q 'SESSION_SECRET=' "$DASHBOARD_DIR/.env" 2>/dev/null || grep -q 'SESSION_SECRET=$' "$DASHBOARD_DIR/.env" 2>/dev/null; then
  SECRET=$(openssl rand -hex 32)
  if grep -q 'SESSION_SECRET' "$DASHBOARD_DIR/.env" 2>/dev/null; then
    sed -i "s/SESSION_SECRET=.*/SESSION_SECRET=$SECRET/" "$DASHBOARD_DIR/.env"
  else
    echo "SESSION_SECRET=$SECRET" >> "$DASHBOARD_DIR/.env"
  fi
  ok "SESSION_SECRET generato"
fi

# ── Avvia con PM2 ────────────────────────────────────────────────────────────
info "Avvio dashboard con PM2..."
cd "$DASHBOARD_DIR"
pm2 delete proxy-dashboard 2>/dev/null || true
pm2 start npm --name proxy-dashboard -- run dev
pm2 save --force
pm2 startup 2>/dev/null | tail -1 | bash 2>/dev/null || warn "pm2 startup: esegui manualmente il comando mostrato da 'pm2 startup'"

sleep 3
if pm2 list | grep -q "proxy-dashboard.*online"; then
  ok "Dashboard avviata"
  PORT=$(grep 'PORT=' "$DASHBOARD_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "5000")
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}   RESTORE COMPLETATO ✓${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  Dashboard: ${CYAN}http://$(curl -sf --max-time 3 https://api.ipify.org || hostname -I | awk '{print $1}'):${PORT:-5000}${NC}"
  echo ""
  echo "  Prossimi passi:"
  echo "    1. Aggiorna i DNS/IP della dashboard nei VPS proxy se necessario"
  echo "    2. Verifica la connettività agente: pm2 logs proxy-dashboard"
  echo "    3. Controlla gli agenti dalla sezione VPS Manager"
  echo ""
else
  warn "Dashboard non avviata. Controlla: pm2 logs proxy-dashboard"
fi
