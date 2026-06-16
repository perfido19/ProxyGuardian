#!/usr/bin/env bash
# =============================================================
# whitelist-watcher.sh
# Monitora /etc/asn-whitelist-nets.txt con inotifywait
# Appena il file viene modificato, fa flush e aggiorna il set
# =============================================================
set -euo pipefail

WHITELIST_FILE="/etc/asn-whitelist-nets.txt"
LOG_TAG="[whitelist-watcher]"
UPDATE_SCRIPT="/usr/local/bin/update-asn-block.sh"
LOCK_FILE="/var/run/asn-block-update.lock"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $LOG_TAG $*"; }

log "Avviato — monitoro $WHITELIST_FILE"

# Crea il file se non esiste
[[ ! -f "$WHITELIST_FILE" ]] && touch "$WHITELIST_FILE"

# Loop principale
while true; do
    # Aspetta una modifica al file (close_write = scrittura completata)
    inotifywait -e close_write,moved_to,create \
        --quiet \
        "$WHITELIST_FILE" 2>/dev/null

    log "Modifica rilevata in $WHITELIST_FILE"

    # Evita aggiornamenti multipli in parallelo
    if [[ -f "$LOCK_FILE" ]]; then
        log "Aggiornamento già in corso, salto"
        continue
    fi

    touch "$LOCK_FILE"

    {
        log "Avvio flush e aggiornamento set ipset..."
        if "$UPDATE_SCRIPT" >> /var/log/update-asn-block.log 2>&1; then
            log "Aggiornamento completato con successo"
        else
            log "ERRORE durante l'aggiornamento — controlla /var/log/update-asn-block.log"
        fi
    }

    rm -f "$LOCK_FILE"

done

