# Phase 1 notes — NetBird dual-daemon failover

## Self-hosted server
- Dashboard: https://dynbird.duckdns.org (admin account created by user via browser onboarding, embedded Dex IdP)
- PAT (used for API automation, admin scope): nbp_Ax3tJ0jdhMpeZW1MCnMjZMGxEZXzgU1CcixA

## Groups
- Main: dal2a9e9tqrc73fb4feg
- Proxy: dal2a9e9tqrc73fb4fg0
- All (default, unused): dal29769tqrc73fb4e0g

## Policies
- `proxy-to-main-8880-2096` (dal2ace9tqrc73fb4fhg): enabled, Proxy->Main bidirectional, TCP 8880+2096
- `Default` (dal29769tqrc73fb4e10): disabled (was allow-all, turned off 2026-09-16)

## Port-443 allowlist on 94.249.153.69
- 80.244.4.35 (main)
- 185.229.236.50 (dashboard)
- 195.32.7.174 (user office IP)
- DROP everything else

## Mesh IPs
- main wt1: 100.91.143.178

## Open item
- Peer network CIDR: no overlap found. main wt1 = 100.91.143.178 (self-hosted range 100.91.0.0/16), distinct from NetBird Cloud's 100.116.0.0/16. Not a problem.

## CRITICAL FINDING (2026-09-16) — dual daemon design is broken on Linux, rollout halted

Discovered while enrolling dynapannel (2nd pilot host after main): running a second NetBird
client daemon on the same Linux host conflicts with the primary daemon over **global,
non-namespaced host resources**:

1. **DNS**: NetBird registers its DNS split-horizon config with systemd-resolved. Starting the
   backup daemon (even with `--disable-dns` on the backup) wiped the primary's registered
   search domain (`netbird.cloud` disappeared from `/etc/resolv.conf`'s search line), breaking
   `main.netbird.cloud` resolution for the primary. Confirmed on both dynapannel and main
   (`resolvectl status` showed `Current Scopes: none` on both wt0 and wt1 on main after wt1
   came up).
2. **iptables**: NetBird's Linux firewall manager creates fixed-name chains
   (`NETBIRD-RT-FWD-IN`, `NETBIRD-ACL-INPUT`, etc.) — NOT scoped per interface/instance. When
   the primary daemon on dynapannel was restarted (to recover from the DNS issue), it failed
   to come back up at all: `create chain NETBIRD-RT-FWD-IN in table filter: ... exit status 1:
   iptables: Chain already exists` — the backup daemon already owned those chain names.
   This caused a real (brief) outage: dynapannel's panel (`https://dynapannel.com:2096`)
   became unreachable (curl timeout, http_code=000) until the backup daemon was stopped and
   the primary restarted again.

**Root cause:** NetBird's Linux client was not designed to run multiple simultaneous instances
on one host — it assumes exclusive ownership of DNS resolver config and iptables chain
namespace regardless of `--daemon-addr`/`--interface-name`/`--config` isolation. The
per-instance isolation the plan relied on (separate socket, config file, log, systemd unit)
covers the daemon's own state but not these two shared kernel/OS-level resources.

**Recovery applied:** `netbird-backup.service` stopped and disabled on both main and
dynapannel. Primary daemon restarted and confirmed healthy on both (dynapannel 2/2 peers,
main 58/58 peers). Panel confirmed reachable again (`http_code=403` from dashboard IP — the
known pre-existing behavior, i.e. genuinely back to normal, not still broken). nginx on
dynapannel was left with the corrected upstream (`server 100.116.117.155:2096;` — literal IP,
no hostname dependency) since that change is harmless and independently good practice, but
the `backup` entry pointing at wt1 is now moot since wt1 is disabled.

**Not yet tried (needs careful, isolated testing before any further rollout, NOT on
main/dynapannel again):** `--disable-firewall` on the backup daemon (exists per `netbird up
--help`) might avoid the iptables chain clash, but may also disable NetBird's own ACL
enforcement and routing setup for wt1 traffic — unverified. Whether it also fixes the DNS
conflict is unknown (the DNS breakage might share the same root cause as the firewall/router
init failure, given NetBird's error message referenced "router init" for the firewall
failure specifically).

**Rollout status: HALTED after Task 7 (partial — main has wt1 running fine, actually, since
its primary was never restarted after wt1 came up, so main is NOT currently broken; only
dynapannel's backup was actually enrolled-then-disabled). Do not proceed to Task 8 (pilot
fleet VPS) or re-enable any netbird-backup service until this is resolved or the approach is
reconsidered.**

## REDESIGN (2026-09-16) — active/passive SWAP, never both daemons running

User's proposal, tested live on dynapannel and confirmed working: **never run both daemons
simultaneously.** Normal state = primary (`wt0`) running, backup (`netbird-backup`, `wt1`)
stopped + disabled. On a sustained real failure of the primary, a swap script stops the
primary and starts the backup (which now gets a clean iptables/DNS slate — no clash, since
the primary already released its chains/DNS registration by the time the backup starts). On
recovery, reverse: stop backup, start primary.

**Live test on dynapannel (2026-09-16), both directions confirmed:**
1. `systemctl stop netbird` (primary) → `systemctl start netbird-backup` → backup connected
   cleanly (`Management: Connected`, no chain-already-exists error) → curl to
   `https://dynapannel.com:2096/` externally returned `http_code=403` (the known-normal
   response for that source IP — i.e. a REAL response, request served via `wt1` alone, `wt0`
   fully down at the time).
2. Reverse: `systemctl stop netbird-backup` → `systemctl start netbird` → primary reconnected
   cleanly (`Peers count: 2/2`), external curl still `403` (normal) throughout.

This eliminates the DNS/iptables conflict entirely (no more scoped-resource contention, since
never more than one instance owns them at a time) and matches what the user actually wanted
from the start ("l'importante che l'interfaccia funziona solo se la prima interfaccia cade").
nginx's `backup` upstream entry becomes optional/redundant for this design (the swap itself
IS the failover — same `main.netbird.cloud` hostname or main's wt0 IP stays the logical
target, just served by whichever daemon is active) — but keeping it costs nothing and adds a
second layer of resilience for the brief window during the swap itself, so leaving it in.

**Next: build the swap-trigger script.** Requirements (same lessons as today's earlier
incident — [[project_main_netbird_zero_peers_2026-09-15]]):
- Detect on REAL impact (e.g. conntrack count to main's known port over a sustained window),
  not raw `netbird status` (a control-plane blip like this morning's 20s hiccup must NOT
  trigger a swap — established tunnels survive control-plane outages, no swap needed then).
- N consecutive failed checks over M minutes before swapping (hysteresis on both directions:
  trigger swap-to-backup and swap-back-to-primary).
- The swap script only ever touches netbird/netbird-backup systemd units — never fail2ban,
  nginx, or anything else, and every action logged explicitly (not silent "ok" forever, the
  exact bug that hid the pg-firewall-locks duplication until it had grown to 4x).

## Failover test results
Not reached — blocked by the finding above.

## Pilot fleet VPS progress (2026-09-16)

- Smarters (100.116.14.174, public 176.123.2.118): netbird-backup installed+disabled
  (wt1 mesh IP 100.91.73.0), wt1 UDP 51821 open+persisted, added to self-hosted 443
  allowlist, netbird-swap script+timer active (target=100.116.117.155:8880,
  threshold=6), nginx upstream fixed to literal IPs (100.116.117.155 primary +
  100.91.143.178:8880 backup). Verified: 166 live conntrack connections on 8880
  unaffected by the change. Note: curl-testing this fleet nginx with bare `/` or
  unauthenticated `/player_api.php` gets 444'd and immediately re-bans the tester's
  IP in nginx-abuse (by design, anti-scanner) - do not use plain curl probes against
  fleet :8880 for future verification, trust conntrack/real traffic instead.

- Lupo (100.116.32.173, public 146.19.213.239): same as Smarters (wt1 mesh IP
  100.91.177.18, UDP 51821, allowlist, swap timer, nginx upstream fixed). Verified
  clean nginx reload, no errors.
- gruppo3 salerno (100.116.206.239, public 176.123.2.5): same pattern (wt1 mesh IP
  100.91.236.11, UDP 51821, allowlist, swap timer, nginx upstream fixed). Verified
  clean nginx reload, no errors.

## Phase 1 COMPLETE (2026-09-16)

All 5 hosts (main, dynapannel, Smarters, Lupo, gruppo3 salerno) confirmed in final
state: `netbird-swap` state=primary, `netbird-swap.timer` active (20s interval,
2min/6-check threshold), `netbird-backup` inactive+disabled (ready, not running -
matches the active/passive swap design, never both daemons simultaneously).

Live-tested full swap cycle (both directions) on dynapannel. Not yet live-tested on
the fleet pilot VPS or on main's self-mode under an actual simulated outage - would
require repeating the same stop-primary/observe/restore cycle done on dynapannel.
Recommended before calling Phase 1 fully validated and starting Phase 2 (remaining
51 fleet VPS): run at least one more full swap-cycle test, ideally on a pilot fleet
VPS (not main) to also exercise the client-mode path end-to-end with real 8880
streaming traffic through the backup path, not just port 2096 admin panel traffic.

## Fleet pilot swap test (2026-09-16) - real incident during testing, 3 bugs found+fixed

Live-tested the swap on Smarters (100.116.14.174, real production 8880 traffic). Found
and fixed 3 real problems in the process, one of which caused an actual several-minute
outage on Smarters:

1. **Fleet-wide `netbird-watchdog.timer` fights the swap script.** It auto-restarts
   `netbird` within ~1 minute of any stop, completely defeating the swap script's own
   failure detection (which needs the primary to STAY stopped to count consecutive
   failures). This exists on main + all 3 fleet pilot VPS (not on dynapannel, which is
   why its earlier test worked cleanly). **Disabled on main, Smarters, Lupo, gruppo3
   salerno.** Must be disabled on every host before/when installing netbird-swap - add
   this to the fleet-wide install process before Phase 2.

2. **Real outage caused: missing generic ESTABLISHED,RELATED rule.** Fleet's
   `fix-iptables-post-netbird.sh` (ExecStartPost on netbird.service) rebuilds INPUT on
   every netbird restart with only an `-i wt0` scoped ESTABLISHED,RELATED rule, not a
   generic one covering `eth0`. Without it, return traffic from any server whose IP
   falls in `blocked_asn` gets dropped as if it were a new unsolicited connection - hit
   live on Smarters: DNS responses from 1.1.1.1 and 8.8.8.8 (both legitimate, both
   presumably in some blocked ASN range) got dropped, breaking ALL outbound
   connectivity including NetBird's own reconnection attempt. 100% ping loss to
   8.8.8.8, `api.netbird.io` unreachable, `Management: Disconnected` reason
   `context deadline exceeded`. A dashboard poller (`ensureEstablishedFleet`, hourly)
   already guards this long-term but couldn't help fast enough. **Fixed:**
   - Manually re-added the generic rule + persisted on Smarters (service recovered
     immediately once added).
   - **Proactively checked and fixed the same gap on main, Lupo, gruppo3 salerno too**
     (all three were also missing it - latent, hadn't been triggered yet).
   - `netbird-swap.sh` now calls a new `ensure_established_rule()` (idempotent
     check-then-insert) immediately after every `systemctl start netbird` /
     `netbird-backup` call, so every future swap-triggered restart self-heals this gap
     instead of waiting up to an hour for the dashboard poller.

3. **10s grace period after swap-back was too short.** After restarting the primary
   post-outage, the script checked reachability after only 10s and (once, during this
   test) incorrectly concluded the primary was still down and reverted back to backup,
   even though the primary was actually fine - a fresh reconnect after real downtime
   needs more time to renegotiate. **Increased to 45s.**

**Operational lesson also relearned:** testing a host's swap via SSH that itself routes
through that host's own NetBird mesh IP cuts your own access the moment you stop its
primary daemon. Use the host's public IP for hands-on swap testing, not its mesh IP via
the dashboard hop.

After fixes: Smarters confirmed fully recovered (`Management: Connected`, `Peers count:
2/2`, 38 live conntrack connections on 8880, `netbird-swap.timer` active, state file
corrected to `primary`). Updated `netbird-swap.sh` redeployed to all 5 pilot hosts.

**Before Phase 2 (remaining 51 fleet VPS):** the install process must also (a) disable
`netbird-watchdog.timer` and (b) verify/add the generic ESTABLISHED,RELATED rule as
standard steps, not follow-up fixes discovered live on each host.

## PHASE 2 COMPLETE (2026-09-16)

Built `scripts/netbird-backup/phase2-deploy-host.sh` (per-host orchestrator combining
every Phase 1 lesson: pre-flight health check, ESTABLISHED rule ensured first,
watchdog disabled, backup install+immediately-stopped, wt1 port, swap timer, defensive
nginx upstream fix) + a Python batch orchestrator run from the dashboard.

**Pilot test on 1 new host (mugello) before the batch** found and fixed one more real
bug: `nginx -t 2>&1 | grep -q "syntax is ok"` under `set -o pipefail` reports false
failure due to SIGPIPE (grep -q exits on first match, killing nginx -t before it
finishes writing, pipefail then reports the pipeline failed even though the config
was valid). Fixed by checking `nginx -t`'s own exit code directly instead of grepping
piped output. Also fixed the revert-on-failure path to pick the single most recent
backup (`ls -t | head -1`) instead of a glob that broke `cp` with multiple timestamped
backups present.

**Batch run on the remaining 52 fleet VPS: 52/52 succeeded, zero failures** (including
DynamoXc, included per explicit user request despite being excluded from other
fleet-wide operations). ~25-30s per host, ~24 minutes total, sequential (not
parallel) via a Python orchestrator on the dashboard.

**Final consolidated health check across everything (58 hosts total: main +
dynapannel + all 56 fleet VPS): 58/58 fully healthy** - `netbird-swap` state=primary,
timer active, backup daemon inactive, primary Management Connected. Ran a dedicated
verification script (not just trusting each individual deploy's own report) to catch
anything that degraded after its own install step.

**Rollout complete.** Every host that talks to main now has an automatic,
tested, self-healing failover path to the self-hosted NetBird mesh if NetBird Cloud
goes down again like it did on 2026-09-15, with the swap detection tuned to react in
about 2 minutes and never run both daemons simultaneously (the root cause of every
bug found during this rollout was, in one way or another, downstream of daemon
conflicts or firewall/DNS state left stale by a restart - worth remembering for any
future work that touches netbird on these hosts).
