#!/bin/bash
# Backup periodico di data/vps.json + data/users.json (unico stato non recuperabile da git).
# Pensato per cron ogni 6h sul VPS dashboard. Mantiene le ultime KEEP copie per file.

set -euo pipefail

DASHBOARD_DIR="${DASHBOARD_DIR:-/root/proxy-dashboard}"
BACKUP_DIR="${BACKUP_DIR:-/root/backups}"
KEEP=20
TS="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

for f in vps.json users.json; do
  src="$DASHBOARD_DIR/data/$f"
  [ -f "$src" ] || continue
  cp "$src" "$BACKUP_DIR/${f%.json}-$TS.json"
  ls -t "$BACKUP_DIR/${f%.json}-"*.json 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
done
