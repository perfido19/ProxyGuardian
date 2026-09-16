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

## Failover test results
Not reached — blocked by the finding above.
