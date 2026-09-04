#!/bin/bash
# geoip-fleet-update.sh — scarica UNA VOLA le GeoLite2 mmdb (account MaxMind condiviso
# dalla flotta, quota giornaliera) e le distribuisce a tutti i VPS + main via scp,
# poi reload nginx. Va sul dashboard (185.229.236.50), non nella flotta.
set -u
LOG(){ echo "$(date -u +%FT%TZ) geoip-fleet: $*"; }

FRESH_DIR=/root/geoip-fresh
mkdir -p "$FRESH_DIR"

# 1) fetch centrale (una sola chiamata a MaxMind, non 57)
geoipupdate 2>&1 | tee -a /var/log/geoip-fleet-update.log
cp -f /usr/share/GeoIP/GeoLite2-ASN.mmdb "$FRESH_DIR/" 2>/dev/null
cp -f /usr/share/GeoIP/GeoLite2-City.mmdb "$FRESH_DIR/" 2>/dev/null
cp -f /usr/share/GeoIP/GeoLite2-Country.mmdb "$FRESH_DIR/" 2>/dev/null

if [ ! -s "$FRESH_DIR/GeoLite2-ASN.mmdb" ]; then
  LOG "nessun mmdb fresco disponibile, esco senza distribuire"
  exit 1
fi

# push_host <host> <mmdb-dir-remoto> — scp diretto (niente bash -c su stringa
# interpolata: $host viene da vps.json, dato interno ma comunque non va mai
# fatto passare per una shell string costruita a mano)
push_host(){
  local host="$1" remote_dir="$2" label out
  label="${3:-$host}"
  [[ "$host" =~ ^[A-Za-z0-9.-]+$ ]] || { LOG "skip host non valido: $host"; return 1; }
  out=$(timeout 60 bash -c '
    scp -o StrictHostKeyChecking=no "$1/GeoLite2-ASN.mmdb" "root@$2:$3/GeoLite2-ASN.mmdb" &&
    scp -o StrictHostKeyChecking=no "$1/GeoLite2-City.mmdb" "root@$2:$3/GeoLite2-City.mmdb" &&
    scp -o StrictHostKeyChecking=no "$1/GeoLite2-Country.mmdb" "root@$2:$3/GeoLite2-Country.mmdb" &&
    ssh -n -o StrictHostKeyChecking=no "root@$2" "nginx -t >/dev/null 2>&1 && (systemctl reload nginx >/dev/null 2>&1 || nginx -s reload >/dev/null 2>&1)"
  ' _ "$FRESH_DIR" "$host" "$remote_dir" 2>&1)
  echo "$out" | tail -1 | sed "s#^#$label: #" >> /var/log/geoip-fleet-update.log
}

# 2) distribuzione fleet (data/vps.json) + main
python3 -c "
import json
d = json.load(open('/root/proxy-dashboard/data/vps.json'))
for v in d:
    print(v.get('host'))
" > /root/vps_hosts_only.txt

while read -r host; do
  [ -z "$host" ] && continue
  push_host "$host" /usr/share/GeoIP
done < /root/vps_hosts_only.txt

# 3) main (path diverso: /var/lib/GeoIP)
push_host 80.244.4.35 /var/lib/GeoIP main

LOG "distribuzione completata"
