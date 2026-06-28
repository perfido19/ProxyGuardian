#!/bin/bash
# Re-insert critical iptables rules after netbird restart on dashboard
#
# Netbird inserts ESTABLISHED+NETBIRD-ACL-INPUT at positions 1,2 on every restart,
# pushing DROP to position 3 — before 8080 (CrowdSec LAPI) and 51820 (WireGuard P2P).
# Installed as ExecStartPost dropin: /etc/systemd/system/netbird.service.d/fix-iptables.conf

# Remove stale duplicates (ignore errors if not present)
iptables -D INPUT -p tcp -s 127.0.0.1 --dport 8080 -j ACCEPT 2>/dev/null || true
iptables -D INPUT -p tcp -s 100.0.0.0/8 --dport 8080 -j ACCEPT 2>/dev/null || true
iptables -D INPUT -j CROWDSEC_CHAIN 2>/dev/null || true
iptables -D INPUT -p udp --dport 51820 -j ACCEPT 2>/dev/null || true

# Re-insert at pos 3 (after ESTABLISHED+NETBIRD-ACL-INPUT, before DROP)
iptables -I INPUT 3 -p udp --dport 51820 -j ACCEPT
iptables -I INPUT 3 -j CROWDSEC_CHAIN
iptables -I INPUT 3 -p tcp -s 100.0.0.0/8 --dport 8080 -j ACCEPT
iptables -I INPUT 3 -p tcp -s 127.0.0.1 --dport 8080 -j ACCEPT

iptables-save > /etc/iptables/rules.v4

logger -t netbird-iptables-fix "iptables rules restored after netbird restart"
