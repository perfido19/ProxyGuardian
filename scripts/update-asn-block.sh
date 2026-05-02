#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

SET="blocked_asn"
TMPSET="${SET}_new"
ASN_FILE="/etc/asn-blocklist.txt"
WHITELIST_FILE="/etc/asn-whitelist-nets.txt"
IPSET_SAVE_FILE="/etc/ipset.conf"
MMDB="/usr/share/GeoIP/GeoLite2-ASN.mmdb"
LOG_TAG="[update-asn-block]"

[[ ! -f "$ASN_FILE" ]] && { echo "$LOG_TAG File ASN non trovato: $ASN_FILE" >&2; exit 1; }
[[ ! -f "$MMDB"     ]] && { echo "$LOG_TAG MaxMind non trovato: $MMDB" >&2; exit 1; }

# Legge ASN dal file
ASNS=()
while IFS= read -r LINE || [[ -n "$LINE" ]]; do
    LINE="$(echo "$LINE" | tr -d '\r' | xargs)"
    [[ -z "$LINE" || "$LINE" =~ ^# ]] && continue
    ASN="$(echo "$LINE" | sed 's/#.*//' | xargs)"
    [[ -z "$ASN" ]] && continue
    ASN="${ASN^^}"; ASN="${ASN#AS}"
    ASNS+=("$ASN")
done < "$ASN_FILE"

[[ ${#ASNS[@]} -eq 0 ]] && { echo "$LOG_TAG Nessun ASN trovato" >&2; exit 1; }

echo "$LOG_TAG ASN da bloccare: ${#ASNS[@]} entries"
[[ -f "$WHITELIST_FILE" ]] && echo "$LOG_TAG Whitelist attiva: $WHITELIST_FILE"

# Crea set se non esiste
ipset create "$SET" hash:net family inet maxelem 1048576 -exist

# Controlla maxelem
CURRENT_MAXELEM=$(ipset list "$SET" | awk '/maxelem/ {for(i=1;i<=NF;i++) if($i=="maxelem") print $(i+1)}')
if [[ -n "$CURRENT_MAXELEM" ]] && [[ "$CURRENT_MAXELEM" -lt 1048576 ]]; then
    echo "$LOG_TAG Ricreo set con maxelem 1048576..."
    iptables -D INPUT -m set --match-set "$SET" src -j DROP 2>/dev/null || true
    iptables -D INPUT -m set --match-set "$SET" src -j LOG  2>/dev/null || true
    ipset destroy "$SET"
    ipset create "$SET" hash:net family inet maxelem 1048576
    iptables -I INPUT 1 -m set --match-set "$SET" src \
        -m limit --limit 10/min --limit-burst 20 -j LOG --log-prefix "[ASN-BLOCK] " --log-level 4
    iptables -I INPUT 2 -m set --match-set "$SET" src -j DROP
    iptables-save > /etc/iptables/rules.v4
fi

# Flush e ricrea set temporaneo
ipset destroy "$TMPSET" 2>/dev/null || true
ipset create "$TMPSET" hash:net family inet maxelem 1048576 -exist
ipset flush "$TMPSET"

# Popola (Python gestisce whitelist + risoluzione domini)
ipset flush "$TMPSET"
COUNT=$(python3 /usr/local/bin/asn-to-ipset.py "$TMPSET" "$MMDB" "${ASNS[@]}")
echo "$LOG_TAG Prefissi trovati: $COUNT"

if [[ -z "$COUNT" ]] || [[ "$COUNT" -eq 0 ]]; then
    echo "$LOG_TAG ATTENZIONE: nessun prefisso trovato, annullato" >&2
    ipset destroy "$TMPSET"; exit 1
fi

# Swap atomico
ipset swap "$TMPSET" "$SET"
ipset destroy "$TMPSET"
ipset save > "$IPSET_SAVE_FILE"
echo "$LOG_TAG Aggiornamento completato"

