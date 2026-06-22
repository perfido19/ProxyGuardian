#!/bin/bash
STATUS=$(netbird status 2>/dev/null)
MGMT=$(echo "$STATUS" | grep "^Management:" | awk '{print $2}')
SIGNAL=$(echo "$STATUS" | grep "^Signal:" | awk '{print $2}')
if [ "$MGMT" = "Connected" ] && [ "$SIGNAL" = "Connected" ]; then
    exit 0
fi
logger -t netbird-watchdog "NetBird not connected (Management=$MGMT Signal=$SIGNAL) - restarting"
systemctl restart netbird
