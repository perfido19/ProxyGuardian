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
