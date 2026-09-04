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

# 2) distribuzione fleet (data/vps.json) + main
python3 -c "
import json
d = json.load(open('/root/proxy-dashboard/data/vps.json'))
for v in d:
    print(v.get('host'))
" > /root/vps_hosts_only.txt

while read -r host; do
  [ -z "$host" ] && continue
  timeout 60 bash -c "
    scp -o StrictHostKeyChecking=no '$FRESH_DIR/GeoLite2-ASN.mmdb' root@$host:/usr/share/GeoIP/GeoLite2-ASN.mmdb &&
    scp -o StrictHostKeyChecking=no '$FRESH_DIR/GeoLite2-City.mmdb' root@$host:/usr/share/GeoIP/GeoLite2-City.mmdb &&
    scp -o StrictHostKeyChecking=no '$FRESH_DIR/GeoLite2-Country.mmdb' root@$host:/usr/share/GeoIP/GeoLite2-Country.mmdb &&
    ssh -n -o StrictHostKeyChecking=no root@$host 'nginx -t >/dev/null 2>&1 && (systemctl reload nginx >/dev/null 2>&1 || nginx -s reload >/dev/null 2>&1)'
  " 2>&1 | tail -1 | sed "s#^#$host: #" >> /var/log/geoip-fleet-update.log
done < /root/vps_hosts_only.txt

# 3) main (path diverso: /var/lib/GeoIP)
timeout 60 bash -c "
  scp -o StrictHostKeyChecking=no '$FRESH_DIR/GeoLite2-ASN.mmdb' root@80.244.4.35:/var/lib/GeoIP/GeoLite2-ASN.mmdb &&
  scp -o StrictHostKeyChecking=no '$FRESH_DIR/GeoLite2-City.mmdb' root@80.244.4.35:/var/lib/GeoIP/GeoLite2-City.mmdb &&
  scp -o StrictHostKeyChecking=no '$FRESH_DIR/GeoLite2-Country.mmdb' root@80.244.4.35:/var/lib/GeoIP/GeoLite2-Country.mmdb &&
  ssh -n -o StrictHostKeyChecking=no root@80.244.4.35 'nginx -t >/dev/null 2>&1 && (systemctl reload nginx >/dev/null 2>&1 || nginx -s reload >/dev/null 2>&1)'
" 2>&1 | tail -1 | sed 's#^#main: #' >> /var/log/geoip-fleet-update.log

LOG "distribuzione completata"
