#!/bin/bash
# pg-firewall-locks.sh — assicura (idempotente, auto-heal) le regole INPUT di
# allowlist per le porte sensibili di main (:8880 streaming, :7999 MariaDB).
# Se qualcuno flusha INPUT o ricostruisce il firewall (come il 2026-07-04 con
# `iptables -F`), il boot-unit + timer (5min) ri-applicano queste regole.
#
# Sorgenti autorizzate: /etc/pg-firewall/locks.conf
#   boot:  pg-firewall-locks.service (After=netfilter-persistent.service)
#   heal:  pg-firewall-locks.timer   (OnUnitActiveSec=5min)
#
# Idempotente: se il blocco di una porta e' gia' corretto (tutti gli ACCEPT
# presenti + terminator subito dopo), non tocca nulla e non ri-salva.
set -u

CONF=/etc/pg-firewall/locks.conf
LOG(){ echo "$(date -u +%FT%TZ) pg-fw-locks: $*"; }
[ -r "$CONF" ] || { LOG "conf $CONF assente, esco"; exit 1; }

term_spec(){ case "$1" in
  7999) echo "-j REJECT --reject-with tcp-reset" ;;
  *)    echo "-j DROP" ;;
esac; }

CHANGED=0

# posizione della riga CROWDSEC_CHAIN in INPUT (ancora di inserimento)
crowdsec_pos(){ iptables -nL INPUT --line-numbers | awk '/CROWDSEC_CHAIN/{print $1; exit}'; }

# --- 1) regole "keep": rule letterali sempre presenti, PRIMA di CROWDSEC_CHAIN ---
#     (es. NetBird UDP 51820, wt0 RELATED,ESTABLISHED — mesh-critiche, mai
#      filtrabili da una entry CrowdSec sbagliata)
while IFS= read -r kargs; do
  [ -n "$kargs" ] || continue
  if ! iptables -C INPUT $kargs 2>/dev/null; then
    cp=$(crowdsec_pos); cp=${cp:-1}
    iptables -I INPUT "$cp" $kargs && { LOG "ADD keep: $kargs (pos $cp, prima di CROWDSEC_CHAIN)"; CHANGED=1; }
  fi
done < <(awk '!/^#/ && $1=="keep" {$1=""; sub(/^ /,""); print}' "$CONF")

# --- 2) blocchi porta: allowlist ACCEPT + terminator, DOPO CROWDSEC_CHAIN ---
# righe valide: "<porta> <iface|src> <valore>"
mapfile -t LINES < <(awk '!/^#/ && $1!="keep" && NF>=3 {print $1" "$2" "$3}' "$CONF")
PORTS=$(printf '%s\n' "${LINES[@]}" | awk '{print $1}' | sort -un)

for port in $PORTS; do
  read -ra TARGS <<< "$(term_spec "$port")"

  # --- costruisci lista regole ACCEPT desiderate per questa porta ---
  desired=()
  for l in "${LINES[@]}"; do
    set -- $l; [ "$1" = "$port" ] || continue
    case "$2" in
      iface) desired+=("-i $3 -p tcp --dport $port -j ACCEPT") ;;
      src)   desired+=("-s $3 -p tcp --dport $port -j ACCEPT") ;;
    esac
  done

  # --- lo stato e' gia' corretto? ---
  ok=1
  for r in "${desired[@]}"; do
    iptables -C INPUT $r 2>/dev/null || { ok=0; break; }
  done
  term_line=$(iptables -nL INPUT --line-numbers | awk -v p="dpt:$port" '
    $0 ~ p && ($2=="DROP" || $2=="REJECT") {print $1}' | tail -1)
  max_acc_line=$(iptables -nL INPUT --line-numbers | awk -v p="dpt:$port" '
    $0 ~ p && $2=="ACCEPT" {print $1}' | sort -n | tail -1)
  if [ "$ok" = 1 ] && [ -n "$term_line" ] && [ -n "$max_acc_line" ] \
     && [ "$term_line" -gt "$max_acc_line" ]; then
    LOG ":$port ok (accept x${#desired[@]} + terminator @$term_line)"
    continue
  fi

  # --- ricostruisci il blocco pulito ---
  LOG ":$port da riparare (ok=$ok term=$term_line maxacc=$max_acc_line) -> ricostruisco"
  # elimina TUTTE le regole INPUT che matchano questa dport (accept + term, in loop)
  while read -r ln; do :; done < <(iptables -nL INPUT --line-numbers | awk -v p="dpt:$port" '$0~p{print $1}')
  # cancellazione robusta: ripeti finche' spariscono
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    ln=$(iptables -nL INPUT --line-numbers | awk -v p="dpt:$port" '$0~p{print $1; exit}')
    [ -n "$ln" ] || break
    iptables -D INPUT "$ln"
  done
  # reinserisci ACCEPT + terminator subito dopo CROWDSEC_CHAIN, in ordine
  pos=$(iptables -nL INPUT --line-numbers | awk '/CROWDSEC_CHAIN/{n=$1} END{print (n?n+1:1)}')
  for r in "${desired[@]}"; do
    iptables -I INPUT "$pos" $r; pos=$((pos+1))
  done
  iptables -I INPUT "$pos" -p tcp --dport "$port" "${TARGS[@]}"
  LOG ":$port ricostruito (${#desired[@]} accept + terminator)"
  CHANGED=1
done

if [ "$CHANGED" = 1 ]; then
  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null 2>&1 && LOG "persistito (netfilter-persistent)"
  else
    iptables-save > /etc/iptables/rules.v4 && LOG "persistito -> /etc/iptables/rules.v4"
  fi
fi
exit 0
