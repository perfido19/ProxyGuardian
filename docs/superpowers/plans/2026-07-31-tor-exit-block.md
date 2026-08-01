# Tor Exit-Node Block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bloccare (DROP) il traffico dai nodi Tor exit-node su tutta la fleet ProxyGuardian, con refresh orario automatico della lista da torproject.org, colmando un gap identificato nel confronto con il competitor Odin ASRP.

**Architecture:** Stesso pattern di ASN Block (ipset + iptables + whitelist condivisa `/etc/asn-whitelist-nets.txt`), ma con refresh **automatico orario via systemd timer** invece di un bottone manuale, perché la lista Tor cambia in continuazione. Un ipset `tor_exit` (hash:ip) viene rigenerato ogni ora da uno script Python che scarica `https://check.torproject.org/torbulkexitlist`, esclude gli IP in whitelist, e sostituisce atomicamente il set (swap, mai flush-poi-refill). Un endpoint agent nuovo espone stato/refresh manuale; un tab dashboard nuovo (dentro la pagina ASN Block esistente) mostra stato per-VPS.

**Tech Stack:** Bash + Python3 stdlib (nessuna dipendenza esterna, a differenza di ASN Block che usa `maxminddb`) sull'agent/VPS; Express+TypeScript per l'agent endpoint e le route dashboard; React+TypeScript (TanStack Query) per la UI.

## Global Constraints

- Agent (`agent/index.ts`) è compilato con `esbuild --target=node12`: **non usare `??` o `?.`** nel codice TypeScript aggiunto — solo `||` e `&&` (vincolo da CLAUDE.md).
- Ogni modifica a `agent/index.ts` richiede rebuild (`cd agent && npm run build`) e commit del bundle rigenerato `agent/agent-bundle.js` — altrimenti i VPS scaricano agent vecchio.
- Whitelist condivisa: riusa `/etc/asn-whitelist-nets.txt` esistente (nessun file nuovo) — protegge già NetBird/dashboard/main backend (fix 2026-07-08).
- Blocco totale (DROP), non solo log — decisione già presa in fase di brainstorming.
- Sorgente lista: solo TorProject bulk exit list (`https://check.torproject.org/torbulkexitlist`) — nessun'altra fonte.
- Rollout fleet-wide su tutti i 54 VPS esistenti (incluso DynamoXc) + integrazione nello script Deploy VPS per i nuovi.
- Nessun test automatico esiste in questo repo (nessun framework configurato) — la validazione è: syntax check (`bash -n`, `python3 -m py_compile`, `tsc --noEmit`), poi verifica manuale su un VPS canary prima del rollout fleet-wide, seguendo lo stesso schema già usato per il fix X-Forwarded-For del 2026-07-30.
- **Deviazione dallo spec approvato**: lo spec (`docs/superpowers/specs/2026-07-31-tor-exit-block-design.md`) proponeva nuove fleet route dedicate (`GET/POST /api/fleet/tor-block/*`). Esplorando il codice esistente si è visto che la UI "ASN Block" esistente (`asn-block.tsx`, tab "Blocklist ASN") non usa route fleet dedicate per letture/azioni bulk — chiama direttamente dal frontend gli endpoint generici già esistenti `POST /api/vps/bulk/get` e `POST /api/vps/bulk/post` (già registrati in `server/routes.ts`, già gestiscono permessi/filtri VPS per operator). Questo piano segue quella stessa convenzione già in uso (YAGNI: zero route nuove in `server/routes.ts` per status/refresh, solo i due endpoint agent). Le regole iptables usano `-A INPUT` (append) invece di `-I INPUT <N>` posizionale: verificato che il chain INPUT del deploy script fresco non ha una policy DROP finale né un catch-all — solo regole mirate per ipset/porta — quindi append è sicuro e coerente con le regole anti-spoofing TCP già presenti (righe 2505-2507 di `server/routes.ts`, anch'esse in `-A`).

---

### Task 1: Script Python di refresh (fetch + whitelist + ipset swap)

**Files:**
- Create: `scripts/tor-to-ipset.py`

**Interfaces:**
- Consumes: nulla (nessuna dipendenza da altri task)
- Produces: script CLI eseguibile via `python3 /usr/local/bin/tor-to-ipset.py`, stampa su stdout il conteggio IP inseriti, exit code 0 su successo / 1 su errore (fetch fallito o lista sospetta) — consumato da Task 2 (`update-tor-block.sh`)

- [ ] **Step 1: Scrivi lo script**

```python
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
```

- [ ] **Step 2: Verifica sintassi**

Run: `python3 -m py_compile scripts/tor-to-ipset.py && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 3: Commit**

```bash
git add scripts/tor-to-ipset.py
git commit -m "feat: script fetch+whitelist+ipset swap per Tor exit-node block"
```

---

### Task 2: Wrapper bash con lock file

**Files:**
- Create: `scripts/update-tor-block.sh`

**Interfaces:**
- Consumes: `python3 /usr/local/bin/tor-to-ipset.py` (Task 1, path finale dopo deploy — in questo repo resta `scripts/tor-to-ipset.py`, il deploy script lo installa in `/usr/local/bin/`)
- Produces: comando `update-tor-block.sh` invocabile da systemd timer (Task 3) e dall'agent endpoint `/api/tor-block/refresh` (Task 4) via `sudo /usr/local/bin/update-tor-block.sh`; scrive log in `/var/log/update-tor-block.log`

- [ ] **Step 1: Scrivi lo script**

```bash
#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

WHITELIST_FILE="/etc/asn-whitelist-nets.txt"
LOCK_FILE="/var/run/tor-block-update.lock"
LOG_TAG="[update-tor-block]"

[[ -f "$WHITELIST_FILE" ]] || touch "$WHITELIST_FILE"

if [[ -f "$LOCK_FILE" ]]; then
    echo "$LOG_TAG Aggiornamento gia' in corso, salto" >&2
    exit 0
fi
touch "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

echo "$LOG_TAG $(date '+%Y-%m-%d %H:%M:%S') Avvio aggiornamento tor_exit..."
if COUNT=$(python3 /usr/local/bin/tor-to-ipset.py); then
    echo "$LOG_TAG Completato: $COUNT IP in tor_exit"
    ipset save > /etc/ipset.conf
else
    echo "$LOG_TAG ERRORE durante l'aggiornamento, ipset esistente non toccato" >&2
    exit 1
fi
```

- [ ] **Step 2: Verifica sintassi**

Run: `bash -n scripts/update-tor-block.sh && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 3: Commit**

```bash
git add scripts/update-tor-block.sh
git commit -m "feat: wrapper update-tor-block.sh con lock file"
```

---

### Task 3: Estendi whitelist-watcher.sh per triggerare anche Tor block

**Files:**
- Modify: `scripts/whitelist-watcher.sh`

**Interfaces:**
- Consumes: `/usr/local/bin/update-tor-block.sh` (Task 2, verificato con `-x` prima di chiamarlo — VPS senza Tor Block installato non lo trovano e saltano senza errore)
- Produces: nessuna nuova interfaccia — comportamento esteso dello stesso watcher esistente

- [ ] **Step 1: Modifica il blocco di aggiornamento**

Nel file esistente, sostituisci:

```bash
    {
        log "Avvio flush e aggiornamento set ipset..."
        if "$UPDATE_SCRIPT" >> /var/log/update-asn-block.log 2>&1; then
            log "Aggiornamento completato con successo"
        else
            log "ERRORE durante l'aggiornamento — controlla /var/log/update-asn-block.log"
        fi
    }
```

con:

```bash
    {
        log "Avvio flush e aggiornamento set ipset..."
        if "$UPDATE_SCRIPT" >> /var/log/update-asn-block.log 2>&1; then
            log "Aggiornamento completato con successo"
        else
            log "ERRORE durante l'aggiornamento — controlla /var/log/update-asn-block.log"
        fi

        if [[ -x /usr/local/bin/update-tor-block.sh ]]; then
            log "Avvio aggiornamento Tor block..."
            if /usr/local/bin/update-tor-block.sh >> /var/log/update-tor-block.log 2>&1; then
                log "Tor block aggiornato con successo"
            else
                log "ERRORE durante l'aggiornamento Tor block — controlla /var/log/update-tor-block.log"
            fi
        fi
    }
```

- [ ] **Step 2: Verifica sintassi**

Run: `bash -n scripts/whitelist-watcher.sh && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 3: Commit**

```bash
git add scripts/whitelist-watcher.sh
git commit -m "feat: whitelist-watcher aggiorna anche tor_exit su modifica whitelist"
```

---

### Task 4: Endpoint agent — status e refresh manuale

**Files:**
- Modify: `agent/index.ts`
- Modify: `agent/agent-bundle.js` (rigenerato, non editato a mano)

**Interfaces:**
- Consumes: `runCmd()` helper già esistente in `agent/index.ts:68`; costante di stile `ASN_UPDATE_SCRIPT` come riferimento (riga 1324)
- Produces: `GET /api/tor-block/status` → `{ enabled: boolean, installed: boolean, count: number, lastUpdate: string }`; `POST /api/tor-block/refresh` → `{ success: boolean, output: string }` — consumati dal frontend (Task 8) via `/api/vps/bulk/get` e `/api/vps/bulk/post`

- [ ] **Step 1: Aggiungi la costante e gli endpoint**

Trova in `agent/index.ts` la riga (circa 1329):
```ts
const ASN_AGENT_USER = process.env.USER || "pgagent";
```

Subito dopo, aggiungi:
```ts

const TOR_UPDATE_SCRIPT = "/usr/local/bin/update-tor-block.sh";
```

Poi trova il blocco (circa righe 1545-1549):
```ts
app.get("/api/asn/log", async (_req, res) => {
  const { stdout } = await runCmd("tail -100 /var/log/update-asn-block.log 2>/dev/null || echo ''");
  res.json({ lines: stdout.split("\n").filter(Boolean) });
});

// ─── Sudoers management ───────────────────────────────────────────────────────
```

Sostituiscilo con:
```ts
app.get("/api/asn/log", async (_req, res) => {
  const { stdout } = await runCmd("tail -100 /var/log/update-asn-block.log 2>/dev/null || echo ''");
  res.json({ lines: stdout.split("\n").filter(Boolean) });
});

// ─── Tor exit-node block ──────────────────────────────────────────────────────

app.get("/api/tor-block/status", async (_req, res) => {
  try {
    const [timerActive, count, lastMtime] = await Promise.all([
      runCmd("systemctl is-active tor-block-update.timer 2>/dev/null"),
      runCmd("sudo ipset list tor_exit 2>/dev/null | grep -cE '^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$' || echo 0"),
      runCmd("stat -c %Y /var/log/update-tor-block.log 2>/dev/null || echo 0"),
    ]);
    const mtimeSec = parseInt(lastMtime.stdout.trim()) || 0;
    const lastUpdate = mtimeSec > 0 ? new Date(mtimeSec * 1000).toISOString() : "";
    res.json({
      enabled: timerActive.stdout.trim() === "active",
      installed: existsSync(TOR_UPDATE_SCRIPT),
      count: parseInt(count.stdout.trim()) || 0,
      lastUpdate: lastUpdate,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tor-block/refresh", async (_req, res) => {
  if (!existsSync(TOR_UPDATE_SCRIPT)) {
    return res.status(404).json({ success: false, error: "Script update-tor-block.sh non trovato. Tor Block non è installato su questo VPS." });
  }
  const result = await runCmd("sudo " + TOR_UPDATE_SCRIPT + " 2>&1", 60000);
  res.json({ success: result.ok, output: result.stdout || result.stderr });
});

// ─── Sudoers management ───────────────────────────────────────────────────────
```

- [ ] **Step 2: Typecheck**

Run: `cd agent && npx tsc --noEmit index.ts 2>&1 | head -50`
Expected: nessun errore relativo alle righe aggiunte (eventuali errori preesistenti nel resto del file non sono responsabilità di questo task)

- [ ] **Step 3: Rebuild bundle**

Run: `cd agent && npm run build`
Expected: `agent-bundle.js` rigenerato senza errori esbuild

- [ ] **Step 4: Commit**

```bash
git add agent/index.ts agent/agent-bundle.js
git commit -m "feat: endpoint agent /api/tor-block/status e /api/tor-block/refresh"
```

---

### Task 5: Systemd unit constants + sudoers per il deploy

**Files:**
- Modify: `server/routes.ts`

**Interfaces:**
- Consumes: nessuna
- Produces: costanti `DEPLOY_TOR_BLOCK_SERVICE`, `DEPLOY_TOR_BLOCK_TIMER` (stringhe) e riga sudoers — consumate da Task 6

- [ ] **Step 1: Aggiungi le costanti systemd**

Trova (circa riga 296):
```ts
const DEPLOY_ANTI_IPTV_SERVICE = [
  "[Unit]",
  "Description=ProxyGuardian Anti-IPTV watcher",
  "After=network.target nginx.service",
  "Wants=nginx.service",
  "",
  "[Service]",
  "Type=simple",
  "ExecStart=/usr/local/sbin/anti-iptv.sh",
  "Restart=always",
  "RestartSec=5",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
  "",
].join("\n");
```

Subito dopo, aggiungi:
```ts
const DEPLOY_TOR_BLOCK_SERVICE = [
  "[Unit]",
  "Description=Aggiorna ipset tor_exit dalla lista Tor Project exit-node",
  "After=network-online.target ipset-restore.service",
  "Wants=network-online.target",
  "",
  "[Service]",
  "Type=oneshot",
  "ExecStart=/usr/local/bin/update-tor-block.sh",
  "",
].join("\n");
const DEPLOY_TOR_BLOCK_TIMER = [
  "[Unit]",
  "Description=Timer orario refresh Tor exit-node block",
  "",
  "[Timer]",
  "OnCalendar=hourly",
  "Persistent=true",
  "",
  "[Install]",
  "WantedBy=timers.target",
  "",
].join("\n");
```

- [ ] **Step 2: Aggiungi la riga sudoers**

Trova (circa riga 150):
```ts
  "pgagent ALL=(ALL) NOPASSWD: /usr/local/bin/update-asn-block.sh",
```

Subito dopo, aggiungi:
```ts
  "pgagent ALL=(ALL) NOPASSWD: /usr/local/bin/update-tor-block.sh",
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p . 2>&1 | head -50`
Expected: nessun nuovo errore introdotto dalle righe aggiunte

- [ ] **Step 4: Commit**

```bash
git add server/routes.ts
git commit -m "feat: unit systemd e sudoers per Tor exit-node block"
```

---

### Task 6: Integra Tor Block nella generazione dello script di deploy

**Files:**
- Modify: `server/routes.ts`

**Interfaces:**
- Consumes: `DEPLOY_TOR_BLOCK_SERVICE`, `DEPLOY_TOR_BLOCK_TIMER` (Task 5); `scripts/tor-to-ipset.py`, `scripts/update-tor-block.sh` (Task 1, 2); `parseDeployToggle()` helper esistente (riga 319)
- Produces: campo `installTorBlock` nel body di `POST /api/deploy/generate-script` e nella risposta (`config.installTorBlock`, `embeddedConfigs.torBlock`) — consumato dal frontend (Task 7)

- [ ] **Step 1: Aggiungi i path constant**

Trova, dentro `registerRoutes` (circa riga 1441):
```ts
  const WHITELIST_WATCHER_PATH = join(process.cwd(), "scripts", "whitelist-watcher.sh");
```

Subito dopo, aggiungi:
```ts
  const TOR_TO_IPSET_PATH = join(process.cwd(), "scripts", "tor-to-ipset.py");
  const UPDATE_TOR_BLOCK_PATH = join(process.cwd(), "scripts", "update-tor-block.sh");
```

- [ ] **Step 2: Aggiungi il toggle e la lettura file**

Trova (circa riga 1966-1967):
```ts
      const installAsnBlock = parseDeployToggle(req.body?.installAsnBlock, true);
      const installAntiIptv = parseDeployToggle(req.body?.installAntiIptv, false);
```

Sostituiscilo con:
```ts
      const installAsnBlock = parseDeployToggle(req.body?.installAsnBlock, true);
      const installAntiIptv = parseDeployToggle(req.body?.installAntiIptv, false);
      const installTorBlock = parseDeployToggle(req.body?.installTorBlock, true);
```

Trova (circa riga 2020-2021):
```ts
      const updateListsScript = installAsnBlock ? readFileSync(UPDATE_LISTS_PATH, "utf-8") : "";
      const whitelistWatcherScript = installAsnBlock ? readFileSync(WHITELIST_WATCHER_PATH, "utf-8") : "";
```

Sostituiscilo con:
```ts
      const updateListsScript = installAsnBlock ? readFileSync(UPDATE_LISTS_PATH, "utf-8") : "";
      const whitelistWatcherScript = installAsnBlock ? readFileSync(WHITELIST_WATCHER_PATH, "utf-8") : "";
      const torToIpsetPy = installTorBlock ? readFileSync(TOR_TO_IPSET_PATH, "utf-8") : "";
      const updateTorBlockScript = installTorBlock ? readFileSync(UPDATE_TOR_BLOCK_PATH, "utf-8") : "";
```

- [ ] **Step 3: Aggiungi il pacchetto python3 alla lista opzionale**

Trova (circa riga 2031-2034):
```ts
      const optionalPackages = Array.from(new Set([
        ...(installAsnBlock ? ["ipset", "inotify-tools", "python3-maxminddb", "python3-pip"] : []),
        ...(installAntiIptv ? ["conntrack", "ipset"] : []),
      ]));
```

Sostituiscilo con:
```ts
      const optionalPackages = Array.from(new Set([
        ...(installAsnBlock ? ["ipset", "inotify-tools", "python3-maxminddb", "python3-pip"] : []),
        ...(installAntiIptv ? ["conntrack", "ipset"] : []),
        ...(installTorBlock ? ["ipset", "python3"] : []),
      ]));
```

- [ ] **Step 4: Aggiungi il blocco di setup dello script deploy**

Trova (circa righe 2211-2234, subito dopo la chiusura di `antiIptvSetup`):
```ts
      const antiIptvSetup = installAntiIptv
        ? `# ── ANTI-IPTV ──────────────────────────────────────────────
info "Installing Anti-IPTV support..."
mkdir -p /var/log/anti-iptv
touch /var/log/anti-iptv/bans.log

cat > /usr/local/sbin/anti-iptv.py << 'ANTIIPTVPYEOF'
${antiIptvPy}
ANTIIPTVPYEOF

cat > /usr/local/sbin/anti-iptv.sh << 'ANTIIPTVSHEOF'
${antiIptvSh}
ANTIIPTVSHEOF

chmod 755 /usr/local/sbin/anti-iptv.py /usr/local/sbin/anti-iptv.sh
chown root:adm /var/log/anti-iptv /var/log/anti-iptv/bans.log 2>/dev/null || true
chmod 750 /var/log/anti-iptv 2>/dev/null || true
chmod 640 /var/log/anti-iptv/bans.log 2>/dev/null || true

cat > /etc/systemd/system/anti-iptv.service << 'ANTIIPTVSVCEOF'
${DEPLOY_ANTI_IPTV_SERVICE}
ANTIIPTVSVCEOF`
        : `# ── ANTI-IPTV ──────────────────────────────────────────────
info "Anti-IPTV disabilitato per questo deploy"`;
```

Subito dopo, aggiungi:
```ts

      const torBlockSetup = installTorBlock
        ? `# ── TOR EXIT BLOCK ────────────────────────────────────────
info "Installing Tor exit-node block support..."
touch /etc/ipset.conf /var/log/update-tor-block.log
[ -f /etc/asn-whitelist-nets.txt ] || touch /etc/asn-whitelist-nets.txt

cat > /usr/local/bin/tor-to-ipset.py << 'TORTOIPSETEOF'
${torToIpsetPy}
TORTOIPSETEOF

cat > /usr/local/bin/update-tor-block.sh << 'UPDATETORBLOCKEOF'
${updateTorBlockScript}
UPDATETORBLOCKEOF

chmod 755 /usr/local/bin/tor-to-ipset.py /usr/local/bin/update-tor-block.sh

${!installAsnBlock ? `# ipset-restore.service normalmente installato solo da ASN Block — necessario
# comunque qui perche' e' generico (ripristina qualunque /etc/ipset.conf al boot)
# e Tor Block deve sopravvivere al reboot anche se ASN Block e' disattivato.
cat > /etc/systemd/system/ipset-restore.service << 'IPSETRESTOREEOF'
${DEPLOY_IPSET_RESTORE_SERVICE}
IPSETRESTOREEOF
systemctl enable ipset-restore >/dev/null 2>&1 || true
systemctl start ipset-restore >/dev/null 2>&1 || true` : ""}

cat > /etc/systemd/system/tor-block-update.service << 'TORBLOCKSVCEOF'
${DEPLOY_TOR_BLOCK_SERVICE}
TORBLOCKSVCEOF

cat > /etc/systemd/system/tor-block-update.timer << 'TORBLOCKTIMEREOF'
${DEPLOY_TOR_BLOCK_TIMER}
TORBLOCKTIMEREOF

ipset create tor_exit hash:ip family inet maxelem 65536 -exist
iptables -C INPUT -m set --match-set tor_exit src -m limit --limit 10/min --limit-burst 20 -j LOG --log-prefix "[TOR-BLOCK] " --log-level 4 2>/dev/null || \\
  iptables -A INPUT -m set --match-set tor_exit src -m limit --limit 10/min --limit-burst 20 -j LOG --log-prefix "[TOR-BLOCK] " --log-level 4
iptables -C INPUT -m set --match-set tor_exit src -j DROP 2>/dev/null || \\
  iptables -A INPUT -m set --match-set tor_exit src -j DROP
ipset save > /etc/ipset.conf

systemctl daemon-reload
/usr/local/bin/update-tor-block.sh >> /var/log/update-tor-block.log 2>&1 || warn "Aggiornamento iniziale Tor block fallito (torproject.org raggiungibile?)"`
        : `# ── TOR EXIT BLOCK ────────────────────────────────────────
info "Tor exit-node block disabilitato per questo deploy"`;
```

- [ ] **Step 5: Inserisci il blocco nello script finale e abilita il timer**

Trova, dentro il template letterale dello script finale (circa riga 2464-2468 dell'originale, prima di qualunque modifica di questo task):
```
${asnBlockSetup}

${antiIptvSetup}

${crowdSecSetup}
```

Sostituiscilo con:
```
${asnBlockSetup}

${antiIptvSetup}

${crowdSecSetup}

${torBlockSetup}
```

Poi trova (circa riga 2724-2728):
```ts
${installAsnBlock ? `systemctl enable ipset-restore whitelist-watcher >/dev/null 2>&1 || true
systemctl start ipset-restore >/dev/null 2>&1 || true
systemctl restart whitelist-watcher >/dev/null 2>&1 || true` : ""}
${installAntiIptv ? `systemctl enable anti-iptv >/dev/null 2>&1 || true
systemctl restart anti-iptv >/dev/null 2>&1 || true` : ""}
```

Sostituiscilo con:
```ts
${installAsnBlock ? `systemctl enable ipset-restore whitelist-watcher >/dev/null 2>&1 || true
systemctl start ipset-restore >/dev/null 2>&1 || true
systemctl restart whitelist-watcher >/dev/null 2>&1 || true` : ""}
${installAntiIptv ? `systemctl enable anti-iptv >/dev/null 2>&1 || true
systemctl restart anti-iptv >/dev/null 2>&1 || true` : ""}
${installTorBlock ? `systemctl enable tor-block-update.timer >/dev/null 2>&1 || true
systemctl start tor-block-update.timer >/dev/null 2>&1 || true` : ""}
```

- [ ] **Step 6: Aggiungi il campo alla risposta JSON**

Trova (circa righe 2771-2794):
```ts
      res.json({
        script,
        config: {
          vpsName: name,
          backendIp: bIp,
          backendPort: bPort,
          proxyPort: pPort,
          installAsnBlock,
          installAntiIptv,
          installCrowdSec,
        },
        embeddedConfigs: {
          countryWhitelist: !!countryWhitelist && countryWhitelist.trim().length > 0,
          blockAsn: installAsnBlock,
          blockIsp: !!blockIsp && blockIsp.trim().length > 0,
          blockBadAgents: !!blockBadAgents && blockBadAgents.trim().length > 0,
          ipWhitelist: !!ipWhitelist && ipWhitelist.trim().length > 0,
          exclusionIp: !!exclusionIp && exclusionIp.trim().length > 0,
          antiIptv: installAntiIptv,
          crowdSec: installCrowdSec,
          modsecRelaxed: true,
          nginxOptimized: true,
        },
      });
```

Sostituiscilo con:
```ts
      res.json({
        script,
        config: {
          vpsName: name,
          backendIp: bIp,
          backendPort: bPort,
          proxyPort: pPort,
          installAsnBlock,
          installAntiIptv,
          installCrowdSec,
          installTorBlock,
        },
        embeddedConfigs: {
          countryWhitelist: !!countryWhitelist && countryWhitelist.trim().length > 0,
          blockAsn: installAsnBlock,
          blockIsp: !!blockIsp && blockIsp.trim().length > 0,
          blockBadAgents: !!blockBadAgents && blockBadAgents.trim().length > 0,
          ipWhitelist: !!ipWhitelist && ipWhitelist.trim().length > 0,
          exclusionIp: !!exclusionIp && exclusionIp.trim().length > 0,
          antiIptv: installAntiIptv,
          crowdSec: installCrowdSec,
          torBlock: installTorBlock,
          modsecRelaxed: true,
          nginxOptimized: true,
        },
      });
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit -p . 2>&1 | head -50`
Expected: nessun errore

- [ ] **Step 8: Genera uno script di prova e verifica il contenuto**

Run: `curl -s -X POST http://localhost:5000/api/deploy/generate-script -H "Content-Type: application/json" -b <cookie-sessione-admin> -d '{"vpsName":"test-tor","backendIp":"1.2.3.4","installTorBlock":true}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('tor_exit' in d['script'], d['config']['installTorBlock'])"`
Expected: `True True` (richiede sessione admin valida sul dashboard in esecuzione locale — se il dashboard non gira in locale in questo momento, salta questo step e verificalo nel Task 11 con il dashboard di produzione)

- [ ] **Step 9: Commit**

```bash
git add server/routes.ts
git commit -m "feat: integra Tor Block nello script di deploy VPS"
```

---

### Task 7: Checkbox "Installa Tor Block" nella pagina Deploy VPS

**Files:**
- Modify: `client/src/pages/deploy-vps.tsx`

**Interfaces:**
- Consumes: campo `installTorBlock` nel body di `/api/deploy/generate-script` (Task 6)
- Produces: nessuna nuova interfaccia consumata da altri task

- [ ] **Step 1: Aggiungi lo state**

Trova (circa riga 33-35):
```tsx
  const [installAsnBlock, setInstallAsnBlock] = useState(true);
  const [installAntiIptv, setInstallAntiIptv] = useState(false);
  const [installCrowdSec, setInstallCrowdSec] = useState(false);
```

Sostituiscilo con:
```tsx
  const [installAsnBlock, setInstallAsnBlock] = useState(true);
  const [installAntiIptv, setInstallAntiIptv] = useState(false);
  const [installCrowdSec, setInstallCrowdSec] = useState(false);
  const [installTorBlock, setInstallTorBlock] = useState(true);
```

- [ ] **Step 2: Aggiungi il campo al payload**

Trova (circa righe 46-54):
```tsx
      const res = await apiRequest("POST", "/api/deploy/generate-script", {
        vpsName: vpsName.trim(),
        backendIp: backendIp.trim(),
        backendPort: parseInt(backendPort) || 8880,
        proxyPort: parseInt(proxyPort) || 8880,
        installAsnBlock,
        installAntiIptv,
        installCrowdSec,
      });
```

Sostituiscilo con:
```tsx
      const res = await apiRequest("POST", "/api/deploy/generate-script", {
        vpsName: vpsName.trim(),
        backendIp: backendIp.trim(),
        backendPort: parseInt(backendPort) || 8880,
        proxyPort: parseInt(proxyPort) || 8880,
        installAsnBlock,
        installAntiIptv,
        installCrowdSec,
        installTorBlock,
      });
```

- [ ] **Step 3: Aggiungi la checkbox nella UI**

Trova (circa righe 176-204):
```tsx
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 rounded-lg border p-4 bg-muted/20">
              <label className="flex items-start gap-3 cursor-pointer">
                <Checkbox checked={installAsnBlock} onCheckedChange={checked => setInstallAsnBlock(checked === true)} />
                <div className="space-y-1">
                  <div className="text-sm font-medium leading-none">Installa ASN Block</div>
                  <p className="text-xs text-muted-foreground">
                    Preconfigura gli script e i servizi AsnBlock sul nuovo VPS.
                  </p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <Checkbox checked={installAntiIptv} onCheckedChange={checked => setInstallAntiIptv(checked === true)} />
                <div className="space-y-1">
                  <div className="text-sm font-medium leading-none">Installa Anti-IPTV</div>
                  <p className="text-xs text-muted-foreground">
                    Selezione per installare lo script anti-IPTV.
                  </p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <Checkbox checked={installCrowdSec} onCheckedChange={checked => setInstallCrowdSec(checked === true)} />
                <div className="space-y-1">
                  <div className="text-sm font-medium leading-none">Installa CrowdSec</div>
                  <p className="text-xs text-muted-foreground">
                    IDS/IPS con blocklist community e coordinamento fleet.
                  </p>
                </div>
              </label>
            </div>
```

Sostituiscilo con:
```tsx
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 rounded-lg border p-4 bg-muted/20">
              <label className="flex items-start gap-3 cursor-pointer">
                <Checkbox checked={installAsnBlock} onCheckedChange={checked => setInstallAsnBlock(checked === true)} />
                <div className="space-y-1">
                  <div className="text-sm font-medium leading-none">Installa ASN Block</div>
                  <p className="text-xs text-muted-foreground">
                    Preconfigura gli script e i servizi AsnBlock sul nuovo VPS.
                  </p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <Checkbox checked={installAntiIptv} onCheckedChange={checked => setInstallAntiIptv(checked === true)} />
                <div className="space-y-1">
                  <div className="text-sm font-medium leading-none">Installa Anti-IPTV</div>
                  <p className="text-xs text-muted-foreground">
                    Selezione per installare lo script anti-IPTV.
                  </p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <Checkbox checked={installCrowdSec} onCheckedChange={checked => setInstallCrowdSec(checked === true)} />
                <div className="space-y-1">
                  <div className="text-sm font-medium leading-none">Installa CrowdSec</div>
                  <p className="text-xs text-muted-foreground">
                    IDS/IPS con blocklist community e coordinamento fleet.
                  </p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <Checkbox checked={installTorBlock} onCheckedChange={checked => setInstallTorBlock(checked === true)} />
                <div className="space-y-1">
                  <div className="text-sm font-medium leading-none">Installa Tor Block</div>
                  <p className="text-xs text-muted-foreground">
                    Blocca gli IP dei nodi Tor exit-node, refresh orario automatico.
                  </p>
                </div>
              </label>
            </div>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p . 2>&1 | head -50`
Expected: nessun errore

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/deploy-vps.tsx
git commit -m "feat: checkbox Installa Tor Block nella pagina Deploy VPS"
```

---

### Task 8: Tab "Tor Exit" nella pagina ASN Block

**Files:**
- Modify: `client/src/pages/asn-block.tsx`

**Interfaces:**
- Consumes: `GET /api/tor-block/status`, `POST /api/tor-block/refresh` (Task 4) via i generici `/api/vps/bulk/get` / `/api/vps/bulk/post` già registrati in `server/routes.ts`; tipo `BulkResult` già definito in questo file (riga 27); variabili `onlineVps`, `canWrite` già calcolate nel componente `AsnBlock` (righe 890, 888)
- Produces: nessuna nuova interfaccia consumata da altri task

- [ ] **Step 1: Aggiungi l'icona mancante e il tipo**

Trova (circa righe 18-21):
```tsx
import {
  Plus, Trash2, Search, RefreshCw, CheckCircle, XCircle,
  Shield, Activity, Settings, FileText, AlertTriangle, Play, Database, Copy, Save,
} from "lucide-react";
```

Sostituiscilo con:
```tsx
import {
  Plus, Trash2, Search, RefreshCw, CheckCircle, XCircle,
  Shield, Activity, Settings, FileText, AlertTriangle, Play, Database, Copy, Save, Ban,
} from "lucide-react";
```

Trova (circa riga 31):
```tsx
interface WhitelistEntry { value: string; comment: string; type: "cidr" | "domain"; }
```

Subito dopo, aggiungi:
```tsx
interface TorBlockStatus { enabled: boolean; installed?: boolean; count: number; lastUpdate: string; }
```

- [ ] **Step 2: Aggiungi il componente `TabTorBlock`**

Subito prima di `function TabBlocklist(` (circa riga 688), aggiungi:

```tsx
function TabTorBlock({ onlineVps, canWrite }: { onlineVps: any[]; canWrite: boolean }) {
  const { toast } = useToast();

  const { data: bulkResults, isLoading, refetch } = useQuery<BulkResult[]>({
    queryKey: ["tor-block-status", onlineVps.map(v => v.id).join(",")],
    queryFn: async () => {
      const r = await apiRequest("POST", "/api/vps/bulk/get", {
        vpsIds: onlineVps.map(v => v.id),
        path: "/api/tor-block/status",
      });
      return r.json();
    },
    enabled: onlineVps.length > 0,
    refetchInterval: 120000,
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/vps/bulk/post", {
        vpsIds: onlineVps.map(v => v.id),
        path: "/api/tor-block/refresh",
        body: {},
      });
      return r.json();
    },
    onSuccess: (data: BulkResult[]) => {
      refetch();
      const ok = data.filter(r => r.success).length;
      toast({ title: "Refresh Tor Block avviato", description: `${ok}/${data.length} VPS aggiornati` });
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const rows = onlineVps.map(vps => {
    const result = (bulkResults || []).find(r => r.vpsId === vps.id);
    const status: TorBlockStatus | undefined = result && result.success ? result.data : undefined;
    return { vps, result, status };
  });

  const activeCount = rows.filter(r => r.status && r.status.enabled).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <CardTitle>Tor Exit-Node Block</CardTitle>
              <CardDescription>
                Blocco IP dei nodi Tor exit (sorgente: check.torproject.org, refresh orario automatico) — {activeCount}/{onlineVps.length} VPS con timer attivo
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
                <RefreshCw className="w-4 h-4 mr-1" />Aggiorna stato
              </Button>
              <Button size="sm" onClick={() => refreshMutation.mutate()} disabled={!canWrite || refreshMutation.isPending}>
                <Play className="w-4 h-4 mr-1" />{refreshMutation.isPending ? "Avvio..." : "Forza refresh ora"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? <LoadingState message="Caricamento stato Tor Block..." /> : (
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>VPS</TableHead>
                    <TableHead>Timer</TableHead>
                    <TableHead>IP in blocco</TableHead>
                    <TableHead>Ultimo aggiornamento</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Nessun VPS online</TableCell></TableRow>
                  ) : rows.map(({ vps, result, status }) => (
                    <TableRow key={vps.id}>
                      <TableCell className="font-medium">{vps.name}</TableCell>
                      <TableCell>
                        {!result || !result.success ? (
                          <Badge variant="outline" className="text-xs border-red-500/40 text-red-500">Errore</Badge>
                        ) : status && status.installed === false ? (
                          <Badge variant="outline" className="text-xs border-muted-foreground/40 text-muted-foreground">Non installato</Badge>
                        ) : status && status.enabled ? (
                          <Badge variant="outline" className="text-xs border-green-600/40 text-green-600">Attivo</Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs border-yellow-500/40 text-yellow-600">Inattivo</Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-sm">{status ? status.count : "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {status && status.lastUpdate ? new Date(status.lastUpdate).toLocaleString("it-IT") : "mai"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

```

- [ ] **Step 3: Aggiungi il tab nel componente principale**

Trova (circa righe 960-967):
```tsx
      <Tabs defaultValue="panoramica">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="panoramica"><Activity className="w-3.5 h-3.5 mr-1.5" />Panoramica</TabsTrigger>
          <TabsTrigger value="gestione"><Settings className="w-3.5 h-3.5 mr-1.5" />Gestione</TabsTrigger>
          <TabsTrigger value="whitelist"><Shield className="w-3.5 h-3.5 mr-1.5" />Whitelist</TabsTrigger>
          <TabsTrigger value="log"><FileText className="w-3.5 h-3.5 mr-1.5" />Log</TabsTrigger>
          <TabsTrigger value="blocklist"><Database className="w-3.5 h-3.5 mr-1.5" />Blocklist ASN</TabsTrigger>
        </TabsList>
```

Sostituiscilo con:
```tsx
      <Tabs defaultValue="panoramica">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="panoramica"><Activity className="w-3.5 h-3.5 mr-1.5" />Panoramica</TabsTrigger>
          <TabsTrigger value="gestione"><Settings className="w-3.5 h-3.5 mr-1.5" />Gestione</TabsTrigger>
          <TabsTrigger value="whitelist"><Shield className="w-3.5 h-3.5 mr-1.5" />Whitelist</TabsTrigger>
          <TabsTrigger value="log"><FileText className="w-3.5 h-3.5 mr-1.5" />Log</TabsTrigger>
          <TabsTrigger value="blocklist"><Database className="w-3.5 h-3.5 mr-1.5" />Blocklist ASN</TabsTrigger>
          <TabsTrigger value="torblock"><Ban className="w-3.5 h-3.5 mr-1.5" />Tor Exit</TabsTrigger>
        </TabsList>
```

Trova (righe esatte, la chiusura del tab "blocklist" seguita dalla chiusura di `<Tabs>`):
```tsx
        <TabsContent value="blocklist" className="pt-4">
          <TabBlocklist
            selectedVps={selectedVps}
            setSelectedVps={setSelectedVps}
            vpsList={vpsList || []}
            onlineVps={onlineVps}
            canWrite={user?.role === "admin"}
          />
        </TabsContent>
      </Tabs>
```

Sostituiscilo con:
```tsx
        <TabsContent value="blocklist" className="pt-4">
          <TabBlocklist
            selectedVps={selectedVps}
            setSelectedVps={setSelectedVps}
            vpsList={vpsList || []}
            onlineVps={onlineVps}
            canWrite={user?.role === "admin"}
          />
        </TabsContent>
        <TabsContent value="torblock" className="pt-4">
          <TabTorBlock onlineVps={allOnlineVps} canWrite={canWrite} />
        </TabsContent>
      </Tabs>
```

- [ ] **Step 4: Aggiorna il banner della whitelist**

Trova (circa righe 552-558):
```tsx
      <Card className="border-blue-500/20 bg-blue-500/5">
        <CardContent className="pt-4">
          <p className="text-sm text-muted-foreground">
            Il set si aggiorna automaticamente entro pochi secondi grazie al watcher inotify. Aggiungi CIDR (es. <code className="font-mono text-xs bg-muted px-1 rounded">1.2.3.0/24</code>) o domini.
          </p>
        </CardContent>
      </Card>
```

Sostituiscilo con:
```tsx
      <Card className="border-blue-500/20 bg-blue-500/5">
        <CardContent className="pt-4">
          <p className="text-sm text-muted-foreground">
            Il set si aggiorna automaticamente entro pochi secondi grazie al watcher inotify. Aggiungi CIDR (es. <code className="font-mono text-xs bg-muted px-1 rounded">1.2.3.0/24</code>) o domini. Questa whitelist protegge anche il Tor Exit-Node Block (tab "Tor Exit").
          </p>
        </CardContent>
      </Card>
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p . 2>&1 | head -50`
Expected: nessun errore

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/asn-block.tsx
git commit -m "feat: tab Tor Exit nella pagina ASN Block"
```

---

### Task 9: Verifica build completa e push

**Files:** nessuno (solo verifica)

**Interfaces:**
- Consumes: tutti i task precedenti
- Produces: nessuna

- [ ] **Step 1: Build frontend+backend**

Run: `npm run build 2>&1 | tail -30`
Expected: build completata senza errori

- [ ] **Step 2: Verifica finale bundle agent già committato**

Run: `git log --oneline -1 -- agent/agent-bundle.js`
Expected: mostra il commit del Task 4 (bundle già aggiornato e committato, non serve ripetere)

- [ ] **Step 3: Riepilogo commit**

Run: `git log --oneline main -8`
Expected: mostra tutti i commit dei Task 1-8 in ordine

---

### Task 10: Rollout fleet-wide (canary poi tutti i 54 VPS incluso DynamoXc)

**Files:** nessuno (operazione remota via SSH, nessun file di repo — script rollout è usa-e-getta, non versionato)

**Interfaces:**
- Consumes: `scripts/tor-to-ipset.py`, `scripts/update-tor-block.sh` (Task 1, 2), unit systemd generate dalle costanti (Task 5), `data/vps.json` sul dashboard (host NetBird per ogni VPS)
- Produces: stato live della fleet — nessuna interfaccia di codice

Questa fase va eseguita **solo dopo che i Task 1-9 sono stati mergiati e deployati sul dashboard** (`185.229.236.50:/root/proxy-dashboard`, hot deploy: copia file cambiati poi `npm run build && pm2 restart proxy-dashboard`), perché il rollout deve installare gli stessi identici file di `scripts/` presenti nel repo.

- [ ] **Step 1: Prepara lo script di rollout sul dashboard**

Dal dashboard (`185.229.236.50`), con il repo già aggiornato in `/root/proxy-dashboard`, scrivi `/root/rollout-tor-block.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

REPO_DIR="/root/proxy-dashboard"
LOG="/root/rollout-tor-block.log"
: > "$LOG"

install_one() {
  local host="$1" name="$2"
  echo "=== $name ($host) ===" | tee -a "$LOG"
  ssh -o ConnectTimeout=8 -o StrictHostKeyChecking=no "root@$host" bash -s <<'REMOTE' >>"$LOG" 2>&1
set -e
[ -f /etc/asn-whitelist-nets.txt ] || touch /etc/asn-whitelist-nets.txt
touch /etc/ipset.conf /var/log/update-tor-block.log
REMOTE
  scp -o ConnectTimeout=8 -o StrictHostKeyChecking=no \
    "$REPO_DIR/scripts/tor-to-ipset.py" "root@$host:/usr/local/bin/tor-to-ipset.py" >>"$LOG" 2>&1
  scp -o ConnectTimeout=8 -o StrictHostKeyChecking=no \
    "$REPO_DIR/scripts/update-tor-block.sh" "root@$host:/usr/local/bin/update-tor-block.sh" >>"$LOG" 2>&1
  scp -o ConnectTimeout=8 -o StrictHostKeyChecking=no \
    "$REPO_DIR/scripts/whitelist-watcher.sh" "root@$host:/usr/local/bin/whitelist-watcher.sh" >>"$LOG" 2>&1
  ssh -o ConnectTimeout=8 -o StrictHostKeyChecking=no "root@$host" bash -s <<'REMOTE' >>"$LOG" 2>&1
set -e
chmod 755 /usr/local/bin/tor-to-ipset.py /usr/local/bin/update-tor-block.sh /usr/local/bin/whitelist-watcher.sh

grep -q 'update-tor-block.sh' /etc/sudoers.d/proxy-guardian-agent 2>/dev/null || \
  echo 'pgagent ALL=(ALL) NOPASSWD: /usr/local/bin/update-tor-block.sh' >> /etc/sudoers.d/proxy-guardian-agent
visudo -c

if [ ! -f /etc/systemd/system/ipset-restore.service ]; then
  cat > /etc/systemd/system/ipset-restore.service << 'EOF'
[Unit]
Description=Restore ipset rules
Before=network-pre.target iptables-restore.service netfilter-persistent.service
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'if [ -s /etc/ipset.conf ]; then /sbin/ipset restore -exist -file /etc/ipset.conf; else echo "ipset-restore: /etc/ipset.conf non trovato o vuoto, skip."; fi'
RemainAfterExit=yes
SuccessExitStatus=0

[Install]
WantedBy=multi-user.target
EOF
  systemctl enable ipset-restore >/dev/null 2>&1 || true
  systemctl start ipset-restore >/dev/null 2>&1 || true
fi

cat > /etc/systemd/system/tor-block-update.service << 'EOF'
[Unit]
Description=Aggiorna ipset tor_exit dalla lista Tor Project exit-node
After=network-online.target ipset-restore.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/update-tor-block.sh
EOF

cat > /etc/systemd/system/tor-block-update.timer << 'EOF'
[Unit]
Description=Timer orario refresh Tor exit-node block

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
EOF

ipset create tor_exit hash:ip family inet maxelem 65536 -exist
iptables -C INPUT -m set --match-set tor_exit src -m limit --limit 10/min --limit-burst 20 -j LOG --log-prefix "[TOR-BLOCK] " --log-level 4 2>/dev/null || \
  iptables -A INPUT -m set --match-set tor_exit src -m limit --limit 10/min --limit-burst 20 -j LOG --log-prefix "[TOR-BLOCK] " --log-level 4
iptables -C INPUT -m set --match-set tor_exit src -j DROP 2>/dev/null || \
  iptables -A INPUT -m set --match-set tor_exit src -j DROP
iptables-save > /etc/iptables/rules.v4 2>/dev/null || true

systemctl daemon-reload
systemctl enable tor-block-update.timer >/dev/null 2>&1
systemctl start tor-block-update.timer
/usr/local/bin/update-tor-block.sh
ipset save > /etc/ipset.conf
echo "COUNT=$(ipset list tor_exit | grep -cE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')"
REMOTE
  echo "--- fine $name ---" | tee -a "$LOG"
}

if [ "${1:-}" = "--canary" ]; then
  install_one "100.116.212.143" "project.net (canary)"
  exit 0
fi

python3 - <<'PYEOF' | while IFS=$'\t' read -r host name; do
import json
with open("/root/proxy-dashboard/data/vps.json") as f:
    for v in json.load(f):
        if v.get("enabled"):
            print(f"{v['host']}\t{v['name']}")
PYEOF
  install_one "$host" "$name"
done
```

- [ ] **Step 2: Deploya il bundle agent aggiornato su tutta la fleet PRIMA del canary**

I nuovi endpoint `/api/tor-block/status` e `/api/tor-block/refresh` (Task 4) vivono nel bundle `agent/agent-bundle.js`, che gli agent già in esecuzione sulla fleet NON hanno finché non vengono aggiornati esplicitamente. Senza questo step, dopo il rollout il tab dashboard "Tor Exit" mostrerebbe "Errore" su tutti i 54 VPS e "Forza refresh ora" fallirebbe sempre con 404, anche se l'enforcement iptables/ipset funziona correttamente.

Dal dashboard di produzione (via UI, o via API con sessione admin): `POST /api/vps/bulk/agent/update` (endpoint già esistente in `server/routes.ts:634`, aggiorna `agent-bundle.js` su tutti i VPS enabled).

Verifica: `curl -s -X POST http://185.229.236.50:5000/api/vps/bulk/agent/update -H "Cookie: <sessione-admin>" | python3 -c "import json,sys; r=json.load(sys.stdin); print(sum(1 for x in r if x['success']), '/', len(r))"`
Expected: conteggio vicino a 54/54 (host offline attesi falliscono, non bloccante)

- [ ] **Step 3: Esegui il canary**

Run (sul dashboard): `chmod +x /root/rollout-tor-block.sh && /root/rollout-tor-block.sh --canary`
Expected: nel log, `COUNT=` con un numero > 1000 (la torbulkexitlist ha tipicamente 1500-2000 entry), nessun `ERRORE` nell'output

- [ ] **Step 4: Verifica canary in dettaglio (stato, drop reale, reboot)**

Run (sul dashboard): `ssh root@100.116.212.143 "systemctl is-active tor-block-update.timer; ipset list tor_exit | grep -cE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; iptables -L INPUT -n | grep TOR-BLOCK"`
Expected: `active`, un conteggio > 1000, e le due righe iptables (LOG e DROP) presenti

Verifica che la whitelist non venga svuotata dal blocco (nessun IP NetBird/dashboard/backend nel set):
Run: `ssh root@100.116.212.143 "ipset test tor_exit 100.116.132.180 2>&1 || true"`
Expected: `100.116.132.180 is NOT in set tor_exit` (l'IP del LAPI/dashboard non deve mai finire bloccato)

Verifica il drop reale (non solo che la regola esista) prendendo un IP a caso dalla lista appena scaricata e controllando che iptables lo intercetti in modalità dry-run tramite il contatore pacchetti della regola DROP, prima e dopo un probe:
Run: `ssh root@100.116.212.143 "IP=\$(ipset list tor_exit | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\$' | head -1); iptables -L INPUT -n -v --line-numbers | grep 'TOR-BLOCK\|tor_exit'; echo \"IP di test: \$IP\"; ipset test tor_exit \$IP"`
Expected: l'IP scelto risulta `IS in set tor_exit`, confermando che il matching ipset→iptables è coerente (il conteggio pacchetti sulla regola DROP salirà naturalmente nel tempo se quell'IP genera traffico reale verso il VPS — non forziamo un probe attivo da rete esterna in questa verifica)

Verifica la persistenza al reboot (il gap più a rischio per una fleet con storia di problemi al boot — vedi memoria NetBird boot-loop):
Run: `ssh root@100.116.212.143 "reboot"` — attendi ~60s, poi:
Run: `ssh -o ConnectTimeout=10 root@100.116.212.143 "systemctl is-active tor-block-update.timer; ipset list tor_exit | grep -cE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\$'; iptables -L INPUT -n | grep TOR-BLOCK"`
Expected: timer `active`, stesso conteggio IP di prima del reboot (ripristinato da `ipset-restore.service`), entrambe le regole iptables presenti — se una di queste manca, FERMATI e non procedere al rollout fleet-wide finché non è risolto

- [ ] **Step 5: Rollout su tutta la fleet**

Run (sul dashboard, in background — 54 host, può richiedere diversi minuti): `nohup /root/rollout-tor-block.sh > /root/rollout-tor-block-full.out 2>&1 < /dev/null & disown`

Poi monitora: `tail -f /root/rollout-tor-block-full.out` (o rileggi periodicamente `/root/rollout-tor-block.log`)

- [ ] **Step 6: Verifica finale fleet-wide (enforcement + bundle agent)**

Run (sul dashboard, dopo che il rollout è terminato): script che itera `data/vps.json` e per ognuno fa `ssh root@<host> "systemctl is-active tor-block-update.timer"`, conta quanti sono `active`.
Expected: 54/54 (o riporta esplicitamente quali host sono falliti, per intervento manuale — nessun rollback distruttivo necessario dato che l'installazione non tocca configurazione esistente, solo aggiunge)

Verifica anche lato dashboard che il tab "Tor Exit" (Task 8) mostri stato "Attivo" per i VPS appena aggiornati, non "Errore" — conferma che lo Step 2 (bundle agent) ha effettivamente propagato i nuovi endpoint prima che servissero.

---

### Task 11: Smoke test Deploy VPS per i nuovi deploy

**Files:** nessuno (verifica manuale)

**Interfaces:**
- Consumes: Task 6, 7 (script di deploy con `installTorBlock`)
- Produces: nessuna

- [ ] **Step 1: Genera uno script di deploy reale dalla UI**

Nel dashboard di produzione, vai su "Deploy VPS", lascia la checkbox "Installa Tor Block" spuntata (default true), genera lo script per un nome VPS di prova, e verifica visivamente che lo script generato contenga la sezione `# ── TOR EXIT BLOCK ──` con il contenuto di `tor-to-ipset.py` e `update-tor-block.sh` embedded.

Expected: sezione presente, nessun placeholder `${...}` non risolto nello script scaricato (indicherebbe una variabile non interpolata correttamente)

- [ ] **Step 2: Conferma con l'utente prima di deployare su un VPS reale**

Questo step non installa nulla — il prossimo deploy reale di un nuovo VPS (quando servirà) validerà il path end-to-end. Non serve un VPS dedicato solo per questo test.
