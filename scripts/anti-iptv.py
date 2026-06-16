#!/usr/bin/env python3
import os
import re
import signal
import subprocess
import sys
import time
from typing import Dict, Tuple


LOGFILE = os.environ.get("LOGFILE", "/var/log/nginx/access.log")

MAX_USERNAME = int(os.environ.get("MAX_USERNAME", "3"))
WINDOW_SECONDS = int(os.environ.get("WINDOW_SECONDS", "21600"))
BAN_SECONDS = int(os.environ.get("BAN_SECONDS", "604800"))

BAN_SET = os.environ.get("BAN_SET", "iptv_ban")
WL_SET = os.environ.get("WL_SET", "iptv_whitelist")
IPTABLES_CHAIN = os.environ.get("IPTABLES_CHAIN", "ANTI_IPTV")

BAN_LOG_DIR = os.environ.get("BAN_LOG_DIR", "/var/log/anti-iptv")
BAN_LOG_FILE = os.environ.get("BAN_LOG_FILE", os.path.join(BAN_LOG_DIR, "bans.log"))

CHECK_CACHE_SECONDS = 300
FULL_SWEEP_EVERY_LINES = 2000

XTREAM_PATHS = ("/player_api.php?", "/get.php?")
USERNAME_RE = re.compile(r"(?:\?|&)username=([^& ]+)")

user_ts_by_ip: Dict[str, Dict[str, int]] = {}
user_line_by_ip: Dict[str, Dict[str, str]] = {}
whitelist_cache: Dict[str, Tuple[bool, int]] = {}
ban_cache: Dict[str, Tuple[bool, int]] = {}
lines_seen = 0
tail_proc = None


def require_root() -> None:
    if os.geteuid() != 0:
        print("Esegui da root", file=sys.stderr)
        sys.exit(1)


def run_cmd(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(
            args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    except FileNotFoundError:
        result = subprocess.CompletedProcess(args=args, returncode=127)
    if check and result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, args)
    return result


def ensure_dir_permissions() -> None:
    os.makedirs(BAN_LOG_DIR, exist_ok=True)
    with open(BAN_LOG_FILE, "a", encoding="utf-8"):
        pass
    try:
        os.chmod(BAN_LOG_DIR, 0o750)
    except OSError:
        pass
    try:
        os.chmod(BAN_LOG_FILE, 0o640)
    except OSError:
        pass


def setup_firewall() -> None:
    if run_cmd("ipset", "list", BAN_SET, check=False).returncode != 0:
        run_cmd("ipset", "create", BAN_SET, "hash:ip", "timeout", str(BAN_SECONDS))

    if run_cmd("ipset", "list", WL_SET, check=False).returncode != 0:
        run_cmd("ipset", "create", WL_SET, "hash:net")

    if run_cmd("iptables", "-nL", IPTABLES_CHAIN, check=False).returncode != 0:
        run_cmd("iptables", "-N", IPTABLES_CHAIN)

    if (
        run_cmd(
            "iptables",
            "-C",
            IPTABLES_CHAIN,
            "-m",
            "set",
            "--match-set",
            WL_SET,
            "src",
            "-j",
            "RETURN",
            check=False,
        ).returncode
        != 0
    ):
        run_cmd(
            "iptables",
            "-I",
            IPTABLES_CHAIN,
            "1",
            "-m",
            "set",
            "--match-set",
            WL_SET,
            "src",
            "-j",
            "RETURN",
        )

    if (
        run_cmd(
            "iptables",
            "-C",
            IPTABLES_CHAIN,
            "-m",
            "set",
            "--match-set",
            BAN_SET,
            "src",
            "-j",
            "DROP",
            check=False,
        ).returncode
        != 0
    ):
        run_cmd(
            "iptables",
            "-A",
            IPTABLES_CHAIN,
            "-m",
            "set",
            "--match-set",
            BAN_SET,
            "src",
            "-j",
            "DROP",
        )

    if (
        run_cmd("iptables", "-C", "INPUT", "-j", IPTABLES_CHAIN, check=False).returncode
        != 0
    ):
        run_cmd("iptables", "-I", "INPUT", "1", "-j", IPTABLES_CHAIN)


def cached_ipset_test(
    set_name: str, ip: str, cache: Dict[str, Tuple[bool, int]]
) -> bool:
    now = int(time.time())
    cached = cache.get(ip)
    if cached and now - cached[1] < CHECK_CACHE_SECONDS:
        return cached[0]

    exists = run_cmd("ipset", "test", set_name, ip, check=False).returncode == 0
    cache[ip] = (exists, now)
    return exists


def extract_request(line: str) -> str:
    first = line.find('"')
    if first == -1:
        return ""
    second = line.find('"', first + 1)
    if second == -1:
        return ""
    return line[first + 1 : second]


def prune_ip(ip: str, cutoff: int) -> None:
    ts_map = user_ts_by_ip.get(ip)
    if not ts_map:
        return

    line_map = user_line_by_ip.get(ip, {})
    expired = [username for username, ts in ts_map.items() if ts < cutoff]
    for username in expired:
        ts_map.pop(username, None)
        line_map.pop(username, None)

    if not ts_map:
        user_ts_by_ip.pop(ip, None)
        user_line_by_ip.pop(ip, None)


def full_sweep(cutoff: int) -> None:
    for ip in list(user_ts_by_ip.keys()):
        prune_ip(ip, cutoff)


def log_ban_to_file(ip: str) -> None:
    line_map = user_line_by_ip.get(ip, {})
    with open(BAN_LOG_FILE, "a", encoding="utf-8") as handle:
        handle.write("============================================================\n")
        handle.write(f"DATA: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        handle.write(f"IP BANNATO: {ip}\n")
        handle.write(
            f"FINESTRA: 6h | BAN: 7d | SOGLIA: >{MAX_USERNAME} username diverse\n"
        )
        handle.write(
            "Righe COMPLETE che hanno scatenato il ban (una per username distinta):\n"
        )
        for line in line_map.values():
            handle.write(line)
            if not line.endswith("\n"):
                handle.write("\n")
        handle.write("============================================================\n\n")


def clear_ip_state(ip: str) -> None:
    user_ts_by_ip.pop(ip, None)
    user_line_by_ip.pop(ip, None)


def ban_ip(ip: str) -> None:
    if cached_ipset_test(WL_SET, ip, whitelist_cache):
        clear_ip_state(ip)
        return

    if cached_ipset_test(BAN_SET, ip, ban_cache):
        clear_ip_state(ip)
        return

    run_cmd("ipset", "add", BAN_SET, ip, "timeout", str(BAN_SECONDS))
    ban_cache[ip] = (True, int(time.time()))

    run_cmd("conntrack", "-D", "-s", ip, check=False)
    log_ban_to_file(ip)
    clear_ip_state(ip)


def process_line(line: str) -> None:
    global lines_seen

    ip = line.split(" ", 1)[0]
    if not ip:
        return

    if cached_ipset_test(WL_SET, ip, whitelist_cache):
        return

    request = extract_request(line)
    if not request:
        return

    if not any(path in request for path in XTREAM_PATHS):
        return

    match = USERNAME_RE.search(request)
    if not match:
        return

    username = match.group(1)
    now = int(time.time())
    cutoff = now - WINDOW_SECONDS

    ts_map = user_ts_by_ip.setdefault(ip, {})
    line_map = user_line_by_ip.setdefault(ip, {})

    ts_map[username] = now
    line_map[username] = line
    prune_ip(ip, cutoff)

    ts_map = user_ts_by_ip.get(ip, {})
    if len(ts_map) > MAX_USERNAME:
        ban_ip(ip)

    lines_seen += 1
    if lines_seen % FULL_SWEEP_EVERY_LINES == 0:
        full_sweep(cutoff)


def forward_signal(signum, _frame) -> None:
    if tail_proc and tail_proc.poll() is None:
        try:
            tail_proc.send_signal(signum)
        except ProcessLookupError:
            pass
    sys.exit(0)


def main() -> None:
    global tail_proc

    require_root()
    ensure_dir_permissions()
    setup_firewall()

    signal.signal(signal.SIGTERM, forward_signal)
    signal.signal(signal.SIGINT, forward_signal)

    tail_proc = subprocess.Popen(
        ["tail", "-F", LOGFILE],
        stdout=subprocess.PIPE,
        stderr=None,
        text=True,
        bufsize=1,
    )

    assert tail_proc.stdout is not None
    for line in tail_proc.stdout:
        try:
            process_line(line)
        except Exception:
            continue


if __name__ == "__main__":
    main()
