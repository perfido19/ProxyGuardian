#!/bin/bash
# ProxyGuardian Agent - Installazione con singolo comando
# Uso: curl -fsSL https://raw.githubusercontent.com/perfido19/ProxyGuardian/main/agent/install.sh | sudo bash
# Oppure con API key personalizzata:
# curl -fsSL ... | sudo AGENT_API_KEY=mia-chiave bash
set -e

REPO_URL="https://raw.githubusercontent.com/perfido19/ProxyGuardian/main/agent"
AGENT_DIR="/opt/proxy-guardian-agent"
AGENT_PORT="${AGENT_PORT:-3001}"
AGENT_USER="pgagent"
SERVICE_NAME="proxy-guardian-agent"

# ── Colori ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()      { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERR]${NC}  $*"; exit 1; }

# ── Root check ───────────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || error "Esegui con sudo o come root"

# ── Genera API key se non fornita ────────────────────────────────────────────
if [ -z "$AGENT_API_KEY" ]; then
  AGENT_API_KEY=$(openssl rand -hex 32)
  GENERATED_KEY=true
fi

# ── Rileva IP NetBird (100.x.x.x) o fallback a IP pubblico ──────────────────
NETBIRD_IP=$(ip addr show 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | grep -E '^100\.' | head -1)
if [ -n "$NETBIRD_IP" ]; then
  AGENT_BIND="$NETBIRD_IP"
  info "IP NetBird rilevato: $NETBIRD_IP"
else
  AGENT_BIND="0.0.0.0"
  warn "NetBird non rilevato — agent in ascolto su 0.0.0.0 (proteggi la porta $AGENT_PORT con firewall!)"
fi

PUBLIC_IP=$(curl -sf --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
HOSTNAME=$(hostname -f 2>/dev/null || hostname)

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}   ProxyGuardian Agent - Installazione${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
info "Host:   $HOSTNAME"
info "IP:     ${NETBIRD_IP:-$PUBLIC_IP}"
info "Porta:  $AGENT_PORT"
echo ""

# ── Node.js 20+ ──────────────────────────────────────────────────────────────
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -v | cut -dv -f2 | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 20 ]; then
    ok "Node.js $(node -v) già installato"
  else
    warn "Node.js $(node -v) troppo vecchio, aggiorno a v20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y nodejs >/dev/null 2>&1
    ok "Node.js $(node -v) installato"
  fi
else
  info "Installazione Node.js 20..."
  apt-get update -qq
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y nodejs >/dev/null 2>&1
  ok "Node.js $(node -v) installato"
fi

# ── Utente di sistema ────────────────────────────────────────────────────────
if id "$AGENT_USER" &>/dev/null; then
  ok "Utente $AGENT_USER già esistente"
else
  useradd -r -m -s /bin/bash "$AGENT_USER"
  ok "Utente $AGENT_USER creato"
fi

# ── Sudoers ──────────────────────────────────────────────────────────────────
cat > /etc/sudoers.d/proxy-guardian-agent << SUDOEOF
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
SUDOEOF
chmod 440 /etc/sudoers.d/proxy-guardian-agent
ok "Sudoers configurati"

# ── Permessi log e config ────────────────────────────────────────────────────
usermod -aG adm "$AGENT_USER" 2>/dev/null || true
chmod 644 /var/log/nginx/*.log 2>/dev/null || true
chmod 644 /var/log/fail2ban.log 2>/dev/null || true
[ -d /etc/nginx ] && chmod o+r /etc/nginx/*.conf /etc/nginx/conf.d/*.conf 2>/dev/null || true

# ── Scarica agent bundle ─────────────────────────────────────────────────────
mkdir -p "$AGENT_DIR"
info "Download agent bundle..."

# Se eseguito da pipe (curl|bash), scarica il bundle dalla repo
if [ ! -f "$(dirname "$0")/agent-bundle.js" ]; then
  curl -fsSL "$REPO_URL/agent-bundle.js" -o "$AGENT_DIR/index.js" || \
    error "Impossibile scaricare agent-bundle.js da $REPO_URL/agent-bundle.js"
else
  # Eseguito localmente: usa il file nella stessa cartella
  cp "$(dirname "$0")/agent-bundle.js" "$AGENT_DIR/index.js"
fi
ok "Agent bundle installato"

chown -R "$AGENT_USER:$AGENT_USER" "$AGENT_DIR"

# ── .env ─────────────────────────────────────────────────────────────────────
cat > "$AGENT_DIR/.env" << ENVEOF
AGENT_API_KEY=$AGENT_API_KEY
AGENT_PORT=$AGENT_PORT
AGENT_BIND=$AGENT_BIND
HOSTNAME=$HOSTNAME
ENVEOF
chmod 600 "$AGENT_DIR/.env"
chown "$AGENT_USER:$AGENT_USER" "$AGENT_DIR/.env"
ok ".env configurato"

# ── Carica .env nello script di avvio ────────────────────────────────────────
cat > "$AGENT_DIR/start.sh" << 'STARTEOF'
#!/bin/bash
set -a
source /opt/proxy-guardian-agent/.env
set +a
exec node /opt/proxy-guardian-agent/index.js
STARTEOF
chmod +x "$AGENT_DIR/start.sh"
chown "$AGENT_USER:$AGENT_USER" "$AGENT_DIR/start.sh"

# ── Systemd ──────────────────────────────────────────────────────────────────
cat > "/etc/systemd/system/$SERVICE_NAME.service" << SVCEOF
[Unit]
Description=ProxyGuardian Agent
After=network.target

[Service]
Type=simple
User=$AGENT_USER
WorkingDirectory=$AGENT_DIR
ExecStart=$AGENT_DIR/start.sh
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
systemctl restart "$SERVICE_NAME"
sleep 2

# ── Verifica ─────────────────────────────────────────────────────────────────
if systemctl is-active --quiet "$SERVICE_NAME"; then
  CONNECT_IP="${NETBIRD_IP:-$PUBLIC_IP}"
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}   INSTALLAZIONE COMPLETATA ✓${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  Host:     ${CYAN}$HOSTNAME${NC}"
  echo -e "  IP:       ${CYAN}$CONNECT_IP${NC}"
  echo -e "  Porta:    ${CYAN}$AGENT_PORT${NC}"
  if [ "$GENERATED_KEY" = true ]; then
    echo ""
    echo -e "  ${YELLOW}API Key (salvala ora!):${NC}"
    echo -e "  ${YELLOW}$AGENT_API_KEY${NC}"
  fi
  echo ""
  echo -e "  ${CYAN}Aggiungi questo VPS nella dashboard:${NC}"
  echo -e "    Host: $CONNECT_IP  Porta: $AGENT_PORT"
  echo ""
  echo -e "  Comandi utili:"
  echo -e "    systemctl status $SERVICE_NAME"
  echo -e "    journalctl -u $SERVICE_NAME -f"
  echo -e "    curl -H 'x-api-key: \$KEY' http://$CONNECT_IP:$AGENT_PORT/health"
  echo ""
else
  error "Servizio non avviato. Controlla: journalctl -u $SERVICE_NAME -n 50"
fi
