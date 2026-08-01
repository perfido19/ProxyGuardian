#!/usr/bin/env python3
import sys, subprocess, ipaddress, socket, re
import urllib.request

TORLIST_URL = "https://check.torproject.org/torbulkexitlist"
WHITELIST_FILE = "/etc/asn-whitelist-nets.txt"
SET_NAME = "tor_exit"
MIN_VALID_LINES = 50
IPV4_RE = re.compile(r'^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$')


def resolve_domain(domain):
    """Risolve un dominio e restituisce lista di ip_network /32"""
    nets = []
    try:
        for info in socket.getaddrinfo(domain, None):
            ip = info[4][0]
            if ':' not in ip:
                nets.append(ipaddress.ip_network(ip + '/32', strict=False))
    except Exception:
        pass
    return nets


def load_whitelist():
    whitelist = []
    try:
        with open(WHITELIST_FILE) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                entry = line.split('#')[0].strip()
                if not entry:
                    continue
                if entry.startswith('domain:'):
                    domain = entry[len('domain:'):].strip()
                    if not domain.startswith('*.'):
                        whitelist.extend(resolve_domain(domain))
                else:
                    try:
                        whitelist.append(ipaddress.ip_network(entry, strict=False))
                    except ValueError:
                        pass
    except FileNotFoundError:
        pass
    return whitelist


def is_whitelisted(ip_str, whitelist):
    try:
        net = ipaddress.ip_network(ip_str + '/32', strict=False)
        return any(net.overlaps(w) for w in whitelist)
    except ValueError:
        return False


def is_valid_ipv4(s):
    if not IPV4_RE.match(s):
        return False
    try:
        ipaddress.IPv4Address(s)
        return True
    except ValueError:
        return False


def get_existing_count(set_name):
    """Numero di membri dell'ipset esistente, o None se il set non esiste."""
    try:
        proc = subprocess.run(['ipset', 'list', set_name, '-t'],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        if proc.returncode != 0:
            return None
        for line in proc.stdout.splitlines():
            if line.startswith('Number of entries:'):
                return int(line.split(':', 1)[1].strip())
    except Exception:
        pass
    return None


def fetch_exit_list():
    req = urllib.request.Request(TORLIST_URL, headers={"User-Agent": "ProxyGuardian-TorBlock/1.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = resp.read().decode("utf-8", errors="ignore")
    lines = [l.strip() for l in body.splitlines() if l.strip() and not l.strip().startswith('#')]
    return [l for l in lines if is_valid_ipv4(l)]


def main():
    try:
        ips = fetch_exit_list()
    except Exception as e:
        print(f"ERRORE fetch torbulkexitlist: {e}", file=sys.stderr)
        sys.exit(1)

    if len(ips) < MIN_VALID_LINES:
        print(f"ERRORE: lista scaricata sospetta ({len(ips)} righe valide, minimo {MIN_VALID_LINES}), ipset non toccato", file=sys.stderr)
        sys.exit(1)

    whitelist = load_whitelist()
    filtered = [ip for ip in ips if not is_whitelisted(ip, whitelist)]

    existing_count = get_existing_count(SET_NAME)
    if existing_count is not None and existing_count > 0 and len(filtered) < existing_count // 2:
        print(f"ERRORE: nuova lista sospetta ({len(filtered)} IP contro {existing_count} attuali in {SET_NAME}), ipset non toccato", file=sys.stderr)
        sys.exit(1)

    tmpset = "tor_exit_new"
    proc = subprocess.Popen(['ipset', 'restore', '-exist'], stdin=subprocess.PIPE, bufsize=1048576)
    buf = [f'create {tmpset} hash:ip family inet maxelem 65536 -exist\n']
    BATCH = 500
    count = 0
    for ip in filtered:
        buf.append(f'add {tmpset} {ip}\n')
        count += 1
        if len(buf) >= BATCH:
            proc.stdin.write(''.join(buf).encode())
            buf = []
    if buf:
        proc.stdin.write(''.join(buf).encode())
    proc.stdin.close()
    proc.wait()
    if proc.returncode != 0:
        print("ERRORE: ipset restore fallito", file=sys.stderr)
        sys.exit(1)

    exists = subprocess.run(['ipset', 'list', SET_NAME], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if exists:
        subprocess.run(['ipset', 'swap', tmpset, SET_NAME], check=True)
        subprocess.run(['ipset', 'destroy', tmpset], check=False)
    else:
        subprocess.run(['ipset', 'rename', tmpset, SET_NAME], check=True)

    print(count)


if __name__ == "__main__":
    main()
