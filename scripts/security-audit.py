#!/usr/bin/env python3
"""
ProxyGuardian Security Audit
Audit completo di tutto il traffico: iptables, nginx, fail2ban, modsec.
Nessuna interpretazione — solo dati grezzi.
Output: /var/log/pg-security-audit.json
"""
import json, re, os, subprocess, gzip
from datetime import datetime, timedelta, timezone
from collections import defaultdict, Counter

NGINX_LOG   = "/var/log/nginx/access.log"
F2B_LOG     = "/var/log/fail2ban.log"
MODSEC_LOG  = "/opt/log/modsec_audit.log"
OUTPUT_FILE = "/var/log/pg-security-audit.json"
HOURS_BACK  = 24

LOG_RE = re.compile(
    r'^(?P<ip>\S+) \S+ \S+ \[(?P<dt>[^\]]+)\] '
    r'"(?P<req>[^"]*)" (?P<status>\d+) (?P<size>\d+) '
    r'"(?P<ref>[^"]*)" "(?P<ua>[^"]*)" "(?P<x1>[^"]*)" "(?P<geo>[^"]*)" "(?P<asn>[^"]*)" "(?P<isp>[^"]*)"'
)
LOG_RE_SHORT = re.compile(
    r'^(?P<ip>\S+) \S+ \S+ \[(?P<dt>[^\]]+)\] '
    r'"(?P<req>[^"]*)" (?P<status>\d+) (?P<size>\d+) '
    r'"(?P<ref>[^"]*)" "(?P<ua>[^"]*)"'
)

F2B_BAN_RE  = re.compile(r'(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*\[(?P<jail>[^\]]+)\] (?P<action>Ban|Restore Ban|Unban) (?P<ip>\S+)')
F2B_FIND_RE = re.compile(r'(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*\[(?P<jail>[^\]]+)\] Found (?P<ip>\S+)')

def parse_ts_f2b(s):
    try: return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except: return None

def parse_nginx_dt(s):
    # 17/Jun/2026:21:50:56 +0200
    try: return datetime.strptime(s[:20], "%d/%b/%Y:%H:%M:%S").replace(tzinfo=timezone.utc)
    except: return None

def run(args):
    """Run a command given as a list of args (no shell=True)."""
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=10)
        return r.stdout.strip()
    except: return ""

def run_pipe(args_list):
    """Run a pipeline (list of arg-lists). Avoids shell=True with user data."""
    try:
        procs = []
        for i, args in enumerate(args_list):
            stdin = procs[-1].stdout if procs else None
            p = subprocess.Popen(args, stdin=stdin, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, text=True)
            if procs:
                procs[-1].stdout.close()
            procs.append(p)
        out, _ = procs[-1].communicate(timeout=10)
        for p in procs[:-1]:
            p.wait()
        return out.strip()
    except: return ""

def main():
    now    = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=HOURS_BACK)

    # ── 1. IPTABLES / IPSET ───────────────────────────────────────────────────
    iptables_chains = {}
    raw_ipt = run(["sudo", "iptables", "-nvL", "--line-numbers"])
    current_chain = None
    for line in raw_ipt.splitlines():
        if line.startswith("Chain "):
            current_chain = line.split()[1]
            iptables_chains[current_chain] = {"rules": [], "policy": ""}
            if "policy" in line:
                iptables_chains[current_chain]["policy"] = re.search(r'policy (\w+)', line).group(1) if re.search(r'policy (\w+)', line) else ""
        elif current_chain and re.match(r'\s*\d+', line):
            parts = line.split()
            if len(parts) >= 4:
                iptables_chains[current_chain]["rules"].append({
                    "pkts": parts[0], "bytes": parts[1], "target": parts[3],
                    "rest": " ".join(parts[4:])[:80]
                })

    ipsets = {}
    raw_sets = run(["sudo", "ipset", "list", "-n"])
    for setname in raw_sets.splitlines():
        setname = setname.strip()
        # validate: ipset names are alphanumeric + hyphen/underscore only
        if not setname or not re.match(r'^[\w\-]+$', setname):
            continue
        members_out = run_pipe([
            ["sudo", "ipset", "list", setname],
            ["tail", "-n", "+9"],
            ["wc", "-l"],
        ])
        ipsets[setname] = {"members": int(members_out) if members_out.isdigit() else 0}

    # ── 2. FAIL2BAN ───────────────────────────────────────────────────────────
    f2b_bans  = {}        # ip -> {jail, ts, action}
    f2b_finds = defaultdict(lambda: defaultdict(int))  # ip->jail->n
    jail_ban_times = defaultdict(list)   # jail -> [ts]
    jail_find_count = defaultdict(int)

    try:
        with open(F2B_LOG, errors="replace") as fh:
            for line in fh:
                m = F2B_BAN_RE.search(line)
                if m:
                    ts = parse_ts_f2b(m.group("ts"))
                    if ts and ts >= cutoff:
                        ip = m.group("ip")
                        f2b_bans[ip] = {"jail": m.group("jail"), "ts": m.group("ts"), "action": m.group("action")}
                        jail_ban_times[m.group("jail")].append(m.group("ts"))
                m = F2B_FIND_RE.search(line)
                if m:
                    ts = parse_ts_f2b(m.group("ts"))
                    if ts and ts >= cutoff:
                        f2b_finds[m.group("ip")][m.group("jail")] += 1
                        jail_find_count[m.group("jail")] += 1
    except FileNotFoundError:
        pass

    f2b_jail_stats = {}
    for jail, times in jail_ban_times.items():
        f2b_jail_stats[jail] = {
            "bans": len(times),
            "finds": jail_find_count.get(jail, 0),
            "first": times[0] if times else "",
            "last":  times[-1] if times else "",
        }

    # ── 3. NGINX ACCESS LOG ───────────────────────────────────────────────────
    status_counter   = Counter()          # status -> n
    status_by_cc     = defaultdict(Counter)  # cc -> status -> n
    status_by_hour   = defaultdict(Counter)  # HH -> status -> n
    ua_counter       = Counter()          # ua -> n
    ua_by_status     = defaultdict(Counter)  # status -> ua -> n
    path_counter     = defaultdict(Counter)  # status -> path -> n
    cc_counter       = Counter()          # country_code -> n
    asn_counter      = Counter()          # asn -> n
    isp_counter      = Counter()          # isp -> n
    ip_status        = defaultdict(Counter)  # ip -> status -> n
    total_bytes      = 0
    total_lines      = 0
    parse_errors     = 0

    try:
        with open(NGINX_LOG, errors="replace") as fh:
            for line in fh:
                m = LOG_RE.match(line)
                if not m:
                    m = LOG_RE_SHORT.match(line)
                    if not m:
                        parse_errors += 1
                        continue

                total_lines += 1
                ip     = m.group("ip")
                status = int(m.group("status"))
                ua     = m.group("ua") or "-"
                req    = m.group("req")
                size   = int(m.group("size")) if m.group("size").isdigit() else 0
                geo    = m.group("geo") if hasattr(m, 'group') and "geo" in m.groupdict() and m.group("geo") else ""
                asn    = m.group("asn") if "asn" in m.groupdict() and m.group("asn") else ""
                isp    = m.group("isp") if "isp" in m.groupdict() and m.group("isp") else ""

                # parse path
                try:
                    path = req.split()[1].split("?")[0] if req and req != "-" else "-"
                except: path = "-"

                # country code
                cc = geo.split()[0] if geo and geo != "-" else "??"

                # hour
                try:
                    hh = m.group("dt").split(":")[1]
                except: hh = "??"

                total_bytes += size
                status_counter[status] += 1
                status_by_cc[cc][status] += 1
                status_by_hour[hh][status] += 1
                ua_counter[ua[:100]] += 1
                ua_by_status[status][ua[:100]] += 1
                cc_counter[cc] += 1
                if asn and asn != "-": asn_counter[asn] += 1
                if isp and isp != "-": isp_counter[isp] += 1
                ip_status[ip][status] += 1

                # percorsi — raggruppa per prefisso
                path_key = path[:60]
                path_counter[status][path_key] += 1

    except FileNotFoundError:
        pass

    # top path per ogni status
    top_paths = {}
    for status, paths in path_counter.items():
        top_paths[str(status)] = paths.most_common(10)

    # distribuzione status per paese (top paesi)
    top_cc = [cc for cc, _ in cc_counter.most_common(20)]
    cc_status_table = {}
    for cc in top_cc:
        cc_status_table[cc] = dict(status_by_cc[cc])

    # UA breakdown per status bloccante (403/404/444)
    ua_blocked = {}
    for status in (400, 403, 404, 444):
        ua_blocked[str(status)] = ua_by_status[status].most_common(15)

    # IP con più errori (potenziali scanner)
    top_error_ips = sorted(
        [(ip, dict(cnts)) for ip, cnts in ip_status.items()
         if any(s in cnts for s in (403, 404, 444, 400))],
        key=lambda x: sum(v for k, v in x[1].items() if k in (403, 404, 444, 400)),
        reverse=True
    )[:20]

    # ── 4. MODSEC ─────────────────────────────────────────────────────────────
    modsec = {"log_path": MODSEC_LOG, "exists": False, "size": 0, "blocks": 0, "top_rules": [], "top_ips": []}
    MODSEC_A_RE   = re.compile(r'\[[\d/A-Za-z:+ ]+\] \S+ (?P<ip>\S+)')
    MODSEC_MSG_RE = re.compile(r'\[id "(?P<id>\d+)"\].*\[msg "(?P<msg>[^"]+)"\]')
    if os.path.exists(MODSEC_LOG):
        modsec["exists"] = True
        modsec["size"]   = os.path.getsize(MODSEC_LOG)
        if modsec["size"] > 0:
            rule_counter = Counter()
            ip_counter   = Counter()
            current_ip   = None
            try:
                with open(MODSEC_LOG, errors="replace") as fh:
                    for line in fh:
                        if "---A--" in line:
                            current_ip = None
                            m = MODSEC_A_RE.search(line)
                            if m:
                                current_ip = m.group("ip")
                                ip_counter[current_ip] += 1
                                modsec["blocks"] += 1
                        mr = MODSEC_MSG_RE.search(line)
                        if mr:
                            rule_counter[f"{mr.group('id')}: {mr.group('msg')[:60]}"] += 1
            except Exception: pass
            modsec["top_rules"] = rule_counter.most_common(15)
            modsec["top_ips"]   = ip_counter.most_common(10)

    # ── 5. FAIL2BAN FILTER ANALYSIS ───────────────────────────────────────────
    # per ogni jail attiva, recupera i parametri dalla config
    jail_configs = {}
    raw_status = run(["sudo", "fail2ban-client", "status"])
    jail_list_m = re.search(r'Jail list:\s+(.+)', raw_status)
    if jail_list_m:
        for jail in [j.strip() for j in jail_list_m.group(1).split(",")]:
            if not re.match(r'^[\w\-]+$', jail):
                continue
            raw_j = run(["sudo", "fail2ban-client", "status", jail])
            currently_banned = re.search(r'Currently banned:\s+(\d+)', raw_j)
            total_banned     = re.search(r'Total banned:\s+(\d+)', raw_j)
            jail_configs[jail] = {
                "currently_banned": int(currently_banned.group(1)) if currently_banned else 0,
                "total_banned":     int(total_banned.group(1)) if total_banned else 0,
            }

    # ── OUTPUT ────────────────────────────────────────────────────────────────
    report = {
        "generated":    now.isoformat(),
        "hostname":     run(["hostname"]),
        "period_hours": HOURS_BACK,

        "nginx": {
            "total_requests":  total_lines,
            "total_bytes":     total_bytes,
            "parse_errors":    parse_errors,
            "status_totals":   dict(status_counter.most_common()),
            "by_hour":         {h: dict(v) for h, v in sorted(status_by_hour.items())},
            "by_country":      cc_status_table,
            "top_countries":   cc_counter.most_common(20),
            "top_asn":         asn_counter.most_common(15),
            "top_isp":         isp_counter.most_common(15),
            "top_ua":          ua_counter.most_common(25),
            "ua_by_blocked_status": ua_blocked,
            "top_paths":       top_paths,
            "top_error_ips":   top_error_ips,
        },

        "fail2ban": {
            "total_bans_24h":   len(f2b_bans),
            "total_finds_24h":  sum(jail_find_count.values()),
            "by_jail":          f2b_jail_stats,
            "jail_live_status": jail_configs,
            "banned_ips_sample": [
                {"ip": ip, **data, "finds": dict(f2b_finds.get(ip, {}))}
                for ip, data in list(f2b_bans.items())[:50]
            ],
        },

        "iptables": {
            "chains": iptables_chains,
            "ipsets": ipsets,
        },

        "modsec": modsec,
    }

    with open(OUTPUT_FILE, "w") as fh:
        json.dump(report, fh, indent=2)

    # ── STDOUT SUMMARY ────────────────────────────────────────────────────────
    n = report["nginx"]
    f = report["fail2ban"]
    print(f"\n{'='*65}")
    print(f"SECURITY AUDIT — {report['hostname']} — ultimi {HOURS_BACK}h")
    print(f"{'='*65}")
    print(f"\n[NGINX] {n['total_requests']:,} richieste  |  {n['total_bytes']/1024/1024:.1f} MB")
    print("  Status breakdown:")
    for st, cnt in sorted(n["status_totals"].items()):
        pct = cnt / max(n["total_requests"], 1) * 100
        print(f"    {st}  {cnt:>8,}  ({pct:5.1f}%)")

    print(f"\n  Top paesi (richieste):")
    for cc, cnt in n["top_countries"][:10]:
        print(f"    {cc:6s}  {cnt:>8,}")

    print(f"\n  Top UA (tutti):")
    for ua, cnt in n["top_ua"][:10]:
        print(f"    {cnt:>6,}  {ua[:80]}")

    print(f"\n  UA su risposte 403/444/404:")
    for status in ("403","444","404"):
        uas = n["ua_by_blocked_status"].get(status, [])
        if uas:
            print(f"    [{status}] top UA:")
            for ua, cnt in uas[:5]:
                print(f"      {cnt:>5,}  {ua[:80]}")

    print(f"\n[FAIL2BAN] ban 24h: {f['total_bans_24h']}  finds: {f['total_finds_24h']}")
    print("  Per jail:")
    for jail, s in sorted(f["by_jail"].items()):
        live = f["jail_live_status"].get(jail, {})
        print(f"    {jail:22s}  bans={s['bans']:4d}  finds={s['finds']:5d}  attivi={live.get('currently_banned',0):4d}  tot={live.get('total_banned',0):5d}")

    print(f"\n[IPSET]")
    for setname, info in report["iptables"]["ipsets"].items():
        print(f"    {setname:30s}  entries={info['members']:,}")

    print(f"\n[MODSEC] log={modsec['log_path']}  size={modsec['size']}B  blocks={modsec['blocks']}")
    print(f"\nOutput: {OUTPUT_FILE}\n")

if __name__ == "__main__":
    main()
