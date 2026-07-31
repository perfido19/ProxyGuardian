#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

WHITELIST_FILE="/etc/asn-whitelist-nets.txt"
LOCK_FILE="/var/run/tor-block-update.lock"
LOG_TAG="[update-tor-block]"

[[ -f "$WHITELIST_FILE" ]] || touch "$WHITELIST_FILE"

if [[ -f "$LOCK_FILE" ]]; then
    echo "$LOG_TAG Aggiornamento gia' in corso, salto" >&2
    exit 0
fi
touch "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

echo "$LOG_TAG $(date '+%Y-%m-%d %H:%M:%S') Avvio aggiornamento tor_exit..."
if COUNT=$(python3 /usr/local/bin/tor-to-ipset.py); then
    echo "$LOG_TAG Completato: $COUNT IP in tor_exit"
    ipset save > /etc/ipset.conf
else
    echo "$LOG_TAG ERRORE durante l'aggiornamento, ipset esistente non toccato" >&2
    exit 1
fi
