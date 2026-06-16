#!/usr/bin/env bash
# ProxyGuardian Dashboard migration backup
# Crea un archivio completo per migrare il VPS dashboard su una nuova macchina.

set -euo pipefail

DASHBOARD_DIR="${DASHBOARD_DIR:-/root/proxy-dashboard}"
OUT="/root/proxyguardian-dashboard-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
INCLUDE_SESSIONS=0
KEEP_TMP=0

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
  sudo bash scripts/dashboard-backup.sh [opzioni] [output.tar.gz]

Opzioni:
  --include-sessions   Include data/sessions per mantenere le sessioni attive
  --keep-tmp           Non rimuove la directory temporanea di staging
  -h, --help           Mostra questo help

Esempi:
  sudo bash scripts/dashboard-backup.sh
  sudo bash scripts/dashboard-backup.sh /root/dashboard-backup.tar.gz
  sudo bash scripts/dashboard-backup.sh --include-sessions /root/dashboard-backup.tar.gz
EOF
}

while (($# > 0)); do
  case "$1" in
    --include-sessions)
      INCLUDE_SESSIONS=1
      shift
      ;;
    --keep-tmp)
      KEEP_TMP=1
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
      OUT="$1"
      shift
      ;;
  esac
done

[ "$(id -u)" -eq 0 ] || err "Esegui come root"
[ -d "$DASHBOARD_DIR" ] || err "Dashboard dir non trovata: $DASHBOARD_DIR"

TMP_DIR="$(mktemp -d /tmp/proxyguardian-dashboard-backup.XXXXXX)"
STAGE_DIR="$TMP_DIR/payload"
META_DIR="$STAGE_DIR/meta"

cleanup() {
  if [ "$KEEP_TMP" -eq 0 ]; then
    rm -rf "$TMP_DIR"
  else
    info "Directory temporanea mantenuta: $TMP_DIR"
  fi
}
trap cleanup EXIT

mkdir -p "$STAGE_DIR/root/proxy-dashboard" "$META_DIR"

copy_optional_path() {
  local source="$1"
  if [ ! -e "$source" ]; then
    warn "Percorso assente, salto: $source"
    return 0
  fi
  mkdir -p "$STAGE_DIR/$(dirname "${source#/}")"
  tar -C / -cf - "${source#/}" | tar -C "$STAGE_DIR" -xf -
}

dashboard_backup_args=(
  --exclude=.git
  --exclude=node_modules
  --exclude=dist
  --exclude=.agents
  --exclude=.claude
  --exclude=.qwen
  --exclude=CLAUDE.md
  --exclude=CONTEXT.md
  --exclude=mnt/user-data/outputs
)

if [ "$INCLUDE_SESSIONS" -ne 1 ]; then
  dashboard_backup_args+=(--exclude=data/sessions)
fi

info "Creo snapshot di $DASHBOARD_DIR"
tar -C "$DASHBOARD_DIR" "${dashboard_backup_args[@]}" -cf - . | tar -C "$STAGE_DIR/root/proxy-dashboard" -xf -

info "Aggiungo file di sistema e runtime"
SYSTEM_PATHS=(
  "/etc/GeoIP.conf"
  "/etc/cron.d/proxyguardian-geoipupdate"
  "/etc/nginx/nginx.conf"
  "/etc/nginx/conf.d"
  "/etc/nginx/sites-available"
  "/etc/nginx/sites-enabled"
  "/etc/nginx/snippets"
  "/etc/nginx/ssl"
  "/var/lib/GeoIP/GeoLite2-ASN.mmdb"
  "/var/lib/GeoIP/GeoLite2-Country.mmdb"
  "/root/.ssh/id_ed25519"
  "/root/.ssh/id_ed25519.pub"
  "/root/.pm2/dump.pm2"
)

for path in "${SYSTEM_PATHS[@]}"; do
  copy_optional_path "$path"
done

info "Raccolgo metadata"
{
  echo "created_at=$(date -Is)"
  echo "hostname=$(hostname -f 2>/dev/null || hostname)"
  echo "dashboard_dir=$DASHBOARD_DIR"
  echo "include_sessions=$INCLUDE_SESSIONS"
  echo "node_version=$(node -v 2>/dev/null || echo missing)"
  echo "npm_version=$(npm -v 2>/dev/null || echo missing)"
  echo "pm2_version=$(pm2 -v 2>/dev/null || echo missing)"
  echo "nginx_version=$(nginx -v 2>&1 | sed 's/^nginx version: //')"
  echo "netbird_status=$(systemctl is-active netbird 2>/dev/null || echo missing)"
  echo "git_head=$(git -C "$DASHBOARD_DIR" rev-parse HEAD 2>/dev/null || echo missing)"
  echo "git_branch=$(git -C "$DASHBOARD_DIR" branch --show-current 2>/dev/null || echo missing)"
} > "$META_DIR/manifest.txt"

git -C "$DASHBOARD_DIR" status --short > "$META_DIR/git-status.txt" 2>/dev/null || true
git -C "$DASHBOARD_DIR" diff --binary > "$META_DIR/git-diff.patch" 2>/dev/null || true
git -C "$DASHBOARD_DIR" ls-files --others --exclude-standard > "$META_DIR/git-untracked.txt" 2>/dev/null || true
pm2 describe proxy-dashboard > "$META_DIR/pm2-describe.txt" 2>/dev/null || true
pm2 save --force >/dev/null 2>&1 || true
netbird status > "$META_DIR/netbird-status.txt" 2>/dev/null || true
nginx -T > "$META_DIR/nginx-full.txt" 2>/dev/null || true

cat > "$META_DIR/restore-notes.txt" <<'EOF'
Restore consigliato sul nuovo VPS:
  1. Collega il nuovo VPS a NetBird prima dei test verso gli agent.
  2. Copia l'archivio sul nuovo server.
  3. Esegui: sudo bash scripts/dashboard-restore.sh <backup.tar.gz>
  4. Verifica: pm2 describe proxy-dashboard, nginx -t, curl http://127.0.0.1:5000/api/nonexistent
EOF

(cd "$STAGE_DIR" && find . -type f ! -path './meta/checksums.sha256' -print0 | sort -z | xargs -0 sha256sum > "$META_DIR/checksums.sha256")

mkdir -p "$(dirname "$OUT")"
tar -C "$STAGE_DIR" -czf "$OUT" .
chmod 600 "$OUT"

SIZE="$(du -sh "$OUT" | cut -f1)"
ok "Backup completato: $OUT ($SIZE)"
echo ""
echo "Contiene:"
echo "  - Snapshot completo di $DASHBOARD_DIR (esclusi .git, node_modules, dist)"
echo "  - Runtime dashboard (.env, data/, asn-block/, scripts, bundle agent, config locali)"
echo "  - Nginx, SSL, GeoIP, PM2 dump, chiave SSH root dashboard"
echo "  - Manifest, checksum, git status/diff, netbird status"
if [ "$INCLUDE_SESSIONS" -eq 1 ]; then
  echo "  - Sessioni attive incluse"
else
  echo "  - Sessioni attive escluse"
fi
echo ""
echo "Restore sul nuovo VPS:"
echo "  scp $OUT root@NUOVO_VPS:/root/"
echo "  sudo bash scripts/dashboard-restore.sh $(basename "$OUT")"
