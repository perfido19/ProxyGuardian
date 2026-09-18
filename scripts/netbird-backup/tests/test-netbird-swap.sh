#!/bin/bash
# Sandbox tests for netbird-swap.sh client-mode jitter + re-check.
# Never touches a real host - all systemctl/netbird/curl calls are faked.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/tests/fakebin:$PATH"
SCRIPT="$PWD/netbird-swap.sh"

pass=0
fail=0

assert_contains() {
    local haystack="$1" needle="$2" msg="$3"
    if grep -qF "$needle" <<< "$haystack"; then
        echo "  PASS: $msg"
        pass=$((pass + 1))
    else
        echo "  FAIL: $msg (expected to find: $needle)"
        echo "  --- actual log ---"
        echo "$haystack"
        fail=$((fail + 1))
    fi
}

assert_not_contains() {
    local haystack="$1" needle="$2" msg="$3"
    if grep -qF "$needle" <<< "$haystack"; then
        echo "  FAIL: $msg (did not expect to find: $needle)"
        fail=$((fail + 1))
    else
        echo "  PASS: $msg"
        pass=$((pass + 1))
    fi
}

# Helper: check for exact line in log (distinguish "systemctl start netbird" from "systemctl start netbird-backup")
assert_exact_line() {
    local haystack="$1" needle="$2" msg="$3"
    if grep -qE "^$needle$" <<< "$haystack"; then
        echo "  PASS: $msg"
        pass=$((pass + 1))
    else
        echo "  FAIL: $msg (expected exact line: $needle)"
        echo "  --- actual log ---"
        echo "$haystack"
        fail=$((fail + 1))
    fi
}

echo "=== Test 1: client mode swap-to-backup, condition still bad after jitter -> swap happens ==="
STATE_DIR=$(mktemp -d)
export FAKEBIN_LOG=$(mktemp)
echo primary > "$STATE_DIR/state"
echo 5 > "$STATE_DIR/count"
# Use 127.0.0.1:9999 (closed port, connection refused immediately)
NETBIRD_SWAP_STATE_DIR="$STATE_DIR" NETBIRD_SWAP_JITTER_MAX=0 FAKE_IPTABLES_EXIT=0 \
    "$SCRIPT" 127.0.0.1 9999 6 || true
LOG=$(cat "$FAKEBIN_LOG")
assert_contains "$LOG" "systemctl stop netbird" "swap-to-backup: stops primary"
assert_exact_line "$LOG" "systemctl start netbird-backup" "swap-to-backup: starts backup (not 'start netbird-backup' with extra suffix)"
assert_contains "$LOG" "jitter" "logs the jitter value"
assert_contains "$(cat "$STATE_DIR/state")" "backup" "state file updated to backup"

echo ""
echo "=== Test 2: client mode swap-back, cloud DOWN then STAYS DOWN after jitter -> no swap-back ==="
# Pre-set COUNT=5 + STATE=backup. First curl sees 404 (cloud up) -> enters threshold logic
# COUNT++ -> COUNT=6 -> enters new jitter block
# FAKE_CURL_CODE_SEQUENCE="404,000": second curl (re-check after jitter) sees 000 (cloud down again)
# Re-check fails, swap-back is cancelled.
STATE_DIR=$(mktemp -d)
export FAKEBIN_LOG=$(mktemp)
CURL_COUNTER=$(mktemp)
echo backup > "$STATE_DIR/state"
echo 5 > "$STATE_DIR/count"
NETBIRD_SWAP_STATE_DIR="$STATE_DIR" NETBIRD_SWAP_JITTER_MAX=0 FAKE_IPTABLES_EXIT=0 \
    FAKE_CURL_CALL_COUNTER="$CURL_COUNTER" FAKE_CURL_CODE_SEQUENCE="404,000" \
    "$SCRIPT" 10.0.0.1 8880 6 || true
LOG=$(cat "$FAKEBIN_LOG")
assert_contains "$LOG" "condition resolved during jitter wait - swap back cancelled, staying on backup" \
    "re-check found cloud down again, cancelled swap-back"
assert_not_contains "$LOG" "systemctl stop netbird-backup" "did not stop backup daemon"

echo ""
echo "=== Test 3: client mode swap-back, cloud UP throughout -> proceed with swap-back ==="
# FAKE_CURL_CALL_COUNTER with sequence "404,404": both calls return 404 (cloud up).
# First curl: 404 -> enters threshold logic, COUNT++ -> COUNT=6 -> enters jitter block
# Second curl (re-check after jitter): 404 -> re-check passes, swap-back proceeds
STATE_DIR=$(mktemp -d)
export FAKEBIN_LOG=$(mktemp)
CURL_COUNTER=$(mktemp)
echo backup > "$STATE_DIR/state"
echo 5 > "$STATE_DIR/count"
NETBIRD_SWAP_STATE_DIR="$STATE_DIR" NETBIRD_SWAP_JITTER_MAX=0 FAKE_IPTABLES_EXIT=0 \
    FAKE_CURL_CALL_COUNTER="$CURL_COUNTER" FAKE_CURL_CODE_SEQUENCE="404,404" \
    "$SCRIPT" 10.0.0.1 8880 6 || true
LOG=$(cat "$FAKEBIN_LOG")
assert_exact_line "$LOG" "systemctl stop netbird-backup" "swap-back: stops backup daemon"
assert_exact_line "$LOG" "systemctl start netbird" "swap-back: starts primary daemon"
assert_contains "$LOG" "recovery threshold reached - jitter" "jitter was applied before swap-back"

echo ""
echo "=== Test 4: client mode swap-back, cloud healthy before AND after jitter -> swap-back happens ==="
# Static FAKE_CURL_CODE=404 (always healthy), no counter needed.
# First curl (pre-threshold gate) sees 404 -> enters threshold increment
# COUNT++ -> COUNT=6 -> enters new jitter block
# Second curl (post-jitter re-check) sees 404 again -> swap-back proceeds.
STATE_DIR=$(mktemp -d)
export FAKEBIN_LOG=$(mktemp)
echo backup > "$STATE_DIR/state"
echo 5 > "$STATE_DIR/count"
NETBIRD_SWAP_STATE_DIR="$STATE_DIR" NETBIRD_SWAP_JITTER_MAX=0 FAKE_IPTABLES_EXIT=0 FAKE_CURL_CODE=404 \
    FAKE_NETBIRD_STATUS_FILE=/dev/null \
    "$SCRIPT" 10.0.0.1 8880 6 || true
LOG=$(cat "$FAKEBIN_LOG")
assert_exact_line "$LOG" "systemctl stop netbird-backup" "swap-back: stops backup"
assert_exact_line "$LOG" "systemctl start netbird" "swap-back: starts primary"
assert_contains "$LOG" "recovery threshold reached - jitter" "jitter applied"

echo ""
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
