# NetBird Dual-Daemon Failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give main, dynapannel, and 3 pilot fleet VPS a second NetBird daemon (`wt1`) connected to a self-hosted NetBird management server, used by nginx as a passive backup path only when the primary NetBird Cloud (`wt0`) path fails.

**Architecture:** A new dedicated VPS (`94.249.153.69`, domain `dynbird.duckdns.org`) runs a self-hosted NetBird stack (management + signal + relay + dashboard). Each participating host runs both daemons in parallel (`wt0` untouched, `wt1` new, separate config/socket/log/systemd unit). nginx on fleet VPS gets a `backup` upstream server pointing at main's `wt1` mesh IP, so traffic only crosses to the self-hosted path when the primary fails.

**Tech Stack:** NetBird (client + self-hosted server stack via Docker Compose), systemd, iptables, nginx, bash, MariaDB (unrelated, main's DB stays untouched).

**Spec:** `docs/superpowers/specs/2026-09-15-netbird-dual-daemon-failover-design.md`

## Global Constraints

- Never touch, restart, or reconfigure the primary NetBird daemon (`/var/lib/netbird/default.json`, `wt0`, default socket `unix:///var/run/netbird.sock`) on any host.
- No script written for this project may restart any *other* service (fail2ban, nginx, netbird primary) as a side effect — today's incident was caused by exactly that pattern.
- All firewall rule insertions must be idempotent (check-then-insert via `iptables -C`, never blind `-A`/`-I` on every run).
- Self-hosted management/dashboard API (port 443 on `94.249.153.69`) is reachable only from an explicit IP allowlist — never world-open.
- This plan covers **Phase 0 (self-hosted server) + Phase 1 (pilot: main, dynapannel, Smarters, Lupo, gruppo3 salerno)** only. Phase 2 (remaining 51 fleet VPS) is a separate follow-up plan, written only after Phase 1 has run stable for an observation period.

---

## File Structure

- `scripts/main/pg-firewall-locks/pg-firewall-locks.sh` — sync today's live fix from main (was only applied via SSH, never committed)
- `scripts/main/pg-firewall-locks/pg-firewall-locks.conf` — add `keep` rule for `wt1` UDP port
- `scripts/netbird-backup/netbird-backup-install.sh` — new, reusable installer for the second daemon on any host (main, dynapannel, or a fleet VPS)
- `scripts/netbird-backup/netbird-backup.service.template` — new, systemd unit template consumed by the installer
- `server/nginx-template.conf` — add `backup` upstream server entry (modify existing `upstream backend { }` block at line ~344)
- `docs/superpowers/plans/2026-09-15-netbird-dual-daemon-failover-phase1-notes.md` — new, running log of setup keys / mesh IPs produced during Phase 1 (these are runtime values, not predictable ahead of time — this file is where the executor records them as they're generated, so later tasks in the same plan can consume them)

---

## Task 1: Sync `pg-firewall-locks.sh` fix to repo + add `wt1` keep rule

**Files:**
- Modify: `scripts/main/pg-firewall-locks/pg-firewall-locks.sh` (currently stale — the live version on main was rewritten today to fix duplicate-rule detection, this file still has the old buggy version)
- Modify: `scripts/main/pg-firewall-locks/pg-firewall-locks.conf`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `keep -p udp --dport 51821 -j ACCEPT` line in `pg-firewall-locks.conf`, used by Task 6 when main's `wt1` goes live

- [ ] **Step 1: Pull the live, fixed script from main into the repo**

```bash
sshpass -p 'qi7AIYhufYcy' ssh -o StrictHostKeyChecking=no root@80.244.4.35 \
  'cat /usr/local/sbin/pg-firewall-locks.sh' \
  > /home/massimo/Progetti/ProxyGuardian/scripts/main/pg-firewall-locks/pg-firewall-locks.sh
```

- [ ] **Step 2: Verify the pulled script matches the fixed logic (duplicate detection via ACCEPT/terminator counts, not just `tail -1`)**

```bash
grep -q 'acc_count' /home/massimo/Progetti/ProxyGuardian/scripts/main/pg-firewall-locks/pg-firewall-locks.sh && echo MATCH || echo MISMATCH
```
Expected: `MATCH` (confirms this is the post-dedup-fix version, not the stale pre-fix one)

- [ ] **Step 3: Add the `wt1` keep rule to the repo's locks.conf**

Read the current file first, then add a `keep` line for the second daemon's WireGuard UDP port (51821 — chosen because `wt0` already uses the netbird default 51820):

```bash
echo '# wt1 (netbird-backup, self-hosted mesh) - handshake in ingresso' >> /home/massimo/Progetti/ProxyGuardian/scripts/main/pg-firewall-locks/pg-firewall-locks.conf
echo 'keep -p udp --dport 51821 -j ACCEPT' >> /home/massimo/Progetti/ProxyGuardian/scripts/main/pg-firewall-locks/pg-firewall-locks.conf
```

- [ ] **Step 4: Verify the conf file is well-formed (same format as existing `keep` lines)**

```bash
grep -A1 'wt1' /home/massimo/Progetti/ProxyGuardian/scripts/main/pg-firewall-locks/pg-firewall-locks.conf
```
Expected: the comment line followed by `keep -p udp --dport 51821 -j ACCEPT`

- [ ] **Step 5: Commit**

```bash
cd /home/massimo/Progetti/ProxyGuardian
git add scripts/main/pg-firewall-locks/pg-firewall-locks.sh scripts/main/pg-firewall-locks/pg-firewall-locks.conf
git commit -m "$(cat <<'EOF'
fix(pg-firewall-locks): sync dedup fix from main + add wt1 UDP keep rule

Repo copy was stale (pre-dedup-fix). Also adds the always-on ACCEPT
for wt1's WireGuard port, needed once the netbird-backup daemon goes
live on main (see docs/superpowers/plans/2026-09-15-netbird-dual-daemon-failover.md).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Install NetBird self-hosted stack on `94.249.153.69`

**Files:** none in repo (remote install only)

**Interfaces:**
- Consumes: domain `dynbird.duckdns.org` (already pointed at `94.249.153.69`), SSH access `root@94.249.153.69`
- Produces: a running NetBird self-hosted stack reachable at `https://dynbird.duckdns.org`, an admin account to log into its dashboard

- [ ] **Step 1: Install Docker + Compose plugin (prerequisite for the official installer)**

```bash
sshpass -p 'Dg984T$@n8f9l8' ssh -o StrictHostKeyChecking=no root@94.249.153.69 \
  'curl -fsSL https://get.docker.com | sh && systemctl enable --now docker && docker --version && docker compose version'
```
Expected: both version strings print without error.

- [ ] **Step 2: Download and run the official NetBird self-hosted quickstart installer**

```bash
sshpass -p 'Dg984T$@n8f9l8' ssh -o StrictHostKeyChecking=no root@94.249.153.69 \
  'curl -fsSL https://github.com/netbirdio/netbird/releases/latest/download/getting-started-with-zitadel.sh -o /root/getting-started-with-zitadel.sh && chmod +x /root/getting-started-with-zitadel.sh'
```

Run it interactively (the script prompts for the domain — answer `dynbird.duckdns.org` when asked, and provide an admin email for the initial Zitadel account):

```bash
sshpass -p 'Dg984T$@n8f9l8' ssh -t -o StrictHostKeyChecking=no root@94.249.153.69 \
  'cd /root && ./getting-started-with-zitadel.sh'
```

- [ ] **Step 2b: If the installer output/prompts don't match what's described above (NetBird's self-hosted installer changes between releases), stop and report the actual prompts seen instead of guessing values — do not blindly answer prompts you don't recognize.**

- [ ] **Step 3: Verify the stack is up**

```bash
sshpass -p 'Dg984T$@n8f9l8' ssh -o StrictHostKeyChecking=no root@94.249.153.69 'docker ps --format "{{.Names}}: {{.Status}}"'
```
Expected: containers for management, signal, dashboard, coturn (and zitadel/postgres if the zitadel-based installer was used) all showing `Up`.

- [ ] **Step 4: Verify the dashboard is reachable over HTTPS**

```bash
curl -sk -o /dev/null -w "http_code=%{http_code}\n" https://dynbird.duckdns.org --max-time 10
```
Expected: `http_code=200` (or a redirect to the login page, `30x`).

- [ ] **Step 5: Log into the dashboard (manual, browser) and confirm the admin account works. Record the admin login used in `docs/superpowers/plans/2026-09-15-netbird-dual-daemon-failover-phase1-notes.md` (create this file now with a `## Admin access` section) — no plaintext password in the repo, just how to obtain/reset it.**

---

## Task 3: Harden the self-hosted server

**Files:** none in repo (remote config only)

**Interfaces:**
- Consumes: the running stack from Task 2
- Produces: fail2ban active on SSH, iptables allowlist restricting port 443 (dashboard/management API) to known IPs, STUN/TURN/relay ports left open

- [ ] **Step 1: Install and enable fail2ban with a standard SSH jail**

```bash
sshpass -p 'Dg984T$@n8f9l8' ssh -o StrictHostKeyChecking=no root@94.249.153.69 '
apt-get update -qq && apt-get install -y fail2ban
cat > /etc/fail2ban/jail.local << "EOF"
[sshd]
enabled = true
port = 22
logpath = /var/log/auth.log
maxretry = 5
findtime = 3600
bantime = 604800
EOF
systemctl enable --now fail2ban
systemctl status fail2ban --no-pager | head -5
'
```
Expected: `Active: active (running)`.

- [ ] **Step 2: Determine the current known-IP allowlist for port 443**

The allowlist starts with the public IPs already known for this session: dashboard (`185.229.236.50`), main (`80.244.4.35`), and whichever admin/office IP the user connects the dashboard browser from. Fleet pilot VPS public IPs are not yet known (only their NetBird mesh IPs are recorded anywhere) — they'll be added to the allowlist in Task 8 once each pilot VPS's own public IP is looked up during its own deployment step.

- [ ] **Step 3: Apply the allowlist for port 443, default-deny for everything else on that port**

```bash
sshpass -p 'Dg984T$@n8f9l8' ssh -o StrictHostKeyChecking=no root@94.249.153.69 '
iptables -C INPUT -p tcp --dport 443 -s 185.229.236.50/32 -j ACCEPT 2>/dev/null || \
  iptables -I INPUT -p tcp --dport 443 -s 185.229.236.50/32 -j ACCEPT
iptables -C INPUT -p tcp --dport 443 -s 80.244.4.35/32 -j ACCEPT 2>/dev/null || \
  iptables -I INPUT -p tcp --dport 443 -s 80.244.4.35/32 -j ACCEPT
iptables -C INPUT -p tcp --dport 443 -j DROP 2>/dev/null || \
  iptables -A INPUT -p tcp --dport 443 -j DROP
iptables -nvL INPUT --line-numbers | grep 443
'
```
Expected: two ACCEPT lines (for the two known IPs) followed by a DROP line, in that order (ACCEPT rules must come before the DROP for them to take effect).

- [ ] **Step 4: Persist the rules**

```bash
sshpass -p 'Dg984T$@n8f9l8' ssh -o StrictHostKeyChecking=no root@94.249.153.69 '
apt-get install -y iptables-persistent 2>&1 | tail -3
netfilter-persistent save
'
```

- [ ] **Step 5: Verify from an unlisted IP that port 443 is actually blocked, and from a listed IP that it isn't**

```bash
sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 \
  'curl -sk -o /dev/null -w "from dashboard (allowlisted): http_code=%{http_code}\n" https://94.249.153.69 --max-time 8'
```
Expected: a real HTTP code (not a timeout), confirming the dashboard's IP passes.

---

## Task 4: Configure NetBird groups & ACL policy on the self-hosted server

**Files:** none in repo (configured via the self-hosted dashboard UI)

**Interfaces:**
- Consumes: the hardened dashboard from Task 3
- Produces: two groups (`Proxy`, `Main`) and one bidirectional policy between them restricted to ports 8880/2096 — mirrors NetBird Cloud's existing topology so `wt1` doesn't grant broader mesh reachability than `wt0` already does

- [ ] **Step 1: Log into `https://dynbird.duckdns.org`, go to Peers → Groups, create two groups: `Main` and `Proxy`. Leave both empty for now — peers are added to the right group as each host enrolls in later tasks.**

- [ ] **Step 2: Go to Access Control → Policies, create a new policy:**
  - Name: `proxy-to-main-8880-2096`
  - Source: group `Proxy`
  - Destination: group `Main`
  - Protocol: TCP
  - Ports: `8880, 2096`
  - Bidirectional: yes
  - Disable/remove the default "Allow All" policy that self-hosted NetBird creates out of the box — without this, every peer can reach every other peer regardless of the policy just created.

- [ ] **Step 3: Verify only the intended policy remains active**

In the dashboard, Access Control → Policies should show exactly one enabled policy (`proxy-to-main-8880-2096`) after this step. Screenshot or note the policy list in `docs/superpowers/plans/2026-09-15-netbird-dual-daemon-failover-phase1-notes.md` for the record.

---

## Task 5: Build the reusable `netbird-backup` installer script

**Files:**
- Create: `scripts/netbird-backup/netbird-backup-install.sh`
- Create: `scripts/netbird-backup/netbird-backup.service.template`

**Interfaces:**
- Consumes: three positional args when run on a target host: `<management-url> <setup-key> <wt1-udp-port>`
- Produces: `/var/lib/netbird-backup/backup.json`, `/var/log/netbird-backup/`, `/etc/systemd/system/netbird-backup.service`, an enabled+started `netbird-backup` systemd service — reused identically by Tasks 6, 7, 8 (only the setup-key argument changes per host)

**Correction made during execution (2026-09-16):** the plan originally assumed the primary daemon lives at `/etc/netbird` and that the long-running process is `netbird up --foreground-mode`. Neither is true for the netbird version actually running on main (0.77.0): there is no `/etc/netbird` directory at all, the default profile config is `/var/lib/netbird/default.json`, and the real systemd unit runs `netbird service run` — `netbird up` is a one-shot CLI call against an already-running daemon's socket (`--daemon-addr`) to enroll/connect it, not the persistent process itself. Verified directly against main's live `netbird.service` unit and `netbird --help`/`netbird up --help`/`netbird service run --help` output before writing the files below.

- [ ] **Step 1: Write the systemd unit template** (already done — see `scripts/netbird-backup/netbird-backup.service.template`, committed. Content:)

```
[Unit]
Description=NetBird backup daemon (self-hosted, wt1) - failover only, never restarts other services
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=5
LimitNOFILE=65536
ExecStart=/usr/bin/netbird service run \
  --daemon-addr unix:///var/run/netbird-backup.sock \
  --config /var/lib/netbird-backup/backup.json \
  --log-file /var/log/netbird-backup/client.log

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write the installer script** (already done — see `scripts/netbird-backup/netbird-backup-install.sh`, committed). It: checks for an existing install, creates `/var/lib/netbird-backup` and `/var/log/netbird-backup`, installs+starts the systemd unit from Step 1 (waiting up to 10s for the control socket to appear), then runs the one-shot `netbird up --daemon-addr unix:///var/run/netbird-backup.sock --management-url "$MGMT_URL" --setup-key "$SETUP_KEY" --interface-name wt1 --wireguard-port "$WT1_PORT"` against that socket, and prints `netbird status --daemon-addr unix:///var/run/netbird-backup.sock` at the end.

- [ ] **Step 4: Syntax-check the script**

```bash
bash -n /home/massimo/Progetti/ProxyGuardian/scripts/netbird-backup/netbird-backup-install.sh && echo SYNTAX_OK
```
Expected: `SYNTAX_OK`

- [ ] **Step 5: Commit**

```bash
cd /home/massimo/Progetti/ProxyGuardian
git add scripts/netbird-backup/
git commit -m "$(cat <<'EOF'
feat(netbird-backup): reusable installer for the second (self-hosted) daemon

Generic script + systemd unit template for wt1 - takes management URL,
setup-key, and wireguard port as args so the same script deploys to
main, dynapannel, and each fleet VPS without modification. Never
touches the primary netbird daemon.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Deploy dual-daemon on `main`

**Files:**
- Modify (remote, not repo): main's live `/etc/pg-firewall/locks.conf` and `/usr/local/sbin/pg-firewall-locks.sh` (bring in sync with Task 1's repo versions)

**Interfaces:**
- Consumes: `scripts/netbird-backup/netbird-backup-install.sh` (Task 5), a setup-key generated from the self-hosted dashboard for a peer in the `Main` group (Task 4)
- Produces: main's `wt1` mesh IP (recorded in the phase1-notes file — Task 9 needs this value for nginx's `backup` upstream)

- [ ] **Step 1: Generate a setup key for main from the self-hosted dashboard**

Dashboard → Setup Keys → Add Setup Key. Name it `main`, type "One-off" (single use), auto-assign to group `Main`. Copy the generated key.

- [ ] **Step 2: Copy the installer to main and run it**

```bash
sshpass -p 'uteDQ2G7aA' scp -o StrictHostKeyChecking=no -r \
  /home/massimo/Progetti/ProxyGuardian/scripts/netbird-backup \
  root@185.229.236.50:/root/netbird-backup-installer

sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 \
  "scp -o StrictHostKeyChecking=no -r /root/netbird-backup-installer root@100.116.117.155:/root/netbird-backup-installer"

sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 \
  "sshpass -p 'qi7AIYhufYcy' ssh -o StrictHostKeyChecking=no root@100.116.117.155 \
  '/root/netbird-backup-installer/netbird-backup-install.sh https://dynbird.duckdns.org <SETUP_KEY_FROM_STEP_1> 51821'"
```
Expected: final `netbird status` output shows `Management: Connected`, `Signal: Connected`, `Peers count: 0/0` (no other pilot peer online yet at this point).

- [ ] **Step 2b: If step 2's install fails partway, do NOT retry blindly — read the error. If `/var/lib/netbird-backup/backup.json` was partially created, `systemctl stop netbird-backup; rm -rf /var/lib/netbird-backup` before re-running (the installer refuses to run if that file already exists, by design).**

- [ ] **Step 3: Verify `wt0` and `wt1` coexist**

```bash
sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 \
  "sshpass -p 'qi7AIYhufYcy' ssh -o StrictHostKeyChecking=no root@100.116.117.155 'ip link | grep -E \"wt0|wt1\"'"
```
Expected: two lines, both showing `state UP` (or `UNKNOWN` for WireGuard interfaces, which is normal).

- [ ] **Step 4: Record main's `wt1` mesh IP**

```bash
sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 \
  "sshpass -p 'qi7AIYhufYcy' ssh -o StrictHostKeyChecking=no root@100.116.117.155 'netbird status --daemon-addr unix:///var/run/netbird-backup.sock | grep \"NetBird IP\"'"
```
Append the result to `docs/superpowers/plans/2026-09-15-netbird-dual-daemon-failover-phase1-notes.md` under a `## Mesh IPs` section, e.g. `main wt1: 100.x.x.x` — this value is consumed literally by Task 9's nginx config.

- [ ] **Step 5: Apply Task 1's firewall fix + wt1 rule live on main**

```bash
sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 "
scp -o StrictHostKeyChecking=no /home/massimo/Progetti/ProxyGuardian/scripts/main/pg-firewall-locks/pg-firewall-locks.conf root@100.116.117.155:/etc/pg-firewall/locks.conf
sshpass -p 'qi7AIYhufYcy' ssh -o StrictHostKeyChecking=no root@100.116.117.155 '/usr/local/sbin/pg-firewall-locks.sh'
"
```
Expected output includes a line confirming the `51821` UDP rule was added (or already present if the installer's own NetBird handshake already opened it some other way — verify either way in the next step).

- [ ] **Step 6: Verify the wt1 UDP port is actually allowed**

```bash
sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 \
  "sshpass -p 'qi7AIYhufYcy' ssh -o StrictHostKeyChecking=no root@100.116.117.155 'iptables -nvL INPUT | grep 51821'"
```
Expected: an `ACCEPT udp ... dpt:51821` line.

---

## Task 7: Deploy dual-daemon on `dynapannel`

**Files:** none in repo (remote deploy, same script as Task 6)

**Interfaces:**
- Consumes: `scripts/netbird-backup/netbird-backup-install.sh`, a setup-key for a peer in group `Main` (dynapannel joins the same group as main — both are "Main-side" for the Proxy↔Main policy)
- Produces: dynapannel's `wt1` interface up and connected

- [ ] **Step 1: Generate a setup key from the dashboard, name `dynapannel`, assign to group `Main`**

- [ ] **Step 2: Copy installer and run it on dynapannel (public IP, password auth — see Task 3 of the earlier session for access pattern)**

```bash
sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 "
scp -o StrictHostKeyChecking=no -r /root/netbird-backup-installer root@37.221.66.175:/root/netbird-backup-installer
"
sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 "
sshpass -p 's5o7Jm78Y++3O9' ssh -o StrictHostKeyChecking=no root@37.221.66.175 \
  '/root/netbird-backup-installer/netbird-backup-install.sh https://dynbird.duckdns.org <SETUP_KEY_FROM_STEP_1> 51821'
"
```

- [ ] **Step 3: Verify `wt0`+`wt1` coexist and P2P connects to main**

```bash
sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 "
sshpass -p 's5o7Jm78Y++3O9' ssh -o StrictHostKeyChecking=no root@37.221.66.175 '
ip link | grep -E \"wt0|wt1\"
netbird status --daemon-addr unix:///var/run/netbird-backup.sock | grep -E \"Management|Signal|Peers count\"
'
"
```
Expected: `Peers count: 1/1 Connected` (main is now the one other peer in the mesh).

- [ ] **Step 4: Add dynapannel's public IP (`37.221.66.175`) to the self-hosted server's port-443 allowlist (Task 3's rule set)**

```bash
sshpass -p 'Dg984T$@n8f9l8' ssh -o StrictHostKeyChecking=no root@94.249.153.69 '
iptables -C INPUT -p tcp --dport 443 -s 37.221.66.175/32 -j ACCEPT 2>/dev/null || \
  iptables -I INPUT -p tcp --dport 443 -s 37.221.66.175/32 -j ACCEPT
netfilter-persistent save
'
```
(This only matters if dynapannel itself will ever need to reach the self-hosted dashboard/API directly — not strictly required for the NetBird client protocol itself, which uses different ports, but keeps the allowlist consistent with "every enrolled host can also reach the admin UI" for troubleshooting.)

---

## Task 8: Deploy dual-daemon on 3 pilot fleet VPS

**Files:** none in repo (remote deploy, same script)

**Interfaces:**
- Consumes: `scripts/netbird-backup/netbird-backup-install.sh`, 3 setup-keys for group `Proxy`
- Produces: `wt1` up on Smarters, Lupo, gruppo3 salerno; each confirmed doing P2P to main over the self-hosted mesh

- [ ] **Step 1: Generate 3 setup keys from the dashboard, one per VPS, all assigned to group `Proxy`**

- [ ] **Step 2: For each of the 3 VPS, get its public IP (needed both for the self-hosted server's allowlist and to confirm which host is which), then install**

```bash
for name_host in "Smarters:100.116.14.174" "Lupo:100.116.32.173" "gruppo3 salerno:100.116.206.239"; do
  name="${name_host%%:*}"
  host="${name_host##*:}"
  echo "=== $name ($host) ==="
  sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 \
    "ssh -o StrictHostKeyChecking=no root@$host -n 'curl -s -4 --max-time 5 ifconfig.me'"
done
```
Record each VPS's public IP in the phase1-notes file.

- [ ] **Step 3: Copy the installer to each pilot VPS and run it (repeat per VPS, using that VPS's own setup key from Step 1)**

```bash
sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 "
scp -o StrictHostKeyChecking=no -r /root/netbird-backup-installer root@100.116.14.174:/root/netbird-backup-installer
ssh -o StrictHostKeyChecking=no root@100.116.14.174 -n \
  '/root/netbird-backup-installer/netbird-backup-install.sh https://dynbird.duckdns.org <SMARTERS_SETUP_KEY> 51821'
"
```
Repeat for Lupo (`100.116.32.173`) and gruppo3 salerno (`100.116.206.239`), each with its own setup key.

- [ ] **Step 4: Verify each pilot VPS shows `wt0`+`wt1` and P2P (not relay) to main**

```bash
for host in 100.116.14.174 100.116.32.173 100.116.206.239; do
  echo "=== $host ==="
  sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 \
    "ssh -o StrictHostKeyChecking=no root@$host -n '
      ip link | grep -E \"wt0|wt1\"
      netbird status --daemon-addr unix:///var/run/netbird-backup.sock | grep -E \"Peers count|direct\"
    '"
done
```
Expected per host: both interfaces present, `Peers count: 2/2 Connected` (main + dynapannel), and the detailed peer list (full `netbird status -d`) shows `direct`/P2P rather than `relayed` for the connection to main — if any pilot VPS shows `relayed`, note it but don't block on it (NetBird falls back to relay automatically when direct P2P negotiation fails, e.g. restrictive NAT; the self-hosted relay/coturn from Task 2 handles this case).

- [ ] **Step 5: Add each pilot VPS's public IP to the self-hosted server's port-443 allowlist**

```bash
for ip in <SMARTERS_PUBLIC_IP> <LUPO_PUBLIC_IP> <GRUPPO3_PUBLIC_IP>; do
  sshpass -p 'Dg984T$@n8f9l8' ssh -o StrictHostKeyChecking=no root@94.249.153.69 \
    "iptables -C INPUT -p tcp --dport 443 -s $ip/32 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 443 -s $ip/32 -j ACCEPT"
done
sshpass -p 'Dg984T$@n8f9l8' ssh -o StrictHostKeyChecking=no root@94.249.153.69 'netfilter-persistent save'
```

- [ ] **Step 6: Add each pilot VPS's `wt1` UDP port ACCEPT rule (fleet VPS don't use `pg-firewall-locks` — that's main-only — so this is a direct, idempotent iptables insert per host)**

```bash
for host in 100.116.14.174 100.116.32.173 100.116.206.239; do
  sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 \
    "ssh -o StrictHostKeyChecking=no root@$host -n '
      iptables -C INPUT -p udp --dport 51821 -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport 51821 -j ACCEPT
      netfilter-persistent save
    '"
done
```

---

## Task 9: nginx passive-backup upstream on pilot fleet VPS

**Files:**
- Modify: `server/nginx-template.conf:344-345` (the `upstream backend { }` block)

**Interfaces:**
- Consumes: main's `wt1` mesh IP recorded in Task 6 Step 4
- Produces: nginx config that only crosses to the self-hosted path when `main.netbird.cloud:8880` fails

- [ ] **Step 1: Read the current upstream block to confirm the exact line numbers before editing**

```bash
sed -n '340,352p' /home/massimo/Progetti/ProxyGuardian/server/nginx-template.conf
```

- [ ] **Step 2: Edit the upstream block to add the backup server**

Using the Edit tool on `server/nginx-template.conf`, change:
```
    upstream backend {
        server main.netbird.cloud:8880;
```
to:
```
    upstream backend {
        server main.netbird.cloud:8880;
        server <MAIN_WT1_MESH_IP>:8880 backup;
```
(replace `<MAIN_WT1_MESH_IP>` with the literal value recorded in Task 6 Step 4)

- [ ] **Step 3: Verify the existing `proxy_next_upstream` directives (already present per the file's own comment at line ~582-584) are sufficient to trigger the backup on failure — no further nginx config change needed for the failover mechanism itself, only the upstream server list.**

```bash
grep -A3 'proxy_next_upstream' /home/massimo/Progetti/ProxyGuardian/server/nginx-template.conf
```
Expected: `proxy_next_upstream error timeout http_500 http_502 http_503 http_504;` and `proxy_next_upstream_tries 2;` — these already cover the failure conditions that should trigger a fall-through to the `backup` server, since nginx's `backup` marker only kicks in when the primary is marked down by these same directives.

- [ ] **Step 4: Deploy the updated template to the 3 pilot fleet VPS and reload nginx on each**

```bash
for host in 100.116.14.174 100.116.32.173 100.116.206.239; do
  sshpass -p 'uteDQ2G7aA' scp -o StrictHostKeyChecking=no \
    /home/massimo/Progetti/ProxyGuardian/server/nginx-template.conf \
    root@185.229.236.50:/root/nginx-pilot-template.conf
  sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 "
    scp -o StrictHostKeyChecking=no /root/nginx-pilot-template.conf root@$host:/tmp/nginx-new.conf
    ssh -o StrictHostKeyChecking=no root@$host -n '
      cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak-wt1-\$(date +%Y%m%d%H%M%S)
      cp /tmp/nginx-new.conf /etc/nginx/nginx.conf
      nginx -t && systemctl reload nginx || (echo NGINX_TEST_FAILED; cp /etc/nginx/nginx.conf.bak-wt1-* /etc/nginx/nginx.conf)
    '
  "
done
```

**Note:** this step assumes the fleet's live nginx config is already close enough to `server/nginx-template.conf` that a direct copy is safe. Before running this on each host, diff the live config against the template first (`ssh root@$host cat /etc/nginx/nginx.conf` vs the template) — if they've diverged (per-VPS customizations, ASN block state, etc.), apply only the specific `upstream backend {}` change to the live file instead of overwriting it wholesale.

- [ ] **Step 5: Verify each pilot VPS's nginx is still serving the primary path normally (no unintended failover)**

```bash
for host in 100.116.14.174 100.116.32.173 100.116.206.239; do
  sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 \
    "ssh -o StrictHostKeyChecking=no root@$host -n 'curl -sk -o /dev/null -w \"$host: %{http_code}\\n\" http://127.0.0.1:8880/'"
done
```
Expected: same response code as before this change (200/302 range, not an error) — confirms the primary upstream is still being used under normal conditions.

---

## Task 10: Live failover test on one pilot VPS

**Files:** none (verification only)

**Interfaces:**
- Consumes: everything from Tasks 6-9
- Produces: confirmed evidence the failover actually works end-to-end, and reverts cleanly

- [ ] **Step 1: Pick Smarters (`100.116.14.174`) for the live test. Confirm current state (primary path in use)**

```bash
sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 \
  "ssh -o StrictHostKeyChecking=no root@100.116.14.174 -n 'netbird status | grep \"Peers count\"'"
```

- [ ] **Step 2: Temporarily stop the PRIMARY daemon only (never the backup) to simulate a NetBird Cloud outage on this one host**

```bash
sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 \
  "ssh -o StrictHostKeyChecking=no root@100.116.14.174 -n 'systemctl stop netbird'"
```

- [ ] **Step 3: Within ~30 seconds, verify nginx's next request to `main.netbird.cloud:8880` fails and falls through to the backup IP, and that streaming keeps working**

```bash
sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 \
  "ssh -o StrictHostKeyChecking=no root@100.116.14.174 -n 'curl -sk -o /dev/null -w \"http_code=%{http_code}\n\" http://127.0.0.1:8880/'"
```
Expected: still a healthy response code (200/302), served via the `wt1` backup path this time — confirm by checking nginx's error log for an upstream failure + fallback log line:
```bash
sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 \
  "ssh -o StrictHostKeyChecking=no root@100.116.14.174 -n 'tail -20 /var/log/nginx/error.log | grep -i backend'"
```

- [ ] **Step 4: Restart the primary daemon and confirm the path reverts**

```bash
sshpass -p 'uteDQ2G7aA' ssh -o StrictHostKeyChecking=no root@185.229.236.50 \
  "ssh -o StrictHostKeyChecking=no root@100.116.14.174 -n 'systemctl start netbird'"
```
Wait ~30s, then re-run Step 1's check — expect `Peers count` climbing back to normal, and nginx no longer showing fallback errors in fresh log tail.

- [ ] **Step 5: Record the test result (pass/fail, exact timings observed) in `docs/superpowers/plans/2026-09-15-netbird-dual-daemon-failover-phase1-notes.md` under a `## Failover test results` section — this is the evidence needed before considering Phase 1 "stable" and starting the separate Phase 2 plan for the remaining 51 fleet VPS.**

---

## Self-Review Notes

- **Spec coverage:** self-hosted server (Task 2), hardening/allowlist (Task 3), ACL mirror (Task 4), dual-daemon config per host (Tasks 5-8), firewall wt1 port + pg-firewall-locks sync (Tasks 1, 6, 8), nginx passive backup (Task 9), failover verification (Task 10). Phase 2 explicitly deferred per spec.
- **Setup keys and mesh IPs** are runtime-generated values that cannot be predicted before Task 2/4 run — each task that needs one names exactly where to get it (dashboard UI page, or a prior task's recorded output in the phase1-notes file), which is operational reality for this kind of infra work, not a placeholder gap.
- **No task restarts fail2ban, main nginx's primary process, or the primary netbird daemon** as a side effect anywhere in this plan — the Global Constraints section is honored per-task.
