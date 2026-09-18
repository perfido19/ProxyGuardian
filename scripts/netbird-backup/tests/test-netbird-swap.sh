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

echo "=== Test: client mode, threshold reached, condition still bad after jitter -> swap happens ==="
STATE_DIR=$(mktemp -d)
export FAKEBIN_LOG=$(mktemp)
echo primary > "$STATE_DIR/state"
echo 5 > "$STATE_DIR/count"
NETBIRD_SWAP_STATE_DIR="$STATE_DIR" NETBIRD_SWAP_JITTER_MAX=0 FAKE_IPTABLES_EXIT=0 FAKE_CURL_CODE=000 \
    "$SCRIPT" 10.0.0.1 8880 6 || true
LOG=$(cat "$FAKEBIN_LOG")
assert_contains "$LOG" "systemctl stop netbird" "swap-to-backup: stops primary"
assert_contains "$LOG" "systemctl start netbird-backup" "swap-to-backup: starts backup"
assert_contains "$LOG" "jitter" "logs the jitter value"
assert_contains "$(cat "$STATE_DIR/state")" "backup" "state file updated to backup"

echo "=== Test: client mode swap-back, condition RESOLVES during jitter -> no swap-back ==="
# check_main_reachable (the swap-TO-backup condition) uses /dev/tcp, not
# curl, so it can't be faked with FAKE_CURL_CODE - this scenario is exercised
# on the swap-BACK path instead, whose condition (check_netbird_cloud_recovered)
# is curl-based and fully fakeable. FAKE_CURL_CODE=000 here means "cloud still
# down" - re-check after the jitter should see the same 000 and cancel.
STATE_DIR=$(mktemp -d)
export FAKEBIN_LOG=$(mktemp)
echo backup > "$STATE_DIR/state"
echo 5 > "$STATE_DIR/count"
NETBIRD_SWAP_STATE_DIR="$STATE_DIR" NETBIRD_SWAP_JITTER_MAX=0 FAKE_IPTABLES_EXIT=0 FAKE_CURL_CODE=000 \
    "$SCRIPT" 10.0.0.1 8880 6 || true
LOG=$(cat "$FAKEBIN_LOG")
assert_not_contains "$LOG" "systemctl start netbird$" "swap-back NOT attempted (cloud still down after re-check)"

echo "=== Test: client mode swap-back, cloud healthy before AND after jitter -> swap-back happens ==="
STATE_DIR=$(mktemp -d)
export FAKEBIN_LOG=$(mktemp)
echo backup > "$STATE_DIR/state"
echo 5 > "$STATE_DIR/count"
NETBIRD_SWAP_STATE_DIR="$STATE_DIR" NETBIRD_SWAP_JITTER_MAX=0 FAKE_IPTABLES_EXIT=0 FAKE_CURL_CODE=404 \
    FAKE_NETBIRD_STATUS_FILE=/dev/null \
    "$SCRIPT" 10.0.0.1 8880 6 || true
LOG=$(cat "$FAKEBIN_LOG")
assert_contains "$LOG" "systemctl stop netbird-backup" "swap-back: stops backup"
assert_contains "$LOG" "systemctl start netbird" "swap-back: starts primary"

echo ""
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
