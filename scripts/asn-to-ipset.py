#!/usr/bin/env python3
import sys, subprocess, ipaddress, socket, maxminddb

tmpset         = sys.argv[1]
mmdb           = sys.argv[2]
asns           = set(sys.argv[3:])
WHITELIST_FILE = "/etc/asn-whitelist-nets.txt"

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

# Carica whitelist
whitelist = []
wildcard_suffixes = []  # domini wildcard es: .relay.netbird.io

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
                if domain.startswith('*.'):
                    # Wildcard: salva il suffisso per match futuro
                    wildcard_suffixes.append(domain[2:])
                else:
                    whitelist.extend(resolve_domain(domain))
            else:
                try:
                    whitelist.append(ipaddress.ip_network(entry, strict=False))
                except ValueError:
                    pass
except FileNotFoundError:
    pass

def is_whitelisted(network_str):
    try:
        net = ipaddress.ip_network(network_str, strict=False)
        return any(net.overlaps(w) for w in whitelist)
    except ValueError:
        return False

# Popola ipset
count = 0
proc  = subprocess.Popen(['ipset', 'restore', '-exist'], stdin=subprocess.PIPE, bufsize=1048576)
buf   = [f'create {tmpset} hash:net family inet maxelem 1048576 -exist\n']
BATCH = 500

with maxminddb.open_database(mmdb) as db:
    for network, record in db:
        if not record:
            continue
        if str(record.get('autonomous_system_number', '')) not in asns:
            continue
        if ':' in str(network):
            continue
        net_str = str(network)
        if is_whitelisted(net_str):
            continue
        buf.append(f'add {tmpset} {net_str}\n')
        count += 1
        if len(buf) >= BATCH:
            proc.stdin.write(''.join(buf).encode())
            buf = []

if buf:
    proc.stdin.write(''.join(buf).encode())

proc.stdin.close()
proc.wait()

print(count)

