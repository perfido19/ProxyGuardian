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
- Peer network CIDR: installer exposed no config option for it. Must verify once first peer (main) enrolls that its wt1 mesh IP does not overlap NetBird Cloud's 100.116.0.0/16 range used by wt0.

## Failover test results
(pending — Task 10)
