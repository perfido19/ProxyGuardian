#!/usr/bin/env bash
# ProxyGuardian Dashboard migration restore
# Ripristina un backup dashboard su un nuovo VPS.

set -euo pipefail

BACKUP=""
DASHBOARD_DIR="${DASHBOARD_DIR:-/root/proxy-dashboard}"
REPO_URL="${REPO_URL:-https://github.com/perfido19/ProxyGuardian.git}"
BRANCH="${BRANCH:-main}"
DRY_RUN=0
SKIP_PM2=0
SKIP_NGINX=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${CYAN}[INFO]${NC} $*"; }
ok() { echo -e "${GREEN}[OK]${NC}   $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err() { echo -e "${RED}[ERR]${NC}  $*"; exit 1; }

usage() {
  cat <<'EOF'
Uso:
  sudo bash scripts/dashboard-restore.sh [opzioni] <backup.tar.gz>

Opzioni:
  --dry-run          Valida archivio e mostra cosa verrebbe ripristinato
  --skip-pm2         Non avvia/riavvia PM2 a fine restore
  --skip-nginx       Non valida e non ricarica nginx a fine restore
  -h, --help         Mostra questo help

Esempi:
  sudo bash scripts/dashboard-restore.sh /root/proxyguardian-dashboard-backup.tar.gz
  sudo bash scripts/dashboard-restore.sh --dry-run /root/proxyguardian-dashboard-backup.tar.gz
EOF
}

while (($# > 0)); do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-pm2)
      SKIP_PM2=1
      shift
      ;;
    --skip-nginx)
      SKIP_NGINX=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      err "Opzione non riconosciuta: $1"
      ;;
    *)
      BACKUP="$1"
      shift
      ;;
  esac
done

[ "$(id -u)" -eq 0 ] || err "Esegui come root"
[ -n "$BACKUP" ] || err "Uso: $0 <backup.tar.gz>"
[ -f "$BACKUP" ] || err "Backup non trovato: $BACKUP"

TMP_DIR="$(mktemp -d /tmp/proxyguardian-dashboard-restore.XXXXXX)"
EXTRACT_DIR="$TMP_DIR/extracted"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT
mkdir -p "$EXTRACT_DIR"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || err "Comando richiesto mancante: $1"
}

ensure_apt_packages() {
  local missing=()
  for pkg in "$@"; do
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    info "Installazione pacchetti: ${missing[*]}"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
  fi
}

ensure_node20() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [ "$major" -ge 20 ]; then
      ok "Node.js $(node -v)"
      return 0
    fi
  fi

  info "Installazione Node.js 20"
  ensure_apt_packages curl ca-certificates gnupg
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  ok "Node.js $(node -v)"
}

ensure_pm2() {
  if ! command -v pm2 >/dev/null 2>&1; then
    info "Installazione PM2"
    npm install -g pm2
  fi
  ok "PM2 $(pm2 -v | tail -n 1)"
}

restore_optional_path() {
  local relative="$1"
  if [ ! -e "$EXTRACT_DIR/$relative" ]; then
    return 0
  fi
  mkdir -p "/$(dirname "$relative")"
  tar -C "$EXTRACT_DIR" -cf - "$relative" | tar -C / -xf -
}

info "Estraggo archivio $BACKUP"
tar -xzf "$BACKUP" -C "$EXTRACT_DIR"

[ -f "$EXTRACT_DIR/meta/checksums.sha256" ] || err "Archivio non valido: meta/checksums.sha256 mancante"
[ -d "$EXTRACT_DIR/root/proxy-dashboard" ] || err "Archivio non valido: root/proxy-dashboard mancante"

info "Verifico checksum"
(cd "$EXTRACT_DIR" && sha256sum -c meta/checksums.sha256 >/dev/null)
ok "Checksum validi"

if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  info "Manifest"
  sed 's/^/  /' "$EXTRACT_DIR/meta/manifest.txt"
  echo ""
  info "Percorsi che verrebbero ripristinati"
  find "$EXTRACT_DIR" -maxdepth 3 -mindepth 1 | sed "s#^$EXTRACT_DIR#  #" | sort
  exit 0
fi

ensure_apt_packages git tar rsync nginx geoipupdate
ensure_node20
ensure_pm2
require_cmd sha256sum

if [ ! -d "$DASHBOARD_DIR/.git" ]; then
  info "Clone repo GitHub in $DASHBOARD_DIR"
  rm -rf "$DASHBOARD_DIR"
  git clone "$REPO_URL" -b "$BRANCH" "$DASHBOARD_DIR"
else
  info "Repo già presente, mantengo .git e applico overlay del backup"
fi

info "Ripristino snapshot dashboard"
mkdir -p "$DASHBOARD_DIR"
tar -C "$EXTRACT_DIR/root/proxy-dashboard" -cf - . | tar -C "$DASHBOARD_DIR" -xf -

info "Ripristino file di sistema"
SYSTEM_RELATIVE_PATHS=(
  "etc/GeoIP.conf"
  "etc/cron.d/proxyguardian-geoipupdate"
  "etc/nginx/nginx.conf"
  "etc/nginx/conf.d"
  "etc/nginx/sites-available"
  "etc/nginx/sites-enabled"
  "etc/nginx/snippets"
  "etc/nginx/ssl"
  "var/lib/GeoIP/GeoLite2-ASN.mmdb"
  "var/lib/GeoIP/GeoLite2-Country.mmdb"
  "root/.ssh/id_ed25519"
  "root/.ssh/id_ed25519.pub"
  "root/.pm2/dump.pm2"
)

for path in "${SYSTEM_RELATIVE_PATHS[@]}"; do
  restore_optional_path "$path"
done

info "Normalizzo permessi"
chown -R root:root "$DASHBOARD_DIR"
chmod 755 "$DASHBOARD_DIR"
[ -f "$DASHBOARD_DIR/.env" ] && chmod 600 "$DASHBOARD_DIR/.env"
[ -d "$DASHBOARD_DIR/data" ] && chmod 755 "$DASHBOARD_DIR/data"
[ -f "$DASHBOARD_DIR/data/.session-secret" ] && chmod 600 "$DASHBOARD_DIR/data/.session-secret"
[ -d "$DASHBOARD_DIR/data/sessions" ] && chmod 700 "$DASHBOARD_DIR/data/sessions"
[ -f /root/.ssh/id_ed25519 ] && chmod 600 /root/.ssh/id_ed25519
[ -f /root/.ssh/id_ed25519.pub ] && chmod 644 /root/.ssh/id_ed25519.pub
[ -f /etc/GeoIP.conf ] && chmod 600 /etc/GeoIP.conf
[ -f /etc/cron.d/proxyguardian-geoipupdate ] && chmod 644 /etc/cron.d/proxyguardian-geoipupdate
if [ -d /etc/nginx/ssl ]; then
  find /etc/nginx/ssl -type f -name '*.key' -exec chmod 600 {} +
  find /etc/nginx/ssl -type f ! -name '*.key' -exec chmod 644 {} +
fi

info "Installazione dipendenze Node"
cd "$DASHBOARD_DIR"
npm install

info "Build dashboard"
npm run build

if [ "$SKIP_PM2" -ne 1 ]; then
  info "Avvio dashboard con PM2"
  pm2 delete proxy-dashboard >/dev/null 2>&1 || true
  pm2 start npm --name proxy-dashboard -- run start
  pm2 save --force >/dev/null 2>&1 || true
fi

if [ "$SKIP_NGINX" -ne 1 ]; then
  info "Verifica e reload nginx"
  nginx -t
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl restart nginx
fi

info "Smoke test locale"
HTTP_CODE="$(curl -sS -o /tmp/proxyguardian-restore-smoke.json -w '%{http_code}' http://127.0.0.1:5000/api/nonexistent || true)"
echo "  /api/nonexistent -> $HTTP_CODE"

if command -v netbird >/dev/null 2>&1; then
  if netbird status >/dev/null 2>&1; then
    ok "NetBird presente"
  else
    warn "NetBird installato ma non connesso: completa il join prima di usare gli agent"
  fi
else
  warn "NetBird non installato: installa/join manualmente sul nuovo VPS"
fi

echo ""
ok "Restore completato"
echo ""
echo "Prossimi controlli consigliati:"
echo "  1. pm2 describe proxy-dashboard"
echo "  2. nginx -t"
echo "  3. curl http://127.0.0.1:5000/api/nonexistent"
echo "  4. netbird status"
echo "  5. Accesso web dashboard e test di una VPS dalla UI"
