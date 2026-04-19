#!/usr/bin/env bash
set -euo pipefail

REPO="https://raw.githubusercontent.com/perfido19/AsnBlock/master"
ASN_FILE="/etc/asn-blocklist.txt"
WL_FILE="/etc/asn-whitelist-nets.txt"
LOG_TAG="[update-lists]"

echo "$LOG_TAG Scarico liste aggiornate da GitHub..."

cp "$ASN_FILE" "${ASN_FILE}.bak" 2>/dev/null || true
cp "$WL_FILE" "${WL_FILE}.bak" 2>/dev/null || true

if curl -fsSL "$REPO/asn-blocklist.txt" -o "${ASN_FILE}.new"; then
    LINES=$(wc -l < "${ASN_FILE}.new")
    if [[ "$LINES" -gt 100 ]]; then
        mv "${ASN_FILE}.new" "$ASN_FILE"
        echo "$LOG_TAG asn-blocklist.txt aggiornato ($LINES righe)"
    else
        rm -f "${ASN_FILE}.new"
        echo "$LOG_TAG ERRORE: file ASN scaricato sembra vuoto/corrotto, mantenuto originale" >&2
    fi
else
    echo "$LOG_TAG ERRORE: download asn-blocklist.txt fallito" >&2
fi

if curl -fsSL "$REPO/asn-whitelist-nets.txt" -o "${WL_FILE}.new"; then
    LINES=$(wc -l < "${WL_FILE}.new")
    if [[ "$LINES" -gt 5 ]]; then
        mv "${WL_FILE}.new" "$WL_FILE"
        echo "$LOG_TAG asn-whitelist-nets.txt aggiornato ($LINES righe)"
    else
        rm -f "${WL_FILE}.new"
        echo "$LOG_TAG ERRORE: whitelist scaricata sembra vuota/corrotta, mantenuta originale" >&2
    fi
else
    echo "$LOG_TAG ERRORE: download asn-whitelist-nets.txt fallito" >&2
fi

echo "$LOG_TAG Aggiorno set ipset con le nuove liste..."
/usr/local/bin/update-asn-block.sh

echo "$LOG_TAG Completato"
