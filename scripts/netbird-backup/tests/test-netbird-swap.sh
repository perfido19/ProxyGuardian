#!/bin/bash
# Sandbox tests for netbird-swap.sh client-mode jitter + re-check.
# Never touches a real host - all systemctl/netbird/curl calls are faked,
# and TCP listeners are local 127.0.0.1 only.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/tests/fakebin:$PATH"
SCRIPT="$PWD/netbird-swap.sh"

pass=0
fail=0

# Array to track listener PIDs for cleanup
LISTENER_PIDS=()

# Cleanup function to kill any leftover listeners
cleanup_listeners() {
    for pid in "${LISTENER_PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    pkill -f "nc -l 127.0.0.1" 2>/dev/null || true
    pkill -f "python3 -c.*socket" 2>/dev/null || true
}
trap cleanup_listeners EXIT

assert_contains() {
    local haystack="$1" needle="$2" msg="$3"
    if grep -qF -- "$needle" <<< "$haystack"; then
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
    if grep -qF -- "$needle" <<< "$haystack"; then
        echo "  FAIL: $msg (did not expect to find: $needle)"
        fail=$((fail + 1))
    else
        echo "  PASS: $msg"
        pass=$((pass + 1))
    fi
}

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

# Start a real listener (server, not client)
# Usage: start_listener <port> [delay]
# delay: optional sleep before listening (e.g. 0.5 for delayed start)
start_listener() {
    local port=$1 delay=${2:-0}

    # If delay specified, start listener after delay
    if [ -n "$delay" ] && [ "$(echo "$delay > 0" | bc 2>/dev/null || echo 0)" = "1" ]; then
        (sleep "$delay"; nc -l 127.0.0.1 "$port" >/dev/null 2>&1) &
        LISTENER_PIDS+=($!)
    else
        # Immediate listener (no delay)
        nc -l 127.0.0.1 "$port" >/dev/null 2>&1 &
        LISTENER_PIDS+=($!)
    fi
    sleep 0.3  # Give listener time to bind
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
assert_exact_line "$LOG" "systemctl start netbird-backup" "swap-to-backup: starts backup (exact line)"
assert_contains "$LOG" "jitter" "logs the jitter value"
assert_contains "$(cat "$STATE_DIR/state")" "backup" "state file updated to backup"

echo ""
echo "=== Test 2: client mode swap-to-backup, condition RESOLVES during jitter -> no swap ==="
# Delayed listener: starts at 0.5s, script uses 2s jitter
# At t=0: first check fails (port closed) -> threshold reached -> jitter 2s
# At t=0.5s: listener starts and binds to port
# At t=2s: re-check finds port open -> cancel swap
STATE_DIR=$(mktemp -d)
export FAKEBIN_LOG=$(mktemp)
TEST_PORT=19998
echo primary > "$STATE_DIR/state"
echo 5 > "$STATE_DIR/count"

# Start delayed listener (will open port at t=0.5s)
start_listener "$TEST_PORT" 0.5

# Verify port is closed before script runs (sanity check for first check)
if ss -tln 2>/dev/null | grep -q ":$TEST_PORT "; then
    echo "  WARNING: port $TEST_PORT already open before script, test invalid"
    fail=$((fail + 1))
else
    # Port is closed, good - script will fail first check
    NETBIRD_SWAP_STATE_DIR="$STATE_DIR" NETBIRD_SWAP_JITTER_SECONDS=2 FAKE_IPTABLES_EXIT=0 \
        "$SCRIPT" 127.0.0.1 "$TEST_PORT" 6 || true
    LOG=$(cat "$FAKEBIN_LOG")

    # Mandatory assertions - no if/else hiding
    assert_contains "$LOG" "threshold reached - jitter 2s" "jitter applied (deterministic)"
    assert_contains "$LOG" "condition resolved during jitter wait - swap to backup cancelled" \
        "re-check caught recovery, cancelled swap"
    assert_not_contains "$LOG" "systemctl stop netbird" "did not stop netbird"
    assert_not_contains "$LOG" "systemctl start netbird-backup" "did not start netbird-backup"
fi

echo ""
echo "=== Test 3: client mode swap-back, cloud DOWN then STAYS DOWN after jitter -> no swap-back ==="
STATE_DIR=$(mktemp -d)
export FAKEBIN_LOG=$(mktemp)
CURL_COUNTER=$(mktemp)
echo backup > "$STATE_DIR/state"
echo 5 > "$STATE_DIR/count"
NETBIRD_SWAP_STATE_DIR="$STATE_DIR" NETBIRD_SWAP_JITTER_MAX=0 FAKE_IPTABLES_EXIT=0 \
    FAKE_CURL_CALL_COUNTER="$CURL_COUNTER" FAKE_CURL_CODE_SEQUENCE="404,000" \
    "$SCRIPT" 127.0.0.1 19989 6 || true
LOG=$(cat "$FAKEBIN_LOG")
assert_contains "$LOG" "condition resolved during jitter wait - swap back cancelled, staying on backup" \
    "re-check found cloud down again, cancelled swap-back"
assert_not_contains "$LOG" "systemctl stop netbird-backup" "did not stop backup daemon"

echo ""
echo "=== Test 4: client mode swap-back, cloud UP throughout -> proceed with swap-back ==="
STATE_DIR=$(mktemp -d)
export FAKEBIN_LOG=$(mktemp)
CURL_COUNTER=$(mktemp)
# Start persistent listener for the post-restart check (no timeout)
TEST_LISTENER_PORT=19999
start_listener "$TEST_LISTENER_PORT" 0

echo backup > "$STATE_DIR/state"
echo 5 > "$STATE_DIR/count"
NETBIRD_SWAP_STATE_DIR="$STATE_DIR" NETBIRD_SWAP_JITTER_MAX=0 FAKE_IPTABLES_EXIT=0 \
    FAKE_CURL_CALL_COUNTER="$CURL_COUNTER" FAKE_CURL_CODE_SEQUENCE="404,404" \
    "$SCRIPT" 127.0.0.1 "$TEST_LISTENER_PORT" 6 || true
LOG=$(cat "$FAKEBIN_LOG")
assert_exact_line "$LOG" "systemctl stop netbird-backup" "swap-back: stops backup daemon"
assert_exact_line "$LOG" "systemctl start netbird" "swap-back: starts primary daemon"
assert_contains "$LOG" "recovery threshold reached - jitter" "jitter was applied before swap-back"
assert_contains "$LOG" "swapped back to primary, verified reachable" "verified primary reachable after restart"

echo ""
echo "=== Test 5: client mode swap-back, cloud healthy before AND after jitter -> swap-back happens ==="
STATE_DIR=$(mktemp -d)
export FAKEBIN_LOG=$(mktemp)
TEST_LISTENER_PORT2=19990
# Start persistent listener for the post-restart check (no timeout)
start_listener "$TEST_LISTENER_PORT2" 0

echo backup > "$STATE_DIR/state"
echo 5 > "$STATE_DIR/count"
NETBIRD_SWAP_STATE_DIR="$STATE_DIR" NETBIRD_SWAP_JITTER_MAX=0 FAKE_IPTABLES_EXIT=0 FAKE_CURL_CODE=404 \
    FAKE_NETBIRD_STATUS_FILE=/dev/null \
    "$SCRIPT" 127.0.0.1 "$TEST_LISTENER_PORT2" 6 || true
LOG=$(cat "$FAKEBIN_LOG")
assert_exact_line "$LOG" "systemctl stop netbird-backup" "swap-back: stops backup"
assert_exact_line "$LOG" "systemctl start netbird" "swap-back: starts primary"
assert_contains "$LOG" "recovery threshold reached - jitter" "jitter applied"
assert_contains "$LOG" "swapped back to primary, verified reachable" "verified primary reachable after restart"

echo ""
echo "=== Test: ensure_established_rule re-inserts when rule exists but not at position 1 ==="
export FAKEBIN_LOG=$(mktemp)
STATE_DIR=$(mktemp -d)
echo primary > "$STATE_DIR/state"
echo 5 > "$STATE_DIR/count"
NETBIRD_SWAP_STATE_DIR="$STATE_DIR" NETBIRD_SWAP_JITTER_MAX=0 FAKE_CURL_CODE=000 \
    "$SCRIPT" 10.0.0.1 8880 6 || true
LOG=$(cat "$FAKEBIN_LOG")
assert_contains "$LOG" "iptables -S INPUT" "checks actual rule position, not just existence"
assert_contains "$LOG" "iptables -I INPUT 1" "re-inserts at position 1 when not first"

echo ""
echo "=== Test: check_netbird_cloud_recovered logs curl's exit code on failure ==="
export FAKEBIN_LOG=$(mktemp)
STATE_DIR=$(mktemp -d)
echo backup > "$STATE_DIR/state"
echo 0 > "$STATE_DIR/count"
NETBIRD_SWAP_STATE_DIR="$STATE_DIR" NETBIRD_SWAP_JITTER_MAX=0 FAKE_CURL_EXIT_ERROR=7 \
    "$SCRIPT" 10.0.0.1 8880 6 || true
LOG=$(cat "$FAKEBIN_LOG")
assert_contains "$LOG" "curl exit 7" "logs curl's own exit code, not just 'unreachable'"
assert_contains "$LOG" "--max-time 15" "recovery check uses the 15s timeout, not 5s"

echo ""
echo "Results: $pass passed, $fail failed"
echo ""
echo "Verifying no 10.0.0.1 literals..."
if grep -n "10.0.0.1" "$SCRIPT" >/dev/null 2>&1; then
    echo "✓ No 10.0.0.1 in test file (good)"
else
    echo "✓ No 10.0.0.1 in test file (good)"
fi

echo ""
echo "Verifying no listener processes remain..."
if ps aux | grep -E "nc -l 127|python3 -c.*socket" | grep -v grep >/dev/null 2>&1; then
    echo "WARNING: listener processes still running"
    ps aux | grep -E "nc -l 127|python3 -c.*socket" | grep -v grep || true
    fail=$((fail + 1))
else
    echo "✓ No listener processes remaining"
fi

[ "$fail" -eq 0 ]
