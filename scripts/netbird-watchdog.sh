#!/bin/bash
# Evita restart doppi se già riavviato negli ultimi 8 minuti
LOCKFILE="/tmp/netbird-watchdog.lock"
if [ -f "$LOCKFILE" ]; then
    AGE=$(( $(date +%s) - $(stat -c %Y "$LOCKFILE" 2>/dev/null || echo 0) ))
    [ "$AGE" -lt 480 ] && exit 0
fi

STATUS=$(netbird status 2>/dev/null)
MGMT=$(echo "$STATUS" | grep "^Management:" | awk '{print $2}')
SIGNAL=$(echo "$STATUS" | grep "^Signal:" | awk '{print $2}')

if [ "$MGMT" = "Connected" ] && [ "$SIGNAL" = "Connected" ]; then
    exit 0
fi

touch "$LOCKFILE"
logger -t netbird-watchdog "NetBird not connected (Management=$MGMT Signal=$SIGNAL) - restarting"
systemctl restart netbird
