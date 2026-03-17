#!/bin/bash
# ProxyGuardian Agent - Installazione automatica
set -e

AGENT_DIR="/opt/proxy-guardian-agent"
AGENT_PORT="${AGENT_PORT:-3001}"
AGENT_USER="pgagent"
SERVICE_NAME="proxy-guardian-agent"

if [ -z "$AGENT_API_KEY" ]; then
  AGENT_API_KEY=$(openssl rand -hex 32)
  echo ""; echo "╔══════════════════════════════════════════════════╗"
  echo "║  API KEY GENERATA - SALVALA ORA!                   ║"
  echo "║  $AGENT_API_KEY  ║"
  echo "╚══════════════════════════════════════════════════╝"; echo ""
fi

NETBIRD_IP=$(ip addr show | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | grep -E '^100\.' | head -1)
AGENT_BIND="${NETBIRD_IP:-0.0.0.0}"
echo "[INFO] Bind: $AGENT_BIND | Port: $AGENT_PORT"

# Node.js 20
if ! command -v node &>/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "[OK] Node.js $(node -v)"

# Utente
id "$AGENT_USER" &>/dev/null || useradd -r -m -s /bin/bash "$AGENT_USER"

# Sudoers
cat > /etc/sudoers.d/proxy-guardian-agent << SUDOEOF
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl status nginx
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl status fail2ban
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl status mariadb
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl start nginx
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl stop nginx
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart nginx
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl reload nginx
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl start fail2ban
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl stop fail2ban
$AGENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart fail2ban
$AGENT_USER ALL=(ALL) NOPASSWD: /usr/bin/fail2ban-client *
SUDOEOF
chmod 440 /etc/sudoers.d/proxy-guardian-agent
usermod -aG adm "$AGENT_USER" 2>/dev/null || true
chmod 664 /etc/nginx/*.conf /etc/fail2ban/jail.local /etc/fail2ban/fail2ban.local 2>/dev/null || true

# Copia file
mkdir -p "$AGENT_DIR"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/agent-bundle.js" ]; then
  cp "$SCRIPT_DIR/agent-bundle.js" "$AGENT_DIR/index.js"
else
  echo "[ERROR] agent-bundle.js non trovato nella stessa cartella dello script."; exit 1
fi
chown -R "$AGENT_USER:$AGENT_USER" "$AGENT_DIR"

# .env
cat > "$AGENT_DIR/.env" << ENVEOF
AGENT_API_KEY=$AGENT_API_KEY
AGENT_PORT=$AGENT_PORT
AGENT_BIND=$AGENT_BIND
ENVEOF
chmod 600 "$AGENT_DIR/.env"
chown "$AGENT_USER:$AGENT_USER" "$AGENT_DIR/.env"

# Systemd
cat > "/etc/systemd/system/$SERVICE_NAME.service" << SVCEOF
[Unit]
Description=ProxyGuardian Agent
After=network.target netbird.service
Wants=netbird.service

[Service]
Type=simple
User=$AGENT_USER
WorkingDirectory=$AGENT_DIR
EnvironmentFile=$AGENT_DIR/.env
ExecStart=/usr/bin/node $AGENT_DIR/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
sleep 2

if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo ""; echo "╔══════════════════════════════════════════════════╗"
  echo "║  INSTALLAZIONE COMPLETATA                          ║"
  echo "║  Host:    $(hostname)"; echo "║  IP:      $AGENT_BIND"
  echo "║  Porta:   $AGENT_PORT"; echo "║  API Key: $AGENT_API_KEY"
  echo "║  URL:     http://$AGENT_BIND:$AGENT_PORT           ║"
  echo "╚══════════════════════════════════════════════════╝"
else
  echo "[ERROR] Servizio non avviato. Controlla: journalctl -u $SERVICE_NAME -n 50"; exit 1
fi
