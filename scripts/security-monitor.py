#!/usr/bin/env python3
"""
ProxyGuardian Security Monitor
Analizza nginx access.log + fail2ban.log + modsec audit log.
Output: /var/log/pg-security-stats.json
"""
import json, re, os, gzip, glob, subprocess
from datetime import datetime, timedelta, timezone
from collections import defaultdict, Counter

NGINX_LOG    = "/var/log/nginx/access.log"
F2B_LOG      = "/var/log/fail2ban.log"
MODSEC_LOG   = "/opt/log/modsec_audit.log"
OUTPUT_FILE  = "/var/log/pg-security-stats.json"
HOURS_BACK   = 24


LOG_RE = re.compile(
    r'^(?P<ip>\S+) .* \[(?P<dt>[^\]]+)\] '
    r'"(?P<method>\w+) (?P<url>[^"]+)" (?P<status>\d+) (?P<size>\d+) '
    r'"[^"]*" "(?P<ua>[^"]*)" "[^"]*" "(?P<geo>[^"]*)" "(?P<asn>[^"]*)" "(?P<isp>[^"]*)"'
)
F2B_BAN_RE  = re.compile(
    r'(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*'
    r'\[(?P<jail>[^\]]+)\] (?:Ban|Restore Ban) (?P<ip>\S+)'
)
F2B_FIND_RE = re.compile(
    r'(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*'
    r'\[(?P<jail>[^\]]+)\] Found (?P<ip>\S+)'
)
# ModSec audit: sezione A contiene "---abc---A--\n[timestamp] [client IP]"
MODSEC_A_RE = re.compile(r'\[[\d/A-Za-z:+ ]+\] \S+ (?P<ip>\S+)')
MODSEC_RULE_RE = re.compile(r'id "(?P<id>\d+)".*?msg "(?P<msg>[^"]+)"')

def is_it(geo): return bool(geo and geo.strip().startswith("IT"))
def parse_ts(s):
    try: return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except: return None

def open_log(path):
    if not os.path.exists(path): return []
    if path.endswith(".gz"):
        return gzip.open(path, "rt", errors="replace")
    return open(path, errors="replace")

def main():
    now    = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=HOURS_BACK)

    # ── fail2ban ──────────────────────────────────────────────
    bans  = {}   # ip -> {jail, ts, restore}
    finds = defaultdict(lambda: defaultdict(int))  # ip->jail->n

    try:
        with open_log(F2B_LOG) as f:
            for line in f:
                m = F2B_BAN_RE.search(line)
                if m:
                    ts = parse_ts(m.group("ts"))
                    if ts and ts >= cutoff:
                        ip = m.group("ip")
                        bans[ip] = {
                            "jail": m.group("jail"),
                            "ts": m.group("ts"),
                            "restore": "Restore Ban" in line,
                        }
                m = F2B_FIND_RE.search(line)
                if m:
                    ts = parse_ts(m.group("ts"))
                    if ts and ts >= cutoff:
                        finds[m.group("ip")][m.group("jail")] += 1
    except Exception:
        pass

    # ── nginx access log ──────────────────────────────────────
    ip_info = {}   # ip -> {ua, geo, asn, isp, statuses, urls, reqs}
    status_hour  = defaultdict(Counter)   # "HH" -> status -> n
    ua_counter   = Counter()
    geo_counter  = Counter()
    path_403     = Counter()              # path -> n 403
    # xplugin raw: ip -> {n403, n200, ua, geo, asn, isp}
    xplugin_ip   = {}

    try:
        with open_log(NGINX_LOG) as f:
            for line in f:
                m = LOG_RE.match(line)
                if not m: continue
                ip     = m.group("ip")
                status = int(m.group("status"))
                ua     = m.group("ua") or ""
                geo    = m.group("geo") or ""
                asn    = m.group("asn") or ""
                isp    = m.group("isp") or ""
                url    = m.group("url") or ""
                path   = url.split()[0].split("?")[0][:80] if url else ""

                if ip not in ip_info:
                    ip_info[ip] = {"ua": ua, "geo": geo, "asn": asn, "isp": isp,
                                   "statuses": Counter(), "urls": [], "reqs": 0}
                d = ip_info[ip]
                d["statuses"][status] += 1
                d["reqs"] += 1
                if status in (400, 403, 404, 444) and len(d["urls"]) < 5:
                    if path not in d["urls"]:
                        d["urls"].append(path)

                if status == 403:
                    path_403[path] += 1

                # traccia xplugin raw
                if path == "/xplugin.php":
                    if ip not in xplugin_ip:
                        xplugin_ip[ip] = {"n403": 0, "n200": 0,
                                          "ua": ua, "geo": geo, "asn": asn, "isp": isp}
                    x = xplugin_ip[ip]
                    if status == 403: x["n403"] += 1
                    elif status == 200: x["n200"] += 1

                # orario (da timestamp nginx: 17/Jun/2026:21:50:56)
                try:
                    hh = m.group("dt").split(":")[1]
                    status_hour[hh][status] += 1
                except Exception:
                    pass
    except Exception:
        pass

    # ── ModSecurity audit log ─────────────────────────────────
    modsec_blocks = Counter()   # rule_id -> n
    modsec_ips    = Counter()   # ip -> n
    modsec_total  = 0

    try:
        if os.path.exists(MODSEC_LOG) and os.path.getsize(MODSEC_LOG) > 0:
            with open_log(MODSEC_LOG) as f:
                current_ip = None
                for line in f:
                    if line.startswith("---") and "---A--" in line:
                        current_ip = None
                    m = MODSEC_A_RE.search(line)
                    if m and current_ip is None:
                        current_ip = m.group("ip")
                        modsec_ips[current_ip] += 1
                        modsec_total += 1
                    mr = MODSEC_RULE_RE.search(line)
                    if mr:
                        modsec_blocks[f"{mr.group('id')}: {mr.group('msg')[:60]}"] += 1
    except Exception:
        pass

    # ── aggrega ban ───────────────────────────────────────────
    jail_stats = defaultdict(lambda: {"total": 0, "it": 0, "restore": 0})
    bans_detail = []

    for ip, ban in bans.items():
        jail = ban["jail"]
        js   = jail_stats[jail]
        js["total"] += 1
        if ban.get("restore"): js["restore"] += 1

        nd  = ip_info.get(ip, {})
        ua  = nd.get("ua", "")
        geo = nd.get("geo", "")
        asn = nd.get("asn", "")
        isp = nd.get("isp", "")

        if is_it(geo): js["it"] += 1

        ban.update({
            "ua":       ua,
            "geo":      geo,
            "asn":      asn,
            "isp":      isp,
            "statuses": dict(nd.get("statuses", {})),
            "urls":     nd.get("urls", []),
            "finds":    dict(finds.get(ip, {})),
        })
        bans_detail.append({
            "ip":       ip,
            "jail":     jail,
            "ts":       ban["ts"],
            "restore":  ban.get("restore", False),
            "ua":       ua[:120],
            "geo":      geo,
            "asn":      asn,
            "isp":      isp,
            "statuses": ban["statuses"],
            "urls":     ban["urls"],
            "finds":    ban["finds"],
        })

        ua_counter[ua[:80]]  += 1
        cc = geo.split()[0] if geo else "??"
        geo_counter[cc]      += 1

    # ── response code breakdown ultime 24h ───────────────────
    status_totals = Counter()
    for d in ip_info.values():
        status_totals.update(d["statuses"])

    # ── xplugin raw aggregato ─────────────────────────────────
    xplugin_403 = sorted(
        [{"ip": ip, **v} for ip, v in xplugin_ip.items() if v["n403"] > 0],
        key=lambda x: x["n403"], reverse=True
    )
    xplugin_200 = sorted(
        [{"ip": ip, **v} for ip, v in xplugin_ip.items() if v["n200"] > 0],
        key=lambda x: x["n200"], reverse=True
    )

    # ── top IP per 403 (tutti i path) ────────────────────────
    top_403_ips = sorted(
        [{"ip": ip,
          "n403": d["statuses"].get(403, 0),
          "n200": d["statuses"].get(200, 0),
          "n444": d["statuses"].get(444, 0),
          "reqs": d["reqs"],
          "ua":   d["ua"][:100],
          "geo":  d["geo"],
          "asn":  d["asn"],
          "isp":  d["isp"],
          "urls": d["urls"]}
         for ip, d in ip_info.items() if d["statuses"].get(403, 0) > 0],
        key=lambda x: x["n403"], reverse=True
    )[:100]

    # ── report finale ─────────────────────────────────────────
    report = {
        "generated":    now.isoformat(),
        "hostname":     subprocess.run(["hostname"], capture_output=True, text=True).stdout.strip(),
        "period_hours": HOURS_BACK,
        "totals": {
            "bans":            len(bans),
            "unique_ips_seen": len(ip_info),
            "italian_bans":    sum(s["it"] for s in jail_stats.values()),
            "total_requests":  sum(d["reqs"] for d in ip_info.values()),
            "total_403":       sum(d["statuses"].get(403, 0) for d in ip_info.values()),
            "total_444":       sum(d["statuses"].get(444, 0) for d in ip_info.values()),
            "total_200":       sum(d["statuses"].get(200, 0) for d in ip_info.values()),
        },
        "by_jail":          dict(jail_stats),
        "bans_detail":      sorted(bans_detail, key=lambda x: x["ts"], reverse=True),
        "top_ua_banned":    ua_counter.most_common(20),
        "top_geo_banned":   geo_counter.most_common(15),
        "status_breakdown": dict(status_totals.most_common(10)),
        "path_403_top":     path_403.most_common(30),
        "xplugin": {
            "total_403":      sum(v["n403"] for v in xplugin_ip.values()),
            "total_200":      sum(v["n200"] for v in xplugin_ip.values()),
            "unique_ips_403": len(xplugin_403),
            "unique_ips_200": len(xplugin_200),
            "ips_403":        xplugin_403[:50],
            "ips_200":        xplugin_200[:50],
        },
        "top_403_ips": top_403_ips,
        "modsec": {
            "log_path":     MODSEC_LOG,
            "log_exists":   os.path.exists(MODSEC_LOG),
            "log_size":     os.path.getsize(MODSEC_LOG) if os.path.exists(MODSEC_LOG) else 0,
            "total_blocks": modsec_total,
            "top_rules":    modsec_blocks.most_common(10),
            "top_ips":      modsec_ips.most_common(10),
        },
    }

    with open(OUTPUT_FILE, "w") as f:
        json.dump(report, f, indent=2)

    # stdout summary
    t = report["totals"]
    print(f"\n{'='*60}")
    print(f"HOST: {report['hostname']}  |  Periodo: {HOURS_BACK}h")
    print(f"{'='*60}")
    print(f"Richieste totali : {t['total_requests']:,}")
    print(f"  200            : {t['total_200']:,}")
    print(f"  403            : {t['total_403']:,}")
    print(f"  444            : {t['total_444']:,}")
    print(f"Ban totali       : {t['bans']}  (IT: {t['italian_bans']})")
    print(f"\nPer jail:")
    for jail, s in sorted(jail_stats.items()):
        print(f"  {jail:22s} tot={s['total']:4d}  it={s['it']:3d}  restore={s['restore']:3d}")
    x = report["xplugin"]
    print(f"\n/xplugin.php:")
    print(f"  403: {x['total_403']:,} da {x['unique_ips_403']} IP unici")
    print(f"  200: {x['total_200']:,} da {x['unique_ips_200']} IP unici")
    print(f"\nTop path 403:")
    for path, n in report["path_403_top"][:10]:
        print(f"  {n:6d}  {path}")
    print(f"\nModSecurity: blocks={modsec_total}  log={MODSEC_LOG}")
    print(f"Output: {OUTPUT_FILE}\n")

if __name__ == "__main__":
    main()
