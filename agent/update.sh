#!/bin/bash
# ProxyGuardian Agent - Aggiornamento
# Uso: curl -fsSL https://raw.githubusercontent.com/perfido19/ProxyGuardian/main/agent/update.sh | sudo bash
set -e

REPO_URL="https://raw.githubusercontent.com/perfido19/ProxyGuardian/main/agent"
AGENT_DIR="/opt/proxy-guardian-agent"
SERVICE_NAME="proxy-guardian-agent"
SUDOERS_FILE="/etc/sudoers.d/proxy-guardian-agent"
AGENT_USER="pgagent"

# ── Colori ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERR]${NC}  $*"; exit 1; }

# ── Root check ───────────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || error "Esegui con sudo o come root"

# ── Verifica installazione esistente ─────────────────────────────────────────
[ -d "$AGENT_DIR" ] || error "Agent non trovato in $AGENT_DIR. Usa install.sh per una nuova installazione."
[ -f "$AGENT_DIR/.env" ] || error "File .env non trovato. Installazione corrotta."

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}   ProxyGuardian Agent - Aggiornamento${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Backup bundle corrente ────────────────────────────────────────────────────
cp "$AGENT_DIR/index.js" "$AGENT_DIR/index.js.bak"
info "Backup creato: index.js.bak"

# ── Download nuovo bundle ─────────────────────────────────────────────────────
info "Download nuovo agent bundle..."
curl -fsSL "$REPO_URL/agent-bundle.js" -o "$AGENT_DIR/index.js" || {
  warn "Download fallito, ripristino backup..."
  cp "$AGENT_DIR/index.js.bak" "$AGENT_DIR/index.js"
  error "Aggiornamento fallito"
}
chown "$AGENT_USER:$AGENT_USER" "$AGENT_DIR/index.js"
ok "Bundle aggiornato"

# ── Aggiorna sudoers ─────────────────────────────────────────────────────────
info "Aggiornamento sudoers..."
cat > "$SUDOERS_FILE" << SUDOEOF
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl status *
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl start nginx
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl stop nginx
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart nginx
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl reload nginx
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl start fail2ban
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl stop fail2ban
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart fail2ban
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl start mariadb
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl stop mariadb
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart mariadb
$AGENT_USER ALL=(ALL) NOPASSWD: /usr/bin/fail2ban-client *
$AGENT_USER ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t
$AGENT_USER ALL=(ALL) NOPASSWD: /usr/sbin/nginx
$AGENT_USER ALL=(ALL) NOPASSWD: /usr/sbin/ipset *
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl start netbird
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl stop netbird
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart netbird
$AGENT_USER ALL=(ALL) NOPASSWD: /usr/sbin/iptables *
$AGENT_USER ALL=(ALL) NOPASSWD: /usr/sbin/iptables-save
$AGENT_USER ALL=(ALL) NOPASSWD: /usr/sbin/netfilter-persistent save
$AGENT_USER ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/iptables/rules.v4
$AGENT_USER ALL=(ALL) NOPASSWD: /usr/bin/netbird update
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart proxy-guardian-agent
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl stop proxy-guardian-agent
SUDOEOF
chmod 440 "$SUDOERS_FILE"
ok "Sudoers aggiornati"

# ── Riavvio servizio ─────────────────────────────────────────────────────────
info "Riavvio servizio..."
systemctl restart "$SERVICE_NAME"
sleep 2

# ── Verifica ─────────────────────────────────────────────────────────────────
if systemctl is-active --quiet "$SERVICE_NAME"; then
  rm -f "$AGENT_DIR/index.js.bak"
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}   AGGIORNAMENTO COMPLETATO ✓${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  Comandi utili:"
  echo -e "    systemctl status $SERVICE_NAME"
  echo -e "    journalctl -u $SERVICE_NAME -f"
  echo ""
else
  warn "Servizio non avviato, ripristino backup..."
  cp "$AGENT_DIR/index.js.bak" "$AGENT_DIR/index.js"
  systemctl restart "$SERVICE_NAME"
  error "Aggiornamento fallito. Backup ripristinato. Controlla: journalctl -u $SERVICE_NAME -n 50"
fi
