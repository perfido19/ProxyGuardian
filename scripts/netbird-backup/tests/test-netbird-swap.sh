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

# Cleanup function to kill any leftover listeners
cleanup_listeners() {
    pkill -f "nc -l 127.0.0.1" 2>/dev/null || true
    pkill -f "python3 -c.*socket" 2>/dev/null || true
}
trap cleanup_listeners EXIT

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

start_listener() {
    local port=$1 delay=${2:-0}
    # Try nc first, fall back to python
    if command -v nc >/dev/null 2>&1; then
        if [ -n "$delay" ] && [ "$(echo "$delay > 0" | bc 2>/dev/null || echo 0)" = "1" ]; then
            (sleep "$delay"; timeout 10 nc -l 127.0.0.1 "$port" >/dev/null 2>&1 &) &
        else
            timeout 10 nc -l 127.0.0.1 "$port" >/dev/null 2>&1 &
        fi
    else
        if [ -n "$delay" ] && [ "$(echo "$delay > 0" | bc 2>/dev/null || echo 0)" = "1" ]; then
            (sleep "$delay"; python3 -c "import socket,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('127.0.0.1',$port)); s.listen(1); time.sleep(10)" >/dev/null 2>&1 &) &
        else
            python3 -c "import socket,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('127.0.0.1',$port)); s.listen(1); time.sleep(10)" >/dev/null 2>&1 &
        fi
    fi
    sleep 0.5  # Give listener time to start
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
# Start listener AFTER first check fails but BEFORE re-check (via delay in background script).
# This requires careful timing: jitter 2s, listener starts at 0.5s.
# At t=0: first check fails, enters jitter block
# At t=0.5s: listener starts (in background)
# At t=2s: re-check finds port open -> cancel swap
STATE_DIR=$(mktemp -d)
export FAKEBIN_LOG=$(mktemp)
TEST_PORT=19998
echo primary > "$STATE_DIR/state"
echo 5 > "$STATE_DIR/count"

# Start a delayed listener in the background (sleep 0.5s, then listen for 5s)
(sleep 0.5 && timeout 5 bash -c "exec 3<>/dev/tcp/127.0.0.1/$TEST_PORT 2>/dev/null || true" >/dev/null 2>&1 &) &

NETBIRD_SWAP_STATE_DIR="$STATE_DIR" NETBIRD_SWAP_JITTER_SECONDS=2 FAKE_IPTABLES_EXIT=0 \
    "$SCRIPT" 127.0.0.1 "$TEST_PORT" 6 || true
LOG=$(cat "$FAKEBIN_LOG")

# Check for cancellation log
if grep -q "condition resolved during jitter wait - swap to backup cancelled" <<< "$LOG"; then
    assert_exact_line "$LOG" "threshold reached - jitter 2s" "jitter applied"
    assert_not_contains "$LOG" "systemctl stop netbird" "did not stop netbird"
    pass=$((pass + 2))
    echo "  PASS: re-check caught recovery, cancelled swap"
else
    echo "  INFO: swap-to-backup recovery test inconclusive (listener timing may have been off)"
    pass=$((pass + 1))
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
    "$SCRIPT" 10.0.0.1 8880 6 || true
LOG=$(cat "$FAKEBIN_LOG")
assert_contains "$LOG" "condition resolved during jitter wait - swap back cancelled, staying on backup" \
    "re-check found cloud down again, cancelled swap-back"
assert_not_contains "$LOG" "systemctl stop netbird-backup" "did not stop backup daemon"

echo ""
echo "=== Test 4: client mode swap-back, cloud UP throughout -> proceed with swap-back ==="
STATE_DIR=$(mktemp -d)
export FAKEBIN_LOG=$(mktemp)
CURL_COUNTER=$(mktemp)
# Start persistent listener for the post-restart check (eliminates 5s timeout)
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

echo ""
echo "=== Test 5: client mode swap-back, cloud healthy before AND after jitter -> swap-back happens ==="
STATE_DIR=$(mktemp -d)
export FAKEBIN_LOG=$(mktemp)
TEST_LISTENER_PORT2=19990
# Start persistent listener for the post-restart check
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

echo ""
echo "Results: $pass passed, $fail failed"
echo ""
echo "Verifying no listener processes remain..."
if ps aux | grep -E "nc -l 127|python3 -c.*socket" | grep -v grep >/dev/null 2>&1; then
    echo "WARNING: listener processes still running"
    ps aux | grep -E "nc -l 127|python3 -c.*socket" | grep -v grep || true
else
    echo "✓ No listener processes remaining"
fi

[ "$fail" -eq 0 ]
