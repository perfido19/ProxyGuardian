# NetBird Failover Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add anti-thundering-herd jitter to the NetBird dual-daemon failover script, harden main's own recovery path, and surface a "stuck on backup" warning in the dashboard — all without touching any of the 58 hosts currently running the old script.

**Architecture:** All changes live in the single shared shell script `scripts/netbird-backup/netbird-swap.sh` (client-mode jitter, main-only recovery hardening, established-rule position fix) plus its systemd service template, and in the two existing status-reporting code paths (`agent/index.ts` for the 56 fleet VPS, `server/netbird-swap-status.ts` for main/dynapannel via SSH) which both already expose `state`/`lastEvent` and get one new field (`stateSince`). The frontend page `client/src/pages/netbird-failover.tsx` consumes that new field to render a warning banner.

**Tech Stack:** Bash (netbird-swap.sh, systemd units), TypeScript/Express (agent, server), React/TanStack Query (frontend). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-17-netbird-failover-hardening-design.md`

## Global Constraints

- **No production deploy or rollout as part of this plan.** Every task's deliverable is code + local/pilot-sandbox test evidence. Pushing the new script to any of the 58 real hosts, or restarting `netbird`/`netbird-backup`/`nginx` on any real host, is explicitly out of scope — that is a separate decision the user makes after reviewing this work.
- Jitter (0-90s random, via `/dev/urandom`) applies **only** in client mode (`MAIN_IP != "self"`). Main's own self-mode trigger logic is never delayed and never reads any client host's state — this invariant must remain true after every task.
- Detection threshold (6 consecutive checks / 20s tick = 2 minutes) is unchanged everywhere.
- `netbird-swap.sh` must remain the *only* script that starts/stops `netbird`/`netbird-backup` — no new side effects on fail2ban, nginx, or other services (existing invariant, documented at the top of the file).

---

## Task 1: Jitter + re-check in netbird-swap.sh (client mode)

**Files:**
- Modify: `scripts/netbird-backup/netbird-swap.sh:131-180` (the two `if [ "$COUNT" -ge "$THRESHOLD" ]` branches)
- Create: `scripts/netbird-backup/tests/fakebin/` (fake `systemctl`, `netbird`, `curl`, `logger`, `iptables`, `timeout`, `netfilter-persistent` executables that log every call to a file and return controllable exit codes)
- Create: `scripts/netbird-backup/tests/test-netbird-swap.sh` (bash test harness, no framework needed — plain `set -e` assertions)

**Interfaces:**
- Produces: a new optional environment variable `NETBIRD_SWAP_JITTER_MAX` (default `90`, integer seconds) read by `netbird-swap.sh`. Setting it to `0` in tests makes jitter deterministic (no sleep) while still exercising the re-check logic.
- Produces: `jitter_seconds()` shell function inside `netbird-swap.sh` — `echo` a random integer in `[0, NETBIRD_SWAP_JITTER_MAX]` to stdout, using `/dev/urandom` (not `$RANDOM`, to avoid correlation across near-simultaneous invocations on many hosts).

- [ ] **Step 1: Write the fake command harness**

Create `scripts/netbird-backup/tests/fakebin/systemctl`:
```bash
#!/bin/bash
echo "systemctl $*" >> "$FAKEBIN_LOG"
exit "${FAKE_SYSTEMCTL_EXIT:-0}"
```

Create `scripts/netbird-backup/tests/fakebin/netbird`:
```bash
#!/bin/bash
echo "netbird $*" >> "$FAKEBIN_LOG"
cat "${FAKE_NETBIRD_STATUS_FILE:-/dev/null}"
```

Create `scripts/netbird-backup/tests/fakebin/curl`:
```bash
#!/bin/bash
echo "curl $*" >> "$FAKEBIN_LOG"
echo -n "${FAKE_CURL_CODE:-000}"
exit 0
```

Create `scripts/netbird-backup/tests/fakebin/logger`:
```bash
#!/bin/bash
echo "logger $*" >> "$FAKEBIN_LOG"
exit 0
```

Create `scripts/netbird-backup/tests/fakebin/iptables`:
```bash
#!/bin/bash
echo "iptables $*" >> "$FAKEBIN_LOG"
exit "${FAKE_IPTABLES_EXIT:-1}"
```

Create `scripts/netbird-backup/tests/fakebin/timeout`:
```bash
#!/bin/bash
# real timeout, just forwards - used by check_main_reachable's /dev/tcp probe,
# which we don't exercise in the client-mode jitter tests (main-only test uses
# the fake curl above instead)
shift
"$@"
```

Create `scripts/netbird-backup/tests/fakebin/netfilter-persistent`:
```bash
#!/bin/bash
echo "netfilter-persistent $*" >> "$FAKEBIN_LOG"
exit 0
```

Make all six executable: `chmod +x scripts/netbird-backup/tests/fakebin/*`

- [ ] **Step 2: Run the harness once to confirm it's wired correctly**

Run:
```bash
cd /home/massimo/Progetti/ProxyGuardian
export PATH="$PWD/scripts/netbird-backup/tests/fakebin:$PATH"
export FAKEBIN_LOG=$(mktemp)
systemctl is-active netbird
cat "$FAKEBIN_LOG"
```
Expected: prints `systemctl is-active netbird` (from the fake binary, confirming the fake `systemctl` on `PATH` is the one that ran, not the real one).

- [ ] **Step 3: Write the failing test for jitter + re-check (client mode, condition still true after jitter)**

Create `scripts/netbird-backup/tests/test-netbird-swap.sh`:
```bash
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
NETBIRD_SWAP_STATE_DIR="$STATE_DIR" NETBIRD_SWAP_JITTER_MAX=0 FAKE_CURL_CODE=000 \
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
NETBIRD_SWAP_STATE_DIR="$STATE_DIR" NETBIRD_SWAP_JITTER_MAX=0 FAKE_CURL_CODE=000 \
    "$SCRIPT" 10.0.0.1 8880 6 || true
LOG=$(cat "$FAKEBIN_LOG")
assert_not_contains "$LOG" "systemctl start netbird$" "swap-back NOT attempted (cloud still down after re-check)"

echo "=== Test: client mode swap-back, cloud healthy before AND after jitter -> swap-back happens ==="
STATE_DIR=$(mktemp -d)
export FAKEBIN_LOG=$(mktemp)
echo backup > "$STATE_DIR/state"
echo 5 > "$STATE_DIR/count"
NETBIRD_SWAP_STATE_DIR="$STATE_DIR" NETBIRD_SWAP_JITTER_MAX=0 FAKE_CURL_CODE=404 \
    FAKE_NETBIRD_STATUS_FILE=/dev/null \
    "$SCRIPT" 10.0.0.1 8880 6 || true
LOG=$(cat "$FAKEBIN_LOG")
assert_contains "$LOG" "systemctl stop netbird-backup" "swap-back: stops backup"
assert_contains "$LOG" "systemctl start netbird" "swap-back: starts primary"

echo ""
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
```
Make it executable: `chmod +x scripts/netbird-backup/tests/test-netbird-swap.sh`

- [ ] **Step 4: Run the test to verify it fails**

Run: `bash scripts/netbird-backup/tests/test-netbird-swap.sh`
Expected: FAIL — the script doesn't yet read `NETBIRD_SWAP_STATE_DIR`/`NETBIRD_SWAP_JITTER_MAX`, doesn't log "jitter", and the re-check-after-jitter behavior for the second test case doesn't exist yet (it would currently swap immediately with no re-check at all — actually today's script doesn't even re-check before the FIRST swap, only before swap-*back*, at a fixed 45s. The test should fail on the "logs the jitter value" and "condition RESOLVES" assertions at minimum).

- [ ] **Step 5: Implement jitter + re-check in netbird-swap.sh**

Modify `scripts/netbird-backup/netbird-swap.sh`. First, make the state directory overridable for tests (add right after the existing `STATE_DIR=` line):
```bash
STATE_DIR="${NETBIRD_SWAP_STATE_DIR:-/var/lib/netbird-swap}"
```
(replaces the existing hardcoded `STATE_DIR=/var/lib/netbird-swap` on line 50)

Add the jitter helper right after `LOG()` (after line 54):
```bash
JITTER_MAX="${NETBIRD_SWAP_JITTER_MAX:-90}"

# Random delay before executing a client-mode swap, so that when main has a
# real outage the 50+ hosts watching it don't all restart their WireGuard
# daemon in the same second and hammer main's backup daemon while it's
# already cold-starting. /dev/urandom, not $RANDOM: $RANDOM is seeded per
# bash process and hosts invoked at nearly the same wall-clock time (which is
# exactly the scenario this exists for) can end up correlated. Not applied in
# self mode (MAIN_IP=self) - a single host has no herd to stagger.
jitter_seconds() {
    if [ "$JITTER_MAX" -le 0 ]; then
        echo 0
        return
    fi
    echo $(( $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % (JITTER_MAX + 1) ))
}
```

Replace the swap-to-backup block (lines 139-147 in the current file):
```bash
    if [ "$COUNT" -ge "$THRESHOLD" ]; then
        LOG "threshold reached - swapping to backup (stop netbird, start netbird-backup)"
        systemctl stop netbird
        systemctl start netbird-backup
        ensure_established_rule
        echo backup > "$STATE_FILE"
        echo 0 > "$COUNT_FILE"
        LOG "swapped to backup"
    fi
```
with:
```bash
    if [ "$COUNT" -ge "$THRESHOLD" ]; then
        if [ "$MAIN_IP" = "self" ]; then
            LOG "threshold reached - swapping to backup (stop netbird, start netbird-backup)"
        else
            J=$(jitter_seconds)
            LOG "threshold reached - jitter ${J}s before swap to backup"
            sleep "$J"
            if check_primary_ok; then
                LOG "condition resolved during jitter wait - swap to backup cancelled"
                echo 0 > "$COUNT_FILE"
                exit 0
            fi
            LOG "threshold still reached after jitter - swapping to backup (stop netbird, start netbird-backup)"
        fi
        systemctl stop netbird
        systemctl start netbird-backup
        ensure_established_rule
        echo backup > "$STATE_FILE"
        echo 0 > "$COUNT_FILE"
        LOG "swapped to backup"
    fi
```

Replace the swap-back block (lines 156-179 in the current file):
```bash
    if [ "$COUNT" -ge "$THRESHOLD" ]; then
        LOG "attempting swap back to primary (stop netbird-backup, start netbird)"
        systemctl stop netbird-backup
        systemctl start netbird
        ensure_established_rule
        sleep 45
        if check_primary_ok; then
            echo primary > "$STATE_FILE"
            echo 0 > "$COUNT_FILE"
            LOG "swapped back to primary, verified reachable"
        else
            LOG "primary still not reachable after restart - reverting to backup"
            systemctl stop netbird
            systemctl start netbird-backup
            ensure_established_rule
            echo backup > "$STATE_FILE"
            echo 0 > "$COUNT_FILE"
        fi
    fi
```
with:
```bash
    if [ "$COUNT" -ge "$THRESHOLD" ]; then
        if [ "$MAIN_IP" != "self" ]; then
            J=$(jitter_seconds)
            LOG "recovery threshold reached - jitter ${J}s before swap back to primary"
            sleep "$J"
            if ! check_netbird_cloud_recovered; then
                LOG "condition resolved during jitter wait - swap back cancelled, staying on backup"
                echo 0 > "$COUNT_FILE"
                exit 0
            fi
        fi
        LOG "attempting swap back to primary (stop netbird-backup, start netbird)"
        systemctl stop netbird-backup
        systemctl start netbird
        ensure_established_rule
        sleep 45
        if check_primary_ok; then
            echo primary > "$STATE_FILE"
            echo 0 > "$COUNT_FILE"
            LOG "swapped back to primary, verified reachable"
        else
            LOG "primary still not reachable after restart - reverting to backup"
            systemctl stop netbird
            systemctl start netbird-backup
            ensure_established_rule
            echo backup > "$STATE_FILE"
            echo 0 > "$COUNT_FILE"
        fi
    fi
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bash scripts/netbird-backup/tests/test-netbird-swap.sh`
Expected: `Results: 6 passed, 0 failed`, exit code 0.

- [ ] **Step 7: Commit**

```bash
cd /home/massimo/Progetti/ProxyGuardian
git add scripts/netbird-backup/netbird-swap.sh scripts/netbird-backup/tests/
git commit -m "feat(netbird-swap): jitter + re-check before client-mode swap

Random 0-90s delay (env-overridable via NETBIRD_SWAP_JITTER_MAX for
testing) before executing a client-mode swap-to-backup or swap-back,
with a re-check of the trigger condition after the delay. Spreads the
fleet's daemon restarts over ~90s instead of all hitting main's backup
in the same second, and skips the swap entirely if the condition
resolved on its own during the wait. Main (self mode) is unaffected -
no jitter, no herd to stagger. Sandbox test harness included, no real
host touched.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: TimeoutStartSec on the systemd service template

**Files:**
- Modify: `scripts/netbird-backup/netbird-swap.service.template`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by later tasks — this is a standalone config fix.

- [ ] **Step 1: Check current default timeout behavior (no test framework needed - this is a one-line config value, verified by inspection)**

Run: `systemctl show netbird-swap.service -p TimeoutStartUSec 2>/dev/null || echo "n/a - service not installed on this dev machine, that's expected"`
This confirms there's no local instance to accidentally touch — the fix is a template edit only.

- [ ] **Step 2: Add TimeoutStartSec to the template**

Modify `scripts/netbird-backup/netbird-swap.service.template`:
```ini
[Unit]
Description=NetBird primary/backup swap check (oneshot)
After=network-online.target

[Service]
Type=oneshot
# 150s covers the worst case: up to 90s jitter + up to 45s post-swap-back
# verification sleep + a few seconds of actual systemctl/curl work. Without
# this, systemd's default oneshot timeout could kill the script mid-jitter,
# leaving COUNT_FILE at threshold and the state file unchanged - the next
# tick would just re-evaluate from scratch, but killing mid-swap (after
# systemctl stop netbird has already run) would be worse, so give it room.
TimeoutStartSec=150
ExecStart=/usr/local/sbin/netbird-swap.sh __MAIN_IP__ __PORT__ __THRESHOLD__
# __THRESHOLD__ default 6 = 2 minutes at this unit's 20s timer interval
```

- [ ] **Step 3: Validate the unit file syntax**

Run: `systemd-analyze verify scripts/netbird-backup/netbird-swap.service.template 2>&1 | grep -v "__MAIN_IP__\|__PORT__\|__THRESHOLD__" || true`
Expected: no fatal syntax errors reported for `TimeoutStartSec=150` itself (the template's `__PLACEHOLDER__` tokens are expected to be flagged as an invalid `ExecStart` path since this isn't a real deployed unit — that's fine and expected for a template file).

- [ ] **Step 4: Commit**

```bash
git add scripts/netbird-backup/netbird-swap.service.template
git commit -m "fix(netbird-swap): raise TimeoutStartSec to cover jitter sleep

Up to 90s jitter + 45s post-swap-back verification could exceed
systemd's default oneshot timeout. 150s gives enough headroom.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: ensure_established_rule position hardening

**Files:**
- Modify: `scripts/netbird-backup/netbird-swap.sh` (the `ensure_established_rule` function, added in Task 1's diff context around what was originally lines 123-129)
- Modify: `scripts/netbird-backup/tests/test-netbird-swap.sh` (add a position-check test)
- Modify: `scripts/netbird-backup/tests/fakebin/iptables` (extend to simulate a chain with the rule present but not first)

**Interfaces:**
- Consumes: the `FAKEBIN_LOG` pattern from Task 1.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Extend the fake iptables to simulate "rule exists but not at position 1"**

Modify `scripts/netbird-backup/tests/fakebin/iptables`:
```bash
#!/bin/bash
echo "iptables $*" >> "$FAKEBIN_LOG"
if [ "$1" = "-C" ]; then
    exit "${FAKE_IPTABLES_CHECK_EXIT:-1}"
fi
if [ "$1" = "-S" ] && [ "$2" = "INPUT" ]; then
    # Simulates the rule existing at position 4 (three other rules above it),
    # matching what was found live on main on 2026-09-17.
    printf '%s\n' \
        "-P INPUT ACCEPT" \
        "-A INPUT -i wt0 -j NETBIRD-ACL-INPUT" \
        "-A INPUT -i wt0 -j DROP" \
        "-A INPUT -p tcp -m multiport --dports 8880 -m set --match-set f2b-panel-api src -j REJECT" \
        "${FAKE_ESTABLISHED_RULE_LINE:--A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT}"
    exit 0
fi
exit "${FAKE_IPTABLES_EXIT:-0}"
```
Make executable if not already (it already is from Task 1).

- [ ] **Step 2: Write the failing test for position hardening**

Add to `scripts/netbird-backup/tests/test-netbird-swap.sh`, before the `echo "Results:"` line. `ensure_established_rule` isn't exported standalone, so it's exercised the only way it's reachable: through the script's own swap-to-backup path, which calls it right after `systemctl start netbird-backup`.
```bash
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bash scripts/netbird-backup/tests/test-netbird-swap.sh`
Expected: FAIL on `"checks actual rule position, not just existence"` — today's `ensure_established_rule` only calls `iptables -C`, never `-S INPUT`.

- [ ] **Step 4: Implement position-aware ensure_established_rule**

Replace `ensure_established_rule()` in `scripts/netbird-backup/netbird-swap.sh` (the version from Task 1, unchanged body otherwise) with:
```bash
ensure_established_rule() {
    local first_rule
    first_rule=$(iptables -S INPUT 2>/dev/null | sed -n '2p')
    case "$first_rule" in
        *"-m conntrack --ctstate"*ESTABLISHED*|*"-m state --state"*ESTABLISHED*)
            return 0
            ;;
    esac
    iptables -I INPUT 1 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null 2>&1
    LOG "re-asserted generic ESTABLISHED,RELATED accept rule at position 1 (was missing or not first after daemon restart)"
}
```
(`iptables -S INPUT` prints `-P INPUT ACCEPT` as line 1, then the actual rules starting at line 2 - checking line 2 specifically checks "is this the very first rule", not just "does a matching rule exist anywhere")

- [ ] **Step 5: Run the test to verify it passes**

Run: `bash scripts/netbird-backup/tests/test-netbird-swap.sh`
Expected: all tests pass, including the two new position-check assertions.

- [ ] **Step 6: Commit**

```bash
git add scripts/netbird-backup/netbird-swap.sh scripts/netbird-backup/tests/
git commit -m "fix(netbird-swap): ensure_established_rule checks position, not just existence

iptables -C only confirms a matching rule exists somewhere in the
chain. Found live on main on 2026-09-17: the rule existed but at
position 4, not 1 - harmless there by luck (the rules above it were
interface-scoped to wt0), but the same latent bug as the 2026-08-04
incident. Now checks the chain's actual first rule via -S INPUT and
re-inserts at position 1 whenever it isn't already first.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Main-only recovery hardening (timeout + failure-reason logging)

**Files:**
- Modify: `scripts/netbird-backup/netbird-swap.sh` (`check_netbird_cloud_recovered`)
- Modify: `scripts/netbird-backup/tests/test-netbird-swap.sh` (add a failure-logging test)
- Modify: `scripts/netbird-backup/tests/fakebin/curl` (support simulating a connect failure vs a real HTTP code)

**Interfaces:**
- Consumes: `FAKEBIN_LOG` pattern.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Extend the fake curl to report a distinguishable error**

Modify `scripts/netbird-backup/tests/fakebin/curl`:
```bash
#!/bin/bash
echo "curl $*" >> "$FAKEBIN_LOG"
if [ -n "${FAKE_CURL_EXIT_ERROR:-}" ]; then
    echo -n "000"
    exit "$FAKE_CURL_EXIT_ERROR"
fi
echo -n "${FAKE_CURL_CODE:-000}"
exit 0
```

- [ ] **Step 2: Write the failing test for failure-reason logging**

Add to `scripts/netbird-backup/tests/test-netbird-swap.sh`:
```bash
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bash scripts/netbird-backup/tests/test-netbird-swap.sh`
Expected: FAIL — today's `check_netbird_cloud_recovered` uses `--max-time 5` and never logs curl's exit code (only the resulting HTTP code, which is `000` either way for a real connection failure vs a timeout, making them indistinguishable).

- [ ] **Step 4: Implement the timeout increase + failure-reason logging**

Replace `check_netbird_cloud_recovered()` in `scripts/netbird-backup/netbird-swap.sh` with:
```bash
check_netbird_cloud_recovered() {
    local code curl_exit
    code=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 15 https://api.netbird.io/api/health 2>/dev/null)
    curl_exit=$?
    if [ "$curl_exit" -ne 0 ]; then
        LOG "netbird cloud health check failed: curl exit $curl_exit"
        return 1
    fi
    if [ "$code" = "503" ]; then
        LOG "netbird cloud health check: got 503 (service down)"
        return 1
    fi
    return 0
}
```
(15s replaces the old 5s; on any curl failure the exit code is logged before returning failure, so a future incident shows *why* - DNS failure, connection refused, timeout - instead of just "unreachable")

- [ ] **Step 5: Run the test to verify it passes**

Run: `bash scripts/netbird-backup/tests/test-netbird-swap.sh`
Expected: all tests pass. Re-run the full suite once more to confirm no earlier test regressed (the `check_netbird_cloud_recovered` signature/behavior for the success case is unchanged, only the failure path gained logging).

- [ ] **Step 6: Commit**

```bash
git add scripts/netbird-backup/netbird-swap.sh scripts/netbird-backup/tests/
git commit -m "fix(netbird-swap): 15s recovery timeout + log curl failure reason

Main never logged a single 'recovered' check during the 2026-09-17
incident, unlike every other host - leading theory is the old 5s
curl timeout being too tight under main's real production load during
the chaotic failover window. Raised to 15s. Also logs curl's own exit
code on failure now, so a future incident doesn't require rebuilding
the cause from log-forensics.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: stateSince field on the fleet agent status endpoint

**Files:**
- Modify: `agent/index.ts:909-936` (the `/api/netbird-swap/status` handler, already touched this session for `lastEvent`)

**Interfaces:**
- Consumes: nothing new.
- Produces: a new `stateSince: string | null` field (ISO 8601 timestamp, or `null` if not installed) in the JSON response, consumed by Task 7's frontend banner via `server/routes.ts`'s existing pass-through (no server route change needed - `getAllNetbirdSwapStatus()` already spreads `...data` from `agentGet()`).

- [ ] **Step 1: Add the stat call and field**

Modify `agent/index.ts`, the `Promise.all` array inside `/api/netbird-swap/status` (lines 911-922):
```typescript
    const [stateFile, timer, backup, journalEvent, syslogEvent, stateSince] = await Promise.all([
      runCmd("cat /var/lib/netbird-swap/state 2>/dev/null"),
      runCmd("systemctl is-active netbird-swap.timer 2>/dev/null"),
      runCmd("systemctl is-active netbird-backup 2>/dev/null"),
      runCmd("journalctl -t netbird-swap --no-pager -n 1 -o cat 2>/dev/null"),
      // journald retention varies wildly per host (some rotate away in hours) and
      // gives a false "no event" reading even right after a real swap - see the
      // 2026-09-17 incident where DynamoXc looked like it never swapped. syslog
      // (via logger -t netbird-swap, same call the script already makes) keeps
      // rotated .gz history much longer, so fall back to it when journald is empty.
      runCmd("grep -ah 'netbird-swap:' /var/log/syslog 2>/dev/null | tail -1"),
      // mtime of the state file = the moment the last swap actually happened
      // (the script only ever writes this file inside the swap branches).
      // Used by the dashboard to flag a host stuck on backup too long.
      runCmd("stat -c %Y /var/lib/netbird-swap/state 2>/dev/null"),
    ]);
    const installed = stateFile.stdout.trim().length > 0;
    const journalLine = journalEvent.stdout.trim();
    const syslogLine = syslogEvent.stdout.trim().replace(/^.*netbird-swap:\s*/, "");
    const stateSinceEpoch = stateSince.stdout.trim();
    res.json({
      installed,
      state: installed ? (stateFile.stdout.trim() as "primary" | "backup") : null,
      timerActive: timer.stdout.trim() === "active",
      backupDaemonActive: backup.stdout.trim() === "active",
      lastEvent: journalLine || syslogLine || null,
      stateSince: stateSinceEpoch ? new Date(Number(stateSinceEpoch) * 1000).toISOString() : null,
    });
```

- [ ] **Step 2: Rebuild the agent bundle**

Run:
```bash
cd /home/massimo/Progetti/ProxyGuardian/agent && npm run build
```
Expected: `agent-bundle.js` rebuilt successfully, no esbuild errors (matches the existing pattern used for every prior agent change this session).

- [ ] **Step 3: Verify the endpoint shape locally (no real host - static check)**

Run: `grep -n "stateSince" /home/massimo/Progetti/ProxyGuardian/agent/agent-bundle.js | head -3`
Expected: at least one match, confirming the new field made it into the compiled bundle.

- [ ] **Step 4: Commit**

```bash
git add agent/index.ts agent/agent-bundle.js
git commit -m "feat(agent): add stateSince to netbird-swap status endpoint

mtime of /var/lib/netbird-swap/state, ISO-formatted - the dashboard
uses this to compute how long a host has been on backup and warn if
it's stuck. Bundle rebuilt, not deployed to any host as part of this
commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: stateSince field on the SSH-based status path (main + dynapannel)

**Files:**
- Modify: `server/netbird-swap-status.ts:4-37` (`NetbirdSwapStatus` interface, `SWAP_CHECK_CMD`, `parseSwapOutput`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `stateSince: string | null` on `NetbirdSwapStatus`, matching Task 5's field name/type exactly so the frontend (Task 7) can treat all 58 hosts uniformly regardless of which backend path produced the data.

- [ ] **Step 1: Add the field to the interface**

Modify `server/netbird-swap-status.ts:4-14`:
```typescript
export interface NetbirdSwapStatus {
  id: string;
  name: string;
  installed: boolean;
  state: "primary" | "backup" | null;
  timerActive: boolean;
  backupDaemonActive: boolean;
  lastEvent: string | null;
  stateSince: string | null;
  online: boolean;
  error?: string;
}
```

- [ ] **Step 2: Add the stat call to the SSH command and parse it**

Modify `server/netbird-swap-status.ts:16-37`:
```typescript
const SWAP_CHECK_CMD =
  "cat /var/lib/netbird-swap/state 2>/dev/null; echo ---; " +
  "systemctl is-active netbird-swap.timer 2>/dev/null; echo ---; " +
  "systemctl is-active netbird-backup 2>/dev/null; echo ---; " +
  "journalctl -t netbird-swap --no-pager -n 1 -o cat 2>/dev/null; echo ---; " +
  // journald retention varies per host (some rotate away in hours, giving a
  // false "no event" reading right after a real swap - see DynamoXc during
  // the 2026-09-17 incident). syslog keeps rotated .gz history much longer.
  "grep -ah 'netbird-swap:' /var/log/syslog 2>/dev/null | tail -1; echo ---; " +
  "stat -c %Y /var/lib/netbird-swap/state 2>/dev/null";

function parseSwapOutput(stdout: string): Omit<NetbirdSwapStatus, "id" | "name" | "online" | "error"> {
  const [state, timer, backup, journalEvent, syslogRaw, stateSinceRaw] = stdout.split("---").map((s) => s.trim());
  const installed = state.length > 0;
  const syslogEvent = syslogRaw ? syslogRaw.replace(/^.*netbird-swap:\s*/, "") : "";
  return {
    installed,
    state: installed ? (state as "primary" | "backup") : null,
    timerActive: timer === "active",
    backupDaemonActive: backup === "active",
    lastEvent: journalEvent || syslogEvent || null,
    stateSince: stateSinceRaw ? new Date(Number(stateSinceRaw) * 1000).toISOString() : null,
  };
}
```

- [ ] **Step 3: Update the two error-fallback object literals to satisfy the type**

Modify `server/netbird-swap-status.ts` — both `Promise.allSettled` `.map()` catch blocks (lines ~83-93 in `getFleetSwapStatus`, and ~116-126 in `getExtraHostsSwapStatus`), and the two `results.map()` rejection fallbacks (lines ~100 and ~133), each currently missing `stateSince`. Add `stateSince: null` to all four object literals. Example for the first one:
```typescript
      } catch (err: any) {
        return {
          id: vps.id,
          name: vps.name,
          installed: false,
          state: null,
          timerActive: false,
          backupDaemonActive: false,
          lastEvent: null,
          stateSince: null,
          online: false,
          error: err.message,
        };
      }
```
Apply the same `stateSince: null,` addition to the other three matching literals in the file.

- [ ] **Step 4: Type-check**

Run: `cd /home/massimo/Progetti/ProxyGuardian && npx tsc --noEmit -p . 2>&1 | grep -i "netbird-swap-status" || echo "no errors in this file"`
Expected: `no errors in this file` (confirms all four object literals were updated consistently and match the interface).

- [ ] **Step 5: Commit**

```bash
git add server/netbird-swap-status.ts
git commit -m "feat(server): add stateSince to SSH-based netbird-swap status (main/dynapannel)

Same field and format as the fleet agent endpoint (Task 5), so the
dashboard can treat all 58 hosts uniformly.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: Dashboard banner for hosts stuck on backup

**Files:**
- Modify: `client/src/pages/netbird-failover.tsx`

**Interfaces:**
- Consumes: `stateSince: string | null` from the `NetbirdSwapStatus` type (Tasks 5 & 6), already delivered fleet-wide by the existing `/api/fleet/netbird-swap/status` route with no server-side route change needed.
- Produces: nothing consumed elsewhere - this is the leaf UI.

- [ ] **Step 1: Add stateSince to the local interface**

Modify `client/src/pages/netbird-failover.tsx:10-20`:
```typescript
interface NetbirdSwapStatus {
  id: string;
  name: string;
  installed: boolean;
  state: "primary" | "backup" | null;
  timerActive: boolean;
  backupDaemonActive: boolean;
  lastEvent: string | null;
  stateSince: string | null;
  online: boolean;
  error?: string;
}
```

- [ ] **Step 2: Add a minutes-on-backup helper and the stuck-host banner**

Modify `client/src/pages/netbird-failover.tsx`, add right above the `export default function NetbirdFailover()` line:
```typescript
const STUCK_THRESHOLD_MINUTES = 15;

function minutesOnBackup(s: NetbirdSwapStatus): number | null {
  if (s.state !== "backup" || !s.stateSince) return null;
  return Math.floor((Date.now() - new Date(s.stateSince).getTime()) / 60_000);
}
```

Modify the existing "host in failover" banner block (lines 59-64) to also compute and surface stuck hosts, replacing it with:
```typescript
          {swapStatuses && swapStatuses.some((s) => s.state === "backup") && (
            <div className="mb-4 rounded-md border border-orange-500/50 bg-orange-500/10 px-3 py-2 text-sm text-orange-600 dark:text-orange-400 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {swapStatuses.filter((s) => s.state === "backup").length} host in failover (backup attivo) in questo momento.
            </div>
          )}
          {swapStatuses && swapStatuses.some((s) => (minutesOnBackup(s) ?? 0) >= STUCK_THRESHOLD_MINUTES) && (
            <div className="mb-4 rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {swapStatuses
                .filter((s) => (minutesOnBackup(s) ?? 0) >= STUCK_THRESHOLD_MINUTES)
                .map((s) => `${s.name} (${minutesOnBackup(s)} min)`)
                .join(", ")}{" "}
              — su backup da oltre {STUCK_THRESHOLD_MINUTES} minuti senza rientro automatico. Controllo manuale consigliato.
            </div>
          )}
```

- [ ] **Step 3: Surface the duration in the table row too**

Modify the "Ultimo evento" `<TableCell>` (lines 109-111), replacing it with a cell that also shows the backup duration when relevant:
```typescript
                      <TableCell className="text-xs text-muted-foreground font-mono max-w-md truncate">
                        {s.lastEvent || s.error || "-"}
                        {minutesOnBackup(s) !== null && (
                          <span className="ml-2 text-orange-500">({minutesOnBackup(s)} min su backup)</span>
                        )}
                      </TableCell>
```

- [ ] **Step 4: Type-check the frontend**

Run: `cd /home/massimo/Progetti/ProxyGuardian && npx tsc --noEmit -p client 2>&1 | grep -i "netbird-failover" || echo "no errors in this file"`
Expected: `no errors in this file`. If the project's client `tsconfig.json` path differs, run `npx tsc --noEmit` from the project root instead and check for the same file.

- [ ] **Step 5: Manual visual check (no real backend needed)**

Run the dev server (`npm run dev` from the project root, per existing project convention) and open `/netbird-failover` in a browser. Since no real host is currently on backup, confirm the page renders exactly as before (no banners) with no console errors — this proves the new code path is dead/harmless when `stateSince` is `null` for every host, which is the current production reality until this plan's other tasks are ever deployed.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/netbird-failover.tsx
git commit -m "feat(dashboard): warn when a host is stuck on backup >15min

Surfaces stateSince (added server-side in the previous two tasks) as
a red banner + per-row duration when a host has been on backup longer
than 15 minutes without an automatic recovery - exactly the situation
main was in, silently, during the 2026-09-17 incident. No new alert
channel, reuses the existing Failover NetBird card.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: Pilot rollout procedure (documentation only — do not execute against a real host without explicit user go-ahead)

**Files:**
- Create: `docs/superpowers/plans/2026-09-17-netbird-failover-hardening-pilot-checklist.md`

**Interfaces:**
- Consumes: the finished script from Tasks 1-4.
- Produces: nothing — this is the handoff document for the user's separate rollout decision.

- [ ] **Step 1: Write the pilot checklist**

Create `docs/superpowers/plans/2026-09-17-netbird-failover-hardening-pilot-checklist.md`:
```markdown
# Pilot rollout checklist — netbird-swap.sh hardening

Not part of the implementation plan's automated steps. This is the
manual procedure to follow **only when the user explicitly decides to
roll this out**, starting with one non-critical fleet VPS before
touching main, dynapannel, or the rest of the fleet.

## Pre-flight

- [ ] Pick a non-critical pilot host (same criterion used for every other
      fleet-wide script rollout this project has done - not main, not
      dynapannel, not a VPS carrying live paying traffic if avoidable).
- [ ] Confirm current script version/backup exists on the pilot
      (`cp /usr/local/sbin/netbird-swap.sh /root/netbird-swap.sh.bak-$(date +%Y%m%d-%H%M%S)`).
- [ ] Copy the new `netbird-swap.sh` to the pilot, `chmod +x`, do **not**
      touch the systemd unit yet.

## Simulate a real main outage, locally on the pilot only

- [ ] On the pilot, add a temporary local iptables rule that drops
      outbound to main's primary IP on the port this host's script
      checks (never touch main itself):
      `iptables -I OUTPUT 1 -d 100.116.117.155 -p tcp --dport 8880 -j DROP`
      (use 2096 instead of 8880 if the pilot is dynapannel-like; adjust
      the IP/port to match this specific host's actual `ExecStart` args).
- [ ] Watch `journalctl -u netbird-swap -f` (or `tail -f /var/log/syslog`)
      for ~2.5-4 minutes. Confirm: threshold reached at ~2min, a jitter
      value logged, the actual swap happening within 90s after that.
- [ ] Remove the DROP rule. Watch for the swap-back cycle: recovery
      threshold reached, jitter logged, re-check passes, swap back to
      primary, 45s verification, "swapped back to primary, verified
      reachable".
- [ ] Confirm via `iptables -S INPUT` that the generic ESTABLISHED,RELATED
      rule is at position 1 (line 2 of the output, right after
      `-P INPUT ACCEPT`) after both the swap-to-backup and the swap-back.
- [ ] Confirm via `systemctl status netbird-swap.service` that no run was
      killed for exceeding a timeout (no "start operation timed out"
      messages).

## Only after a clean pilot run

- [ ] Update `netbird-swap.service.template` on the pilot too (the
      `TimeoutStartSec=150` line), reload systemd
      (`systemctl daemon-reload`), confirm the timer still fires normally
      on its next 20s tick.
- [ ] Decide with the user: roll out to the rest of the fleet via the
      same mechanism already used for prior fleet-wide script pushes, in
      batches, main and dynapannel last (they're the two hosts where a
      mistake costs the most, and by that point the client-mode jitter
      path has already been proven live on the pilot).
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-09-17-netbird-failover-hardening-pilot-checklist.md
git commit -m "docs: pilot rollout checklist for netbird-swap hardening

Manual procedure for when the user decides to roll this out - not
executed as part of this implementation work.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
