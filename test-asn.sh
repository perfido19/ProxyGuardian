#!/bin/bash
ENV=/opt/proxy-guardian-agent/.env
KEY=$(grep AGENT_API_KEY $ENV | cut -d= -f2)
BIND=$(grep AGENT_BIND $ENV | cut -d= -f2)
BASE="http://$BIND:3001"

echo "KEY=$KEY  BASE=$BASE"
echo

echo "=== /api/asn/status ==="
curl -sf -H "x-api-key: $KEY" "$BASE/api/asn/status" | python3 -m json.tool 2>/dev/null || echo "FAIL/EMPTY"

echo
echo "=== /api/asn/whitelist ==="
curl -sf -H "x-api-key: $KEY" "$BASE/api/asn/whitelist" | python3 -m json.tool 2>/dev/null || echo "FAIL/EMPTY"

echo
echo "=== /api/asn/log (prime 5 righe) ==="
curl -sf -H "x-api-key: $KEY" "$BASE/api/asn/log" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(l) for l in d.get('lines',[])[:5]]" 2>/dev/null || echo "FAIL/EMPTY"

echo
echo "=== test-ip 8.8.8.8 ==="
curl -sf -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{"ip":"8.8.8.8"}' "$BASE/api/asn/test-ip" | python3 -m json.tool 2>/dev/null || echo "FAIL/EMPTY"

echo
echo "=== /api/asn/stats (cache) ==="
curl -sf -H "x-api-key: $KEY" "$BASE/api/asn/stats" | python3 -c "import json,sys; d=json.load(sys.stdin); print('totalPrefixes:', d.get('totalPrefixes'), '| top entries:', len(d.get('top',[])))" 2>/dev/null || echo "FAIL/EMPTY"
