# Fix ESTABLISHED fleet-wide + Tor Exit Block Centralizzato — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ripristinare la regola `ACCEPT RELATED,ESTABLISHED` generica persa su 39 VPS (Fase 1), poi centralizzare il Tor exit block sulla dashboard lasciando ai VPS solo l'enforcement (Fase 2).

**Architecture:** Fase 1 riallinea la catena INPUT live a `/etc/iptables/rules.v4` (che contiene già la regola corretta su 52/52 VPS) e aggiunge un meccanismo di ri-asserzione periodica guidato dalla dashboard, perché la regola viene rimossa a runtime da causa ignota. Fase 2 sposta fetch/validazione/filtro/scheduling della lista Tor dai 54 VPS alla dashboard, che pusha la lista via agent; sui VPS restano solo ipset + 2 regole iptables, posizionate con un'ancora relativa alla regola ESTABLISHED ripristinata in Fase 1.

**Tech Stack:** Express + TypeScript (dashboard e agent), React + TanStack Query (UI), `node:test` via `npx tsx --test` (nessuna nuova dipendenza), Python 3 stdlib per gli script di rollout operativo.

**Spec di riferimento:** `docs/superpowers/specs/2026-08-04-tor-block-centralizzato-design.md`

## Global Constraints

- `agent/index.ts` compila con `esbuild --target=node12`: **vietati `??` e `?.`** — usare `||` e `&&`.
- Ogni modifica ad `agent/index.ts` richiede `cd agent && npm run build` e **commit del bundle** `agent/agent-bundle.js`, altrimenti i nuovi deploy scaricano un agent vecchio.
- **Mai `sudo sh -c '...'`**: `pgagent` non ha `/bin/sh` nei sudoers (verificato live: `sudo: a password is required`). Per scrivere file da root usare il pattern `runCmd("sudo <cmd>")` → `sudoWriteFile(path, stdout)`, che usa `sudo tee` (già in sudoers per `/etc/ipset.conf` e `/etc/iptables/rules.v4`).
- **Mai `iptables -F`**, mai una chain con verdetto `DROP`/`REJECT` non condizionato, mai inserimento cieco senza verifica di posizione.
- **`iptables -nL` NON mostra la colonna interfaccia**: per qualsiasi parsing usare sempre `iptables -nvL` e leggere il campo `in`. Una regola `-i wt0` è scoped a NetBird e non vale come regola generica.
- `data/vps.json` in produzione è la source of truth: **mai copiare la versione locale sul server**.
- Repo di produzione (`185.229.236.50:/root/proxy-dashboard`) può divergere da GitHub: `git status` e `git log` prima di ogni deploy, mai `git pull` alla cieca.
- Commit message: prefisso `feat:` / `fix:` / `chore:` + descrizione breve in italiano.

---

# FASE 1 — Ripristino regola ESTABLISHED (39 VPS)

**Perché:** rilevazione live 2026-08-04 — 39 VPS su 52 raggiungibili hanno perso dalla catena INPUT la regola `ACCEPT -m state --state RELATED,ESTABLISHED` generica. È salvata correttamente in `/etc/iptables/rules.v4` su 52/52. Conseguenza verificata: su Smarters (senza regola) `curl https://packagecloud.io` va in TIMEOUT, su dragon (con regola) risponde `200` in 0.97s — il SYN-ACK di ritorno viene droppato da `blocked_asn`, che ha 138.000–203.000 entry.

**Rischio:** basso. Si inserisce un `ACCEPT` (allarga il traffico permesso, non lo restringe) identico a quello già presente in `rules.v4` e già attivo su 13 VPS senza problemi.

### Task 1: Endpoint agent per garantire la regola ESTABLISHED

**Files:**
- Create: `agent/iptables-input.ts`
- Modify: `agent/index.ts` (import + nuovo endpoint, dopo la sezione `─── IPTables ───` a riga ~587)
- Test: `agent/iptables-input.test.ts`

**Interfaces:**
- Produces:
  - `parseInputChain(nvlOutput: string): InputRule[]`
  - `interface InputRule { num: number; pkts: string; target: string; iface: string; raw: string }`
  - `findGenericEstablished(rules: InputRule[]): number | null`
  - `findTorRules(rules: InputRule[]): { log: number | null; drop: number | null }`
  - `findFirstAccept8880(rules: InputRule[]): number | null`
  - `planTorRules(rules: InputRule[]): TorRulePlan` (usata da Task 7)
  - `interface TorRulePlan { action: "noop" | "insert" | "reposition" | "refuse"; reason?: string; anchor?: number; insertAt?: number }`

- [ ] **Step 1: Scrivi i test (falliranno)**

Crea `agent/iptables-input.test.ts`. Le fixture sono output reali catturati dalla fleet il 2026-08-04.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInputChain, findGenericEstablished, findFirstAccept8880, findTorRules, planTorRules } from "./iptables-input";

// dragon (100.116.113.227): ESTABLISHED generica a 9, wt0 a 15, ACCEPT 8880 a 18, DROP wt0 a 19
const DRAGON = `Chain INPUT (policy ACCEPT 1275 packets, 83247 bytes)
num   pkts bytes target     prot opt in     out     source               destination         
1     183K   10M f2b-xtream  tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            multiport dports 8880,8000,2096
7    1985K 2037M ANTI_IPTV  all  --  *      *       0.0.0.0/0            0.0.0.0/0           
8     641K  962M NETBIRD-ACL-INPUT  all  --  wt0    *       0.0.0.0/0            0.0.0.0/0           
9    1810K 2025M ACCEPT     all  --  *      *       0.0.0.0/0            0.0.0.0/0            state RELATED,ESTABLISHED
15       0     0 ACCEPT     all  --  wt0    *       0.0.0.0/0            0.0.0.0/0            ctstate RELATED,ESTABLISHED
16    8809  457K LOG        all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set blocked_asn src limit: avg 10/min burst 20 LOG flags 0 level 4 prefix "[ASN-BLOCK] "
17   27906 1446K DROP       all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set blocked_asn src
18    5941  361K ACCEPT     tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            tcp dpt:8880
19       0     0 DROP       all  --  wt0    *       0.0.0.0/0            0.0.0.0/0`;

// Smarters (100.116.14.174): SOLO ESTABLISHED wt0 a 6 — nessuna generica
const SMARTERS = `Chain INPUT (policy ACCEPT 119K packets, 129M bytes)
num   pkts bytes target     prot opt in     out     source               destination         
5    60418 3843K f2b-sshd   tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            multiport dports 22
6      15M   19G ACCEPT     all  --  wt0    *       0.0.0.0/0            0.0.0.0/0            ctstate RELATED,ESTABLISHED
7    15674  940K NETBIRD-ACL-INPUT  all  --  wt0    *       0.0.0.0/0            0.0.0.0/0           
8       23   932 DROP       all  --  wt0    *       0.0.0.0/0            0.0.0.0/0           
11    474K   25M DROP       all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set blocked_asn src
12   5067K  342M ACCEPT     tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            tcp dpt:8880`;

test("parseInputChain salta le 2 righe di intestazione e legge num/target/iface", () => {
  const r = parseInputChain(DRAGON);
  assert.equal(r[0].num, 1);
  assert.equal(r[0].target, "f2b-xtream");
  assert.equal(r[0].iface, "*");
  const wt0 = r.find(x => x.num === 8);
  assert.equal(wt0!.iface, "wt0");
});

test("findGenericEstablished ignora le regole scoped a wt0", () => {
  assert.equal(findGenericEstablished(parseInputChain(DRAGON)), 9);
  assert.equal(findGenericEstablished(parseInputChain(SMARTERS)), null);
});

test("findFirstAccept8880 trova la ACCEPT sulla porta proxy", () => {
  assert.equal(findFirstAccept8880(parseInputChain(DRAGON)), 18);
  assert.equal(findFirstAccept8880(parseInputChain(SMARTERS)), 12);
});

test("findTorRules su catena senza regole Tor ritorna null", () => {
  assert.deepEqual(findTorRules(parseInputChain(DRAGON)), { log: null, drop: null });
});

test("planTorRules rifiuta se manca la ESTABLISHED generica", () => {
  const p = planTorRules(parseInputChain(SMARTERS));
  assert.equal(p.action, "refuse");
  assert.match(p.reason!, /RELATED,ESTABLISHED/);
});

test("planTorRules su dragon inserisce subito dopo l'ancora generica", () => {
  const p = planTorRules(parseInputChain(DRAGON));
  assert.equal(p.action, "insert");
  assert.equal(p.anchor, 9);
  assert.equal(p.insertAt, 10);
});

test("planTorRules rifiuta se ACCEPT 8880 sta sopra l'ancora", () => {
  const chain = `Chain INPUT (policy ACCEPT)
num   pkts bytes target     prot opt in     out     source               destination         
1        0     0 ACCEPT     tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            tcp dpt:8880
2        0     0 ACCEPT     all  --  *      *       0.0.0.0/0            0.0.0.0/0            state RELATED,ESTABLISHED`;
  const p = planTorRules(parseInputChain(chain));
  assert.equal(p.action, "refuse");
  assert.match(p.reason!, /8880/);
});

test("planTorRules e' noop se le regole Tor sono gia' nella finestra corretta", () => {
  const chain = `Chain INPUT (policy ACCEPT)
num   pkts bytes target     prot opt in     out     source               destination         
1        0     0 ACCEPT     all  --  *      *       0.0.0.0/0            0.0.0.0/0            state RELATED,ESTABLISHED
2        0     0 LOG        all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set tor_exit src limit: avg 10/min burst 20 LOG flags 0 level 4 prefix "[TOR-BLOCK] "
3        0     0 DROP       all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set tor_exit src
4        0     0 ACCEPT     tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            tcp dpt:8880`;
  assert.equal(planTorRules(parseInputChain(chain)).action, "noop");
});

test("planTorRules riposiziona se le regole Tor stanno sotto l'ACCEPT 8880", () => {
  const chain = `Chain INPUT (policy ACCEPT)
num   pkts bytes target     prot opt in     out     source               destination         
1        0     0 ACCEPT     all  --  *      *       0.0.0.0/0            0.0.0.0/0            state RELATED,ESTABLISHED
2        0     0 ACCEPT     tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            tcp dpt:8880
3        0     0 LOG        all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set tor_exit src limit: avg 10/min burst 20 LOG flags 0 level 4 prefix "[TOR-BLOCK] "
4        0     0 DROP       all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set tor_exit src`;
  assert.equal(planTorRules(parseInputChain(chain)).action, "reposition");
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npx tsx --test agent/iptables-input.test.ts`
Expected: FAIL — `Cannot find module './iptables-input'`

- [ ] **Step 3: Implementa il modulo**

Crea `agent/iptables-input.ts`. Niente `??` / `?.` (bundle node12).

```ts
// Parsing e pianificazione delle regole della chain INPUT.
// Funzioni pure: nessuna esecuzione di comandi, testabili in isolamento.
//
// IMPORTANTE: l'input deve venire da `iptables -nvL INPUT --line-numbers`.
// `iptables -nL` NON stampa la colonna interfaccia, quindi una regola scoped
// a `-i wt0` (gestita da NetBird) sarebbe indistinguibile da una generica.

export interface InputRule {
  num: number;
  target: string;
  iface: string;
  raw: string;
}

export interface TorRulePlan {
  action: "noop" | "insert" | "reposition" | "refuse";
  reason?: string;
  anchor?: number;
  insertAt?: number;
}

export function parseInputChain(nvlOutput: string): InputRule[] {
  var lines = nvlOutput.split("\n").slice(2);
  var out: InputRule[] = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var f = line.trim().split(/\s+/);
    // num pkts bytes target prot opt in out source destination [extra...]
    if (f.length < 10) continue;
    var num = parseInt(f[0], 10);
    if (isNaN(num)) continue;
    out.push({ num: num, target: f[3], iface: f[6], raw: line });
  }
  return out;
}

function isEstablishedAccept(r: InputRule): boolean {
  return r.target === "ACCEPT" && r.raw.indexOf("RELATED,ESTABLISHED") !== -1;
}

// Solo le regole con interfaccia `*` valgono come ancora: una `-i wt0` copre
// esclusivamente il traffico della mesh NetBird, non quello pubblico.
export function findGenericEstablished(rules: InputRule[]): number | null {
  var found: number | null = null;
  for (var i = 0; i < rules.length; i++) {
    if (isEstablishedAccept(rules[i]) && rules[i].iface === "*") found = rules[i].num;
  }
  return found;
}

export function findFirstAccept8880(rules: InputRule[]): number | null {
  for (var i = 0; i < rules.length; i++) {
    if (rules[i].target === "ACCEPT" && rules[i].raw.indexOf("dpt:8880") !== -1) return rules[i].num;
  }
  return null;
}

export function findTorRules(rules: InputRule[]): { log: number | null; drop: number | null } {
  var log: number | null = null;
  var drop: number | null = null;
  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    if (r.raw.indexOf("match-set tor_exit src") === -1) continue;
    if (r.target === "LOG" && log === null) log = r.num;
    if (r.target === "DROP" && drop === null) drop = r.num;
  }
  return { log: log, drop: drop };
}

export function planTorRules(rules: InputRule[]): TorRulePlan {
  var anchor = findGenericEstablished(rules);
  if (anchor === null) {
    return {
      action: "refuse",
      reason: "nessuna regola ACCEPT ... RELATED,ESTABLISHED generica (in=*) nella chain INPUT: " +
              "inserire un DROP senza quell'ACCEPT sopra troncherebbe le connessioni gia' stabilite " +
              "e il traffico di ritorno in uscita",
    };
  }

  var accept8880 = findFirstAccept8880(rules);
  if (accept8880 !== null && accept8880 < anchor) {
    return {
      action: "refuse",
      reason: "ACCEPT tcp dpt:8880 in posizione " + accept8880 + ", sopra l'ancora ESTABLISHED (" + anchor +
              "): le regole Tor finirebbero sotto e il traffico verso la porta proxy sarebbe gia' accettato",
    };
  }

  var tor = findTorRules(rules);
  var insertAt = anchor + 1;

  if (tor.log !== null && tor.drop !== null) {
    var ordered = tor.log > anchor && tor.drop > tor.log;
    var beforeProxy = accept8880 === null || tor.drop < accept8880;
    if (ordered && beforeProxy) return { action: "noop", anchor: anchor, insertAt: insertAt };
    return { action: "reposition", anchor: anchor, insertAt: insertAt };
  }

  if (tor.log !== null || tor.drop !== null) {
    // Solo una delle due presenti: stato incoerente, si ricostruisce da zero.
    return { action: "reposition", anchor: anchor, insertAt: insertAt };
  }

  return { action: "insert", anchor: anchor, insertAt: insertAt };
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npx tsx --test agent/iptables-input.test.ts`
Expected: PASS, 9 test

- [ ] **Step 5: Aggiungi lo script `test` a package.json**

In `package.json`, dentro `"scripts"`, aggiungi dopo `"check": "tsc"`:

```json
    "test": "tsx --test agent/*.test.ts server/*.test.ts"
```

- [ ] **Step 6: Aggiungi l'endpoint agent che garantisce la regola ESTABLISHED**

In `agent/index.ts`, aggiungi l'import in cima al file (dopo gli altri import, riga ~6):

```ts
import { parseInputChain, findGenericEstablished, findTorRules, planTorRules } from "./iptables-input";
```

Poi, nella sezione `─── IPTables ───` (dopo `app.get("/api/iptables", ...)`, riga ~589), aggiungi:

```ts
// Ri-asserisce la regola ACCEPT RELATED,ESTABLISHED generica in cima alla chain INPUT.
// Rilevazione 2026-08-04: persa a runtime su 39 VPS su 52 (causa non identificata), pur
// essendo salvata correttamente in /etc/iptables/rules.v4 su 52/52. Senza di lei il
// SYN-ACK di ritorno delle connessioni in uscita viene droppato da blocked_asn
// (138K-203K entry) — curl/apt/cscli verso host su cloud provider bloccati vanno in timeout.
async function ensureEstablishedRule(): Promise<{ changed: boolean; position: number | null; error?: string }> {
  var listed = await runCmd("sudo iptables -nvL INPUT --line-numbers");
  if (!listed.ok) return { changed: false, position: null, error: listed.stderr };

  var existing = findGenericEstablished(parseInputChain(listed.stdout));
  if (existing !== null) return { changed: false, position: existing };

  var ins = await runCmd("sudo iptables -I INPUT 1 -m state --state RELATED,ESTABLISHED -j ACCEPT");
  if (!ins.ok) return { changed: false, position: null, error: ins.stderr };

  var check = await runCmd("sudo iptables -C INPUT -m state --state RELATED,ESTABLISHED -j ACCEPT");
  if (!check.ok) return { changed: false, position: null, error: "regola inserita ma -C non la trova" };

  var relisted = await runCmd("sudo iptables -nvL INPUT --line-numbers");
  var pos = relisted.ok ? findGenericEstablished(parseInputChain(relisted.stdout)) : null;
  return { changed: true, position: pos };
}

app.post("/api/firewall/ensure-established", async (_req, res) => {
  try {
    var result = await ensureEstablishedRule();
    if (result.error) return res.status(500).json({ ok: false, error: result.error });
    if (result.changed) {
      // Persiste solo se abbiamo davvero modificato la chain.
      var saved = await runCmd("sudo iptables-save");
      if (saved.ok) await sudoWriteFile("/etc/iptables/rules.v4", saved.stdout + "\n");
    }
    res.json({ ok: true, changed: result.changed, position: result.position });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
```

- [ ] **Step 7: Verifica compilazione e rebuild del bundle**

```bash
cd agent && npx tsc --noEmit index.ts iptables-input.ts --esModuleInterop --skipLibCheck --moduleResolution node --module esnext --target es2020
npm run build
cd .. && npx tsx --test agent/iptables-input.test.ts
```
Expected: nessun errore TS, `agent-bundle.js` rigenerato, test PASS

- [ ] **Step 8: Commit**

```bash
git add agent/iptables-input.ts agent/iptables-input.test.ts agent/index.ts agent/agent-bundle.js package.json
git commit -m "feat: endpoint agent per ri-asserire la regola ESTABLISHED generica in INPUT"
```

---

### Task 2: Route fleet + poller di ri-asserzione sulla dashboard

**Files:**
- Modify: `server/routes.ts` (nuova route vicino alle altre `/api/fleet/*`, ~riga 731; avvio poller a ~riga 2934)
- Modify: `server/vps-manager.ts` (nuova funzione esportata, dopo `startBanSyncPoller` ~riga 305)

**Interfaces:**
- Consumes: `POST /api/firewall/ensure-established` (Task 1)
- Produces:
  - `ensureEstablishedFleet(): Promise<EstablishedSyncResult>` da `server/vps-manager.ts`
  - `interface EstablishedSyncResult { checked: number; fixed: number; errors: number; details: Array<{ vpsId: string; vpsName: string; changed: boolean; position: number | null; error?: string }> }`
  - `startEstablishedPoller(intervalMs?: number): void`
  - `GET /api/fleet/firewall/established-status`, `POST /api/fleet/firewall/ensure-established`

- [ ] **Step 1: Aggiungi la funzione fleet in `server/vps-manager.ts`**

Dopo `startBanSyncPoller` (~riga 305), prima di `export interface BulkResult`:

```ts
export interface EstablishedSyncResult {
  checked: number;
  fixed: number;
  errors: number;
  details: Array<{ vpsId: string; vpsName: string; changed: boolean; position: number | null; error?: string }>;
}

// Ri-asserisce su tutta la fleet la regola ACCEPT RELATED,ESTABLISHED generica.
// Non e' un fix una tantum: la regola viene rimossa a runtime da causa non identificata
// (39 VPS su 52 la avevano persa il 2026-08-04 pur avendola salvata in rules.v4).
export async function ensureEstablishedFleet(): Promise<EstablishedSyncResult> {
  const enabled = Array.from(vpsStore.values()).filter(v => v.enabled && v.lastStatus !== "offline");
  const details: EstablishedSyncResult["details"] = [];
  let fixed = 0;
  let errors = 0;

  await Promise.allSettled(enabled.map(async vps => {
    try {
      const r = await agentPost(vps, "/api/firewall/ensure-established", {}, 20000);
      if (r && r.changed) fixed++;
      details.push({ vpsId: vps.id, vpsName: vps.name, changed: !!(r && r.changed), position: r ? r.position : null });
    } catch (e: any) {
      errors++;
      details.push({ vpsId: vps.id, vpsName: vps.name, changed: false, position: null, error: e.message });
    }
  }));

  return { checked: enabled.length, fixed, errors, details };
}

export function startEstablishedPoller(intervalMs = 3600000): void {
  const run = () => ensureEstablishedFleet()
    .then(r => {
      if (r.fixed > 0 || r.errors > 0) {
        console.log(`[Established] controllati ${r.checked}, ripristinati ${r.fixed}, errori ${r.errors}`);
      }
    })
    .catch(e => console.error("[Established] error:", e));
  setTimeout(() => { run(); setInterval(run, intervalMs); }, 45000);
}
```

- [ ] **Step 2: Registra le route in `server/routes.ts`**

Aggiungi `ensureEstablishedFleet, startEstablishedPoller` all'import da `./vps-manager` (riga 12). Poi, vicino alle altre route `/api/fleet/*` (~riga 731):

```ts
  app.get("/api/fleet/firewall/established-status", requireAuth, async (_req, res) => {
    const results = await bulkGet("all", "/api/iptables");
    res.json(results);
  });

  app.post("/api/fleet/firewall/ensure-established", requireAuth, requireOperator, async (_req, res) => {
    const result = await ensureEstablishedFleet();
    res.json(result);
  });
```

- [ ] **Step 3: Avvia il poller**

In `server/routes.ts` accanto agli altri poller (~riga 2934):

```ts
  startEstablishedPoller(3600000);
```

- [ ] **Step 4: Verifica compilazione**

Run: `npx tsc --noEmit`
Expected: nessun errore

- [ ] **Step 5: Commit**

```bash
git add server/vps-manager.ts server/routes.ts
git commit -m "feat: poller fleet orario che ri-asserisce la regola ESTABLISHED generica"
```

---

### Task 3: Rollout Fase 1 in produzione (canary → scaglioni)

**Files:** nessuna modifica al repo — task operativo.

**Interfaces:**
- Consumes: agent bundle di Task 1, route di Task 2

Questo task tocca il firewall di 39 VPS in produzione. Si esegue **a scaglioni con verifica fra uno e l'altro**, mai in blocco (lezione dall'incidente syn-flood del 2026-07-04).

- [ ] **Step 1: Deploy dashboard + bundle agent in produzione**

```bash
ssh root@185.229.236.50
cd /root/proxy-dashboard
git status && git log --oneline -3   # verifica divergenza PRIMA di toccare
```

Se il working tree è pulito e allineato: `git pull`. Se diverge, riportare la divergenza e fermarsi.

```bash
npm run build && pm2 restart proxy-dashboard
```

- [ ] **Step 2: Aggiorna l'agent sul canary (Smarters, 100.116.14.174)**

Smarters è il canary ideale: senza regola, uptime 42 giorni, sintomo riproducibile.

Dalla UI dashboard (Fleet Config → aggiorna agent) oppure via API, aggiorna **solo** Smarters.

- [ ] **Step 3: Cattura lo stato PRIMA**

```bash
ssh -i ~/.ssh/id_ed25519 root@100.116.14.174 'iptables -nvL INPUT --line-numbers > /tmp/before.txt; cat /tmp/before.txt; echo "--- curl test ---"; timeout 12 curl -s -o /dev/null -w "%{http_code}\n" https://packagecloud.io || echo TIMEOUT'
```
Expected: nessuna riga `ACCEPT ... * ... RELATED,ESTABLISHED`, curl → `TIMEOUT`

- [ ] **Step 4: Applica la regola sul solo canary**

L'API key di Smarters si legge dal `vps.json` di **produzione** (source of truth, mai quello locale):

```bash
ssh root@185.229.236.50 "python3 -c \"import json;print([v['apiKey'] for v in json.load(open('/root/proxy-dashboard/data/vps.json')) if v['host']=='100.116.14.174'][0])\""
```

```bash
curl -s -X POST -H "x-api-key: <API_KEY_SMARTERS>" http://100.116.14.174:3001/api/firewall/ensure-established
```
Expected: `{"ok":true,"changed":true,"position":1}`

- [ ] **Step 5: Verifica il canary**

```bash
ssh -i ~/.ssh/id_ed25519 root@100.116.14.174 '
  echo "--- regola ---"; iptables -nvL INPUT --line-numbers | head -3
  echo "--- curl ---"; timeout 12 curl -s -o /dev/null -w "%{http_code} in %{time_total}s\n" https://packagecloud.io || echo TIMEOUT
  echo "--- persistita ---"; grep -cE "^-A INPUT -m state --state RELATED,ESTABLISHED -j ACCEPT" /etc/iptables/rules.v4
  echo "--- netbird ---"; netbird status | grep -E "Management|Signal"
  echo "--- nginx ---"; systemctl is-active nginx'
```
Expected: regola in posizione 1, curl `200`, persistita `1`, NetBird `Connected`, nginx `active`

- [ ] **Step 6: Verifica che il traffico client non sia cambiato in peggio**

```bash
ssh -i ~/.ssh/id_ed25519 root@100.116.14.174 'ss -tn state established "( sport = :8880 )" | wc -l'
```
Confrontare con il valore di Step 3. Deve essere stabile o superiore, mai crollato a zero.

**Se una qualunque verifica fallisce, fermarsi e fare rollback:**
```bash
ssh -i ~/.ssh/id_ed25519 root@100.116.14.174 'iptables -D INPUT -m state --state RELATED,ESTABLISHED -j ACCEPT && iptables-save > /etc/iptables/rules.v4'
```

- [ ] **Step 7: Rollout a scaglioni**

Aggiornare l'agent e chiamare l'endpoint su gruppi progressivi, con le verifiche di Step 5 su un campione di ogni scaglione prima di passare al successivo:

1. **Scaglione 1 (5 VPS)**: mugello, akody, skizzo, Lupo, xtreamtv → verifica → attendere 10 minuti
2. **Scaglione 2 (15 VPS)**: gruppo "merc" restanti → verifica
3. **Scaglione 3 (tutti i restanti)** → verifica

Dopo l'ultimo scaglione, il poller orario di Task 2 mantiene la regola da solo.

- [ ] **Step 8: Verifica finale fleet-wide**

Dalla dashboard: `POST /api/fleet/firewall/ensure-established`.
Expected: `fixed: 0` (nessuno da correggere: sono già tutti a posto)

Riesegui lo scan di correlazione per conferma indipendente:
```bash
python3 /tmp/scan2.py
```
Expected: `LIVE=SI, salvata=SI: 52` (o comunque tutti i raggiungibili), `LIVE=NO: 0`

- [ ] **Step 9: Verifica che CrowdSec ora installi senza package cache**

Su un VPS che prima falliva, provare l'installazione diretta da packagecloud. Se funziona, annotarlo: il sistema di package cache del 2026-08-02 era un workaround per questo bug e potrebbe non servire più.

---

# FASE 2 — Tor Exit Block centralizzato

**Precondizione:** Fase 1 completata. Senza la regola ESTABLISHED il `planTorRules` di Task 1 rifiuta, ed è il comportamento voluto.

### Task 4: Filtro e validazione lista Tor (funzioni pure, TDD)

**Files:**
- Create: `server/tor-block-filter.ts`
- Test: `server/tor-block-filter.test.ts`

**Interfaces:**
- Produces:
  - `isValidIpv4(s: string): boolean`
  - `parseTorList(body: string): string[]`
  - `validateTorList(ips: string[], previousCount: number): { ok: boolean; reason?: string }`
  - `parseWhitelist(content: string): { cidrs: string[]; domains: string[] }`
  - `filterTorList(ips: string[], extraWhitelist?: string[]): { ips: string[]; removed: string[] }`
  - `HARD_GUARD_NETS: string[]`

- [ ] **Step 1: Scrivi i test (falliranno)**

Crea `server/tor-block-filter.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidIpv4, parseTorList, validateTorList, parseWhitelist, filterTorList } from "./tor-block-filter";

test("isValidIpv4 accetta indirizzi validi", () => {
  assert.equal(isValidIpv4("8.8.8.8"), true);
  assert.equal(isValidIpv4("255.255.255.255"), true);
});

test("isValidIpv4 rifiuta ottetti fuori range, forme incomplete e zero-padding", () => {
  assert.equal(isValidIpv4("256.1.1.1"), false);
  assert.equal(isValidIpv4("1.2.3"), false);
  assert.equal(isValidIpv4("01.2.3.4"), false);
  assert.equal(isValidIpv4("1.2.3.4.5"), false);
  assert.equal(isValidIpv4(""), false);
});

test("parseTorList scarta commenti, righe vuote e voci non valide", () => {
  const body = "# commento\n\n8.8.8.8\n  1.1.1.1  \nnon-un-ip\n999.1.1.1\n";
  assert.deepEqual(parseTorList(body), ["8.8.8.8", "1.1.1.1"]);
});

test("validateTorList rifiuta liste sotto il minimo", () => {
  const r = validateTorList(["1.1.1.1"], 0);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /minimo/);
});

test("validateTorList rifiuta un crollo oltre il 50% rispetto al conteggio precedente", () => {
  const ips = Array.from({ length: 100 }, (_, i) => `10.0.0.${i}`);
  assert.equal(validateTorList(ips, 300).ok, false);
  assert.equal(validateTorList(ips, 150).ok, true);
});

test("validateTorList accetta la prima lista quando non c'e' un precedente", () => {
  const ips = Array.from({ length: 60 }, (_, i) => `10.0.0.${i}`);
  assert.equal(validateTorList(ips, 0).ok, true);
});

test("parseWhitelist separa prefissi e domini ignorando i commenti", () => {
  const content = "# testata\n85.9.200.0/21   # netbird\ndomain:api.netbird.io # api\ndomain:*.wild.io\n\n1.2.3.4\n";
  const r = parseWhitelist(content);
  assert.deepEqual(r.cidrs, ["85.9.200.0/21", "1.2.3.4"]);
  assert.deepEqual(r.domains, ["api.netbird.io"]);
});

// Il 2026-07-08 l'IP della dashboard e' finito nell'ipset iptv_ban su 52 VPS su 54,
// causando mesi di instabilita' NetBird attribuita ad altro. Questo test e' la rete
// di sicurezza contro la ripetizione dello stesso incidente su tor_exit.
test("filterTorList rimuove SEMPRE la mesh NetBird, la dashboard e il main backend", () => {
  const input = ["100.116.132.180", "100.64.0.1", "100.127.255.254", "185.229.236.50", "80.244.4.35", "8.8.8.8"];
  const r = filterTorList(input);
  assert.deepEqual(r.ips, ["8.8.8.8"]);
  assert.equal(r.removed.length, 5);
});

test("filterTorList non tocca IP appena fuori dal range NetBird", () => {
  const r = filterTorList(["100.63.255.255", "100.128.0.0"]);
  assert.deepEqual(r.ips, ["100.63.255.255", "100.128.0.0"]);
});

test("filterTorList applica anche la whitelist aggiuntiva", () => {
  const r = filterTorList(["1.2.3.4", "9.9.9.9"], ["1.2.3.0/24"]);
  assert.deepEqual(r.ips, ["9.9.9.9"]);
  assert.deepEqual(r.removed, ["1.2.3.4"]);
});

test("filterTorList ignora le voci di whitelist malformate senza esplodere", () => {
  const r = filterTorList(["1.2.3.4"], ["non-un-cidr", "1.2.3.0/99", ""]);
  assert.deepEqual(r.ips, ["1.2.3.4"]);
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npx tsx --test server/tor-block-filter.test.ts`
Expected: FAIL — modulo inesistente

- [ ] **Step 3: Implementa il modulo**

Crea `server/tor-block-filter.ts`:

```ts
// Validazione e filtro della lista Tor exit-node.
// Funzioni pure: nessun I/O, nessuna risoluzione DNS, testabili in isolamento.

const MIN_VALID_IPS = 50;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isValidIpv4(s: string): boolean {
  const m = IPV4_RE.exec(s);
  if (!m) return false;
  return [m[1], m[2], m[3], m[4]].every(o => {
    const n = Number(o);
    return n >= 0 && n <= 255 && String(n) === o;
  });
}

export function parseTorList(body: string): string[] {
  return body
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith("#"))
    .filter(isValidIpv4);
}

export function validateTorList(ips: string[], previousCount: number): { ok: boolean; reason?: string } {
  if (ips.length < MIN_VALID_IPS) {
    return { ok: false, reason: `lista sospetta: ${ips.length} IP validi, minimo ${MIN_VALID_IPS}` };
  }
  if (previousCount > 0 && ips.length < Math.floor(previousCount / 2)) {
    return { ok: false, reason: `lista sospetta: ${ips.length} IP contro ${previousCount} precedenti (calo oltre il 50%)` };
  }
  return { ok: true };
}

export function parseWhitelist(content: string): { cidrs: string[]; domains: string[] } {
  const cidrs: string[] = [];
  const domains: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    if (line.startsWith("domain:")) {
      const d = line.slice("domain:".length).trim();
      if (d && !d.startsWith("*.")) domains.push(d);
    } else {
      cidrs.push(line);
    }
  }
  return { cidrs, domains };
}

interface Cidr { base: number; mask: number; }

function ipToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

function parseCidr(entry: string): Cidr | null {
  const [addr, bitsRaw] = entry.split("/");
  if (!isValidIpv4(addr)) return null;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (ipToInt(addr) & mask) >>> 0, mask };
}

// Reti che non devono MAI finire in tor_exit, a prescindere da cosa dice l'upstream.
// Un exit node Tor non dovrebbe mai essere uno di questi IP, ma il 2026-07-08 l'IP
// della dashboard e' finito nell'ipset iptv_ban su 52 VPS su 54 e ha causato mesi di
// instabilita' NetBird attribuita ad altro: il filtro va messo comunque.
export const HARD_GUARD_NETS = [
  "100.64.0.0/10",      // intera mesh NetBird (dashboard, tutti i VPS, main backend)
  "185.229.236.50/32",  // dashboard, IP pubblico
  "80.244.4.35/32",     // main backend xtreamcodes
];

export function filterTorList(ips: string[], extraWhitelist: string[] = []): { ips: string[]; removed: string[] } {
  const nets = HARD_GUARD_NETS.concat(extraWhitelist)
    .map(parseCidr)
    .filter((c): c is Cidr => c !== null);
  const kept: string[] = [];
  const removed: string[] = [];
  for (const ip of ips) {
    if (nets.some(n => ((ipToInt(ip) & n.mask) >>> 0) === n.base)) removed.push(ip);
    else kept.push(ip);
  }
  return { ips: kept, removed };
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npx tsx --test server/tor-block-filter.test.ts`
Expected: PASS, 12 test

- [ ] **Step 5: Commit**

```bash
git add server/tor-block-filter.ts server/tor-block-filter.test.ts
git commit -m "feat: filtro e validazione lista Tor con guard anti-autoblocco"
```

---

### Task 5: Modulo lista Tor (fetch, persistenza, push)

**Files:**
- Create: `server/tor-block.ts`
- Test: `server/tor-block.test.ts`

**Interfaces:**
- Consumes: Task 4 (`parseTorList`, `validateTorList`, `filterTorList`, `parseWhitelist`), `bulkPost` da `./vps-manager`
- Produces:
  - `refreshTorList(fetcher?: () => Promise<string>): Promise<TorListState>`
  - `getTorListState(): TorListState`
  - `getLastPush(): BulkResult[]`
  - `pushTorListToFleet(vpsIds?: string[] | "all"): Promise<BulkResult[]>`
  - `startTorBlockPoller(intervalMs?: number): void`
  - `__resetTorStateForTest(): void` (solo per i test)
  - `interface TorListState { ips: string[]; count: number; fetchedAt: string | null; lastError: string | null; removedCount: number }`

- [ ] **Step 1: Scrivi i test (falliranno)**

Crea `server/tor-block.test.ts`. Il `fetcher` iniettabile rende testabile la macchina a stati senza rete.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshTorList, getTorListState, __resetTorStateForTest } from "./tor-block";

const manyIps = (n: number, prefix = "10.0") =>
  Array.from({ length: n }, (_, i) => `${prefix}.${Math.floor(i / 256)}.${i % 256}`).join("\n");

test("refreshTorList popola lo stato con una lista valida", async () => {
  __resetTorStateForTest();
  const s = await refreshTorList(async () => manyIps(100));
  assert.equal(s.count, 100);
  assert.equal(s.lastError, null);
  assert.ok(s.fetchedAt);
});

test("refreshTorList tiene l'ultima lista buona se il fetch fallisce", async () => {
  __resetTorStateForTest();
  await refreshTorList(async () => manyIps(100));
  const s = await refreshTorList(async () => { throw new Error("rete giu'"); });
  assert.equal(s.count, 100, "la lista precedente deve restare");
  assert.match(s.lastError!, /rete giu'/);
});

test("refreshTorList tiene l'ultima lista buona se la nuova crolla oltre il 50%", async () => {
  __resetTorStateForTest();
  await refreshTorList(async () => manyIps(300));
  const s = await refreshTorList(async () => manyIps(100));
  assert.equal(s.count, 300);
  assert.match(s.lastError!, /calo oltre il 50%/);
});

test("refreshTorList rimuove gli IP della mesh NetBird e li conta", async () => {
  __resetTorStateForTest();
  const body = manyIps(100) + "\n100.116.132.180\n185.229.236.50\n";
  const s = await refreshTorList(async () => body);
  assert.equal(s.count, 100);
  assert.equal(s.removedCount, 2);
  assert.ok(!s.ips.includes("100.116.132.180"));
});

test("getTorListState ritorna lo stato corrente senza rifare il fetch", async () => {
  __resetTorStateForTest();
  await refreshTorList(async () => manyIps(80));
  assert.equal(getTorListState().count, 80);
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npx tsx --test server/tor-block.test.ts`
Expected: FAIL — modulo inesistente

- [ ] **Step 3: Implementa il modulo**

Crea `server/tor-block.ts`:

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { promises as dns } from "dns";
import { parseTorList, validateTorList, filterTorList, parseWhitelist } from "./tor-block-filter";
import { bulkPost, type BulkResult } from "./vps-manager";

const TORLIST_URL = "https://check.torproject.org/torbulkexitlist";
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const STATE_FILE = join(DATA_DIR, "tor-exit-list.json");
const WHITELIST_FILE = join(process.cwd(), "asn-block", "asn-whitelist.txt");

export interface TorListState {
  ips: string[];
  count: number;
  fetchedAt: string | null;
  lastError: string | null;
  removedCount: number;
}

let state: TorListState = { ips: [], count: 0, fetchedAt: null, lastError: null, removedCount: 0 };
let lastPush: BulkResult[] = [];

function loadState(): void {
  try {
    if (existsSync(STATE_FILE)) state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch { /* stato corrotto: si riparte da vuoto, il primo refresh lo ripopola */ }
}
loadState();

function saveState(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state), "utf-8");
  } catch (e: any) {
    console.error("[TorBlock] impossibile salvare lo stato:", e.message);
  }
}

async function defaultFetcher(): Promise<string> {
  const res = await fetch(TORLIST_URL, {
    headers: { "User-Agent": "ProxyGuardian-TorBlock/2.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// I domini in whitelist vengono risolti qui (I/O), non nel modulo filtro che resta puro.
async function resolveWhitelist(): Promise<string[]> {
  let content = "";
  try { content = readFileSync(WHITELIST_FILE, "utf-8"); } catch { return []; }
  const { cidrs, domains } = parseWhitelist(content);
  const resolved: string[] = [];
  await Promise.allSettled(domains.map(async d => {
    try {
      const addrs = await dns.resolve4(d);
      addrs.forEach(a => resolved.push(a + "/32"));
    } catch { /* dominio non risolvibile: si ignora, non deve bloccare il refresh */ }
  }));
  return cidrs.concat(resolved);
}

export async function refreshTorList(fetcher: () => Promise<string> = defaultFetcher): Promise<TorListState> {
  let body: string;
  try {
    body = await fetcher();
  } catch (e: any) {
    state = { ...state, lastError: `fetch fallito: ${e.message}` };
    saveState();
    return state;
  }

  const parsed = parseTorList(body);
  const validation = validateTorList(parsed, state.count);
  if (!validation.ok) {
    state = { ...state, lastError: validation.reason || "lista non valida" };
    saveState();
    return state;
  }

  const whitelist = await resolveWhitelist();
  const { ips, removed } = filterTorList(parsed, whitelist);

  if (removed.length > 10) {
    console.warn(`[TorBlock] ATTENZIONE: il guard ha rimosso ${removed.length} IP: ${removed.slice(0, 10).join(", ")}...`);
  } else if (removed.length > 0) {
    console.log(`[TorBlock] guard: rimossi ${removed.length} IP (${removed.join(", ")})`);
  }

  state = { ips, count: ips.length, fetchedAt: new Date().toISOString(), lastError: null, removedCount: removed.length };
  saveState();
  return state;
}

export function getTorListState(): TorListState {
  return state;
}

export function getLastPush(): BulkResult[] {
  return lastPush;
}

// `vpsIds` serve per il rollout canary: permette di applicare la lista a un solo
// VPS senza toccare la fleet. Con "all" aggiorna anche lo stato dell'ultimo push
// mostrato in UI; con un sottoinsieme no, per non far sembrare desincronizzati
// i VPS semplicemente non coinvolti nel test.
export async function pushTorListToFleet(vpsIds: string[] | "all" = "all"): Promise<BulkResult[]> {
  if (state.ips.length === 0) return [];
  const results = await bulkPost(vpsIds, "/api/tor-block/apply", { ips: state.ips });
  if (vpsIds === "all") lastPush = results;
  return results;
}

export function startTorBlockPoller(intervalMs = 3600000): void {
  const run = () => refreshTorList()
    .then(async s => {
      if (s.lastError) {
        console.error(`[TorBlock] refresh non applicato: ${s.lastError} (in uso lista da ${s.fetchedAt || "mai"})`);
        return;
      }
      const results = await pushTorListToFleet();
      const ok = results.filter(r => r.success).length;
      console.log(`[TorBlock] ${s.count} IP, push ok su ${ok}/${results.length} VPS`);
    })
    .catch(e => console.error("[TorBlock] error:", e));
  setTimeout(() => { run(); setInterval(run, intervalMs); }, 60000);
}

// Usato solo dai test per azzerare lo stato fra un caso e l'altro.
export function __resetTorStateForTest(): void {
  state = { ips: [], count: 0, fetchedAt: null, lastError: null, removedCount: 0 };
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npx tsx --test server/tor-block.test.ts`
Expected: PASS, 5 test

Nota: i test scrivono `data/tor-exit-list.json`. È già coperto da `.gitignore` insieme al resto di `data/` — verificarlo con `git status` e non committarlo mai.

- [ ] **Step 5: Commit**

```bash
git add server/tor-block.ts server/tor-block.test.ts
git commit -m "feat: modulo dashboard per lista Tor (fetch, validazione, persistenza, push fleet)"
```

---

### Task 6: Route fleet Tor + avvio poller

**Files:**
- Modify: `server/routes.ts` (import, route vicino a `/api/fleet/*` ~riga 731, avvio poller ~riga 2934)

**Interfaces:**
- Consumes: Task 5 (`refreshTorList`, `getTorListState`, `pushTorListToFleet`, `getLastPush`, `startTorBlockPoller`)
- Produces: `GET /api/fleet/tor-block/status`, `POST /api/fleet/tor-block/refresh`

- [ ] **Step 1: Aggiungi import e route**

In cima a `server/routes.ts`, accanto agli altri import:

```ts
import { refreshTorList, getTorListState, pushTorListToFleet, getLastPush, startTorBlockPoller } from "./tor-block";
```

Vicino alle altre route `/api/fleet/*`:

```ts
  app.get("/api/fleet/tor-block/status", requireAuth, (_req, res) => {
    const s = getTorListState();
    res.json({
      count: s.count,
      fetchedAt: s.fetchedAt,
      lastError: s.lastError,
      removedCount: s.removedCount,
      push: getLastPush(),
    });
  });

  // `vpsIds` opzionale: se presente limita il push a quei VPS (rollout canary).
  app.post("/api/fleet/tor-block/refresh", requireAuth, requireOperator, async (req, res) => {
    const s = await refreshTorList();
    if (s.lastError && s.count === 0) {
      return res.json({ ok: false, error: s.lastError, count: 0, push: [] });
    }
    const ids = Array.isArray(req.body && req.body.vpsIds) && req.body.vpsIds.length > 0 ? req.body.vpsIds : "all";
    const push = await pushTorListToFleet(ids);
    res.json({ ok: true, count: s.count, fetchedAt: s.fetchedAt, lastError: s.lastError, push });
  });
```

- [ ] **Step 2: Avvia il poller**

Accanto agli altri poller (~riga 2934):

```ts
  startTorBlockPoller(3600000);
```

- [ ] **Step 3: Verifica compilazione**

Run: `npx tsc --noEmit`
Expected: nessun errore

- [ ] **Step 4: Commit**

```bash
git add server/routes.ts
git commit -m "feat: route fleet Tor block e avvio poller orario"
```

---

### Task 7: Endpoint agent `apply` con posizionamento iptables

**Files:**
- Modify: `agent/index.ts` (sostituisce `/api/tor-block/status`, `/refresh`, `/install` a righe ~1565-1670; rimuove le voci sudoers Tor; corregge il bug `sh -c` a riga ~1888)

**Interfaces:**
- Consumes: Task 1 (`parseInputChain`, `planTorRules`, `findTorRules`, `ensureEstablishedRule`), Task 5 (body `{ ips: string[] }`)
- Produces: `POST /api/tor-block/apply`, `GET /api/tor-block/status`

- [ ] **Step 1: Rimuovi le voci sudoers dei vecchi script Tor**

In `agent/index.ts`, dentro `SUDOERS_CONTENT` (~riga 951), **elimina** queste 11 righe (aggiunte per il design a script, ora inutili):

```
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/tee /usr/local/bin/tor-to-ipset.py",
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/tee /usr/local/bin/update-tor-block.sh",
  "pgagent ALL=(ALL) NOPASSWD: /bin/chmod 755 /usr/local/bin/tor-to-ipset.py /usr/local/bin/update-tor-block.sh",
  "pgagent ALL=(ALL) NOPASSWD: /usr/local/bin/update-tor-block.sh",
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/systemd/system/tor-block-update.service",
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/systemd/system/tor-block-update.timer",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl enable tor-block-update.timer",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl start tor-block-update.timer",
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/systemd/system/ipset-restore.service",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl enable ipset-restore",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl start ipset-restore",
```

Nessuna voce nuova serve: `ipset *`, `iptables *`, `iptables-save`, `tee /etc/ipset.conf` e `tee /etc/iptables/rules.v4` sono già presenti (verificato live sui sudoers di dragon).

- [ ] **Step 2: Sostituisci l'intero blocco Tor**

Elimina `TOR_UPDATE_SCRIPT` (~riga 1344) e tutta la sezione `─── Tor exit-node block ───` (righe ~1565-1670: `status`, `refresh`, `install`). Al loro posto:

```ts
// ─── Tor exit-node block ──────────────────────────────────────────────────────
//
// La lista e' costruita e validata dalla dashboard e arriva gia' filtrata: qui si
// fa solo enforcement. Nessuno script, nessun timer, nessun fetch verso l'esterno.

const TOR_SET = "tor_exit";
const TOR_SET_TMP = "tor_exit_new";
const TOR_LOG_SPEC = '-m set --match-set ' + TOR_SET + ' src -m limit --limit 10/min --limit-burst 20 -j LOG --log-prefix "[TOR-BLOCK] " --log-level 4';
const TOR_DROP_SPEC = "-m set --match-set " + TOR_SET + " src -j DROP";

var torLastApply: string = "";

function ipsetRestore(input: string): Promise<void> {
  return new Promise<void>(function(resolve, reject) {
    var child = require("child_process").spawn("sudo", ["ipset", "restore", "-exist"], { stdio: ["pipe", "ignore", "pipe"] });
    var err = "";
    child.stderr.on("data", function(d: Buffer) { err += d.toString(); });
    child.on("error", reject);
    child.on("close", function(code: number) {
      if (code === 0) resolve(); else reject(new Error("ipset restore exit " + code + ": " + err));
    });
    child.stdin.write(input, "utf-8");
    child.stdin.end();
  });
}

// Elimina tutte le occorrenze di una regola (la fleet mostra regole duplicate:
// qualcosa reinserisce senza verificare, quindi non basta cancellarne una).
async function deleteAllMatching(spec: string): Promise<void> {
  for (var i = 0; i < 10; i++) {
    var check = await runCmd("sudo iptables -C INPUT " + spec + " 2>/dev/null");
    if (!check.ok) return;
    var del = await runCmd("sudo iptables -D INPUT " + spec);
    if (!del.ok) return;
  }
}

app.post("/api/tor-block/apply", async (req, res) => {
  var ips = req.body && req.body.ips;
  if (!Array.isArray(ips)) return res.status(400).json({ ok: false, error: "campo 'ips' mancante o non array" });
  if (ips.length === 0) return res.status(400).json({ ok: false, error: "lista vuota: rifiutata per non svuotare l'ipset" });

  var steps: Array<{ step: string; ok: boolean; detail?: string }> = [];
  function addStep(label: string, ok: boolean, detail?: string) {
    steps.push({ step: label, ok: ok, detail: detail });
  }

  try {
    // 1. L'ipset deve esistere PRIMA delle regole: una regola --match-set verso un
    //    set inesistente non e' inseribile.
    var created = await runCmd("sudo ipset create " + TOR_SET + " hash:ip family inet maxelem 65536 -exist");
    addStep("ipset create " + TOR_SET, created.ok, created.ok ? undefined : created.stderr);
    if (!created.ok) return res.status(500).json({ ok: false, steps: steps });

    // 2. Popola un set temporaneo e fai swap: se qualcosa fallisce a meta',
    //    resta attivo il set precedente e non si resta mai scoperti.
    var restoreInput = "create " + TOR_SET_TMP + " hash:ip family inet maxelem 65536 -exist\nflush " + TOR_SET_TMP + "\n";
    for (var i = 0; i < ips.length; i++) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ips[i])) restoreInput += "add " + TOR_SET_TMP + " " + ips[i] + "\n";
    }
    await ipsetRestore(restoreInput);
    addStep("ipset restore (" + ips.length + " IP)", true);

    var swapped = await runCmd("sudo ipset swap " + TOR_SET_TMP + " " + TOR_SET);
    addStep("ipset swap", swapped.ok, swapped.ok ? undefined : swapped.stderr);
    if (!swapped.ok) {
      await runCmd("sudo ipset destroy " + TOR_SET_TMP);
      return res.status(500).json({ ok: false, steps: steps });
    }
    await runCmd("sudo ipset destroy " + TOR_SET_TMP);

    // 3. Garantisce l'ancora ESTABLISHED prima di pianificare le regole Tor.
    var est = await ensureEstablishedRule();
    addStep("ensure ESTABLISHED", !est.error, est.error || ("posizione " + est.position + (est.changed ? " (ripristinata)" : "")));

    // 4. Pianifica sulla catena reale.
    var listed = await runCmd("sudo iptables -nvL INPUT --line-numbers");
    if (!listed.ok) {
      addStep("lettura chain INPUT", false, listed.stderr);
      return res.status(500).json({ ok: false, steps: steps });
    }
    var plan = planTorRules(parseInputChain(listed.stdout));

    // Rifiuto = HTTP 200 con ok:false, non 4xx. `agentPost` lato dashboard lancia
    // un'eccezione su qualsiasi non-2xx e perde il body, quindi la UI non potrebbe
    // distinguere "rifiutato per chain malformata" da "agent irraggiungibile".
    // Stessa convenzione del commit fef525ad per gli errori refresh pacchetti.
    if (plan.action === "refuse") {
      addStep("preflight iptables", false, plan.reason);
      return res.json({ ok: false, refused: true, reason: plan.reason, error: plan.reason, steps: steps, count: ips.length });
    }

    var rulesChanged = false;
    if (plan.action === "reposition") {
      await deleteAllMatching(TOR_LOG_SPEC);
      await deleteAllMatching(TOR_DROP_SPEC);
      addStep("rimozione regole Tor mal posizionate", true);
      rulesChanged = true;
    }

    if (plan.action === "insert" || plan.action === "reposition") {
      // Dopo le cancellazioni le posizioni sono cambiate: si rilegge e si ricalcola.
      var relisted = await runCmd("sudo iptables -nvL INPUT --line-numbers");
      var freshPlan = planTorRules(parseInputChain(relisted.stdout));
      if (freshPlan.action === "refuse" || !freshPlan.insertAt) {
        var why = freshPlan.reason || "ancora non ricalcolabile dopo la rimozione";
        addStep("preflight iptables (dopo rimozione)", false, why);
        return res.json({ ok: false, refused: true, reason: why, error: why, steps: steps });
      }
      var at = freshPlan.insertAt;

      // Una regola alla volta, con verifica fra un passo e l'altro.
      // DROP prima, poi LOG nella stessa posizione: il LOG spinge il DROP sotto,
      // stato finale LOG=at, DROP=at+1.
      var insDrop = await runCmd("sudo iptables -I INPUT " + at + " " + TOR_DROP_SPEC);
      addStep("insert DROP in posizione " + at, insDrop.ok, insDrop.ok ? undefined : insDrop.stderr);
      if (!insDrop.ok) return res.status(500).json({ ok: false, steps: steps });
      var ckDrop = await runCmd("sudo iptables -C INPUT " + TOR_DROP_SPEC);
      addStep("verifica DROP", ckDrop.ok);
      if (!ckDrop.ok) return res.status(500).json({ ok: false, steps: steps });

      var insLog = await runCmd("sudo iptables -I INPUT " + at + " " + TOR_LOG_SPEC);
      addStep("insert LOG in posizione " + at, insLog.ok, insLog.ok ? undefined : insLog.stderr);
      if (!insLog.ok) return res.status(500).json({ ok: false, steps: steps });
      var ckLog = await runCmd("sudo iptables -C INPUT " + TOR_LOG_SPEC);
      addStep("verifica LOG", ckLog.ok);

      rulesChanged = true;
    } else {
      addStep("regole iptables gia' corrette", true, "posizione ancora " + plan.anchor);
    }

    // 5. Persistenza. MAI `sudo sh -c`: pgagent non ha /bin/sh nei sudoers.
    var ipsetSaved = await runCmd("sudo ipset save");
    if (ipsetSaved.ok) {
      await sudoWriteFile("/etc/ipset.conf", ipsetSaved.stdout + "\n");
      addStep("persist /etc/ipset.conf", true);
    } else {
      addStep("persist /etc/ipset.conf", false, ipsetSaved.stderr);
    }

    // rules.v4 solo se abbiamo davvero toccato le regole: evita churn orario su 54 VPS.
    if (rulesChanged) {
      var iptSaved = await runCmd("sudo iptables-save");
      if (iptSaved.ok) {
        await sudoWriteFile("/etc/iptables/rules.v4", iptSaved.stdout + "\n");
        addStep("persist /etc/iptables/rules.v4", true);
      } else {
        addStep("persist /etc/iptables/rules.v4", false, iptSaved.stderr);
      }
    }

    torLastApply = new Date().toISOString();
    res.json({ ok: steps.every(function(s) { return s.ok; }), count: ips.length, rulesChanged: rulesChanged, steps: steps });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message, steps: steps });
  }
});

app.get("/api/tor-block/status", async (_req, res) => {
  try {
    var countRes = await runCmd("sudo ipset list " + TOR_SET + " 2>/dev/null | grep -cE '^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$' || echo 0");
    var listed = await runCmd("sudo iptables -nvL INPUT --line-numbers");
    var rules = listed.ok ? findTorRules(parseInputChain(listed.stdout)) : { log: null, drop: null };
    // Il contatore pacchetti del DROP e' l'unica prova che il blocco agisce davvero.
    var dropPkts = 0;
    if (listed.ok && rules.drop !== null) {
      var line = listed.stdout.split("\n").filter(function(l) {
        return l.indexOf("match-set " + TOR_SET + " src") !== -1 && l.indexOf("DROP") !== -1;
      })[0];
      if (line) dropPkts = parseInt(line.trim().split(/\s+/)[1], 10) || 0;
    }
    res.json({
      count: parseInt(countRes.stdout.trim(), 10) || 0,
      rulesInstalled: rules.log !== null && rules.drop !== null,
      logPosition: rules.log,
      dropPosition: rules.drop,
      dropPackets: dropPkts,
      lastApply: torLastApply,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Correggi il bug di persistenza `sh -c` preesistente**

A riga ~1888 (endpoint whitelist anti-iptv), sostituisci:

```ts
    await runCmd("sudo sh -c 'ipset save > /etc/ipset.conf'");
```

con:

```ts
    var wlSaved = await runCmd("sudo ipset save");
    if (wlSaved.ok) await sudoWriteFile("/etc/ipset.conf", wlSaved.stdout + "\n");
```

Verificato live su dragon: `sudo -u pgagent sudo -n sh -c ...` risponde `sudo: a password is required`, quindi questa persistenza non ha mai funzionato — è lo stesso gap del 2026-07-19, che era stato risolto aggiungendo il sudoers `tee /etc/ipset.conf` senza però adeguare il codice.

- [ ] **Step 4: Verifica compilazione e rebuild**

```bash
cd agent && npm run build && cd ..
npx tsx --test agent/iptables-input.test.ts
```
Expected: build ok, test PASS

- [ ] **Step 5: Commit**

```bash
git add agent/index.ts agent/agent-bundle.js
git commit -m "feat: endpoint agent tor-block/apply con posizionamento iptables verificato

Sostituisce install/refresh basati su script e timer. Corregge anche la
persistenza ipset dell'endpoint whitelist anti-iptv, che usava 'sudo sh -c'
non consentito dai sudoers di pgagent."
```

---

### Task 8: Pulizia script e deploy script

**Files:**
- Delete: `scripts/tor-to-ipset.py`, `scripts/update-tor-block.sh`
- Modify: `server/routes.ts` (costanti ~riga 298-320, path ~riga 1466, sezione deploy ~riga 2318-2360, sudoers ~riga 151)

- [ ] **Step 1: Elimina gli script**

```bash
git rm scripts/tor-to-ipset.py scripts/update-tor-block.sh
```

- [ ] **Step 2: Rimuovi le costanti e i path da `server/routes.ts`**

Elimina `DEPLOY_TOR_BLOCK_SERVICE` e `DEPLOY_TOR_BLOCK_TIMER` (~righe 298-320), le costanti `TOR_TO_IPSET_PATH` e `UPDATE_TOR_BLOCK_PATH` (~riga 1466), le variabili `torToIpsetPy` e `updateTorBlockScript` (~riga 2101) e la riga sudoers `"pgagent ALL=(ALL) NOPASSWD: /usr/local/bin/update-tor-block.sh"` (~riga 151).

- [ ] **Step 3: Riduci la sezione Tor dello script di deploy**

Sostituisci il blocco `torBlockSetup` (~righe 2318-2360) con:

```ts
      const torBlockSetup = installTorBlock
        ? `# ── TOR EXIT BLOCK ────────────────────────────────────────
# La lista e le regole sono gestite dalla dashboard via POST /api/tor-block/apply.
# Qui si crea solo l'ipset vuoto: le regole iptables le posiziona l'agent, che
# calcola l'ancora sulla chain reale (una regola appesa con -A finirebbe sotto
# l'ACCEPT dpt:8880 e non bloccherebbe nulla).
ipset create tor_exit hash:ip family inet maxelem 65536 -exist
ipset save > /etc/ipset.conf
ok "ipset tor_exit creato (popolamento al primo ciclo dashboard, entro 1h)"`
        : `# ── TOR EXIT BLOCK ────────────────────────────────────────
# non richiesto`;
```

- [ ] **Step 4: Verifica compilazione**

Run: `npx tsc --noEmit`
Expected: nessun errore, nessun riferimento residuo

Verifica anche: `grep -rn "tor-to-ipset\|update-tor-block\|DEPLOY_TOR_BLOCK" server/ scripts/ agent/index.ts`
Expected: nessun risultato

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: rimuove script e timer Tor per-VPS, ora gestiti dalla dashboard"
```

---

### Task 9: UI tab Tor Exit

**Files:**
- Modify: `client/src/pages/asn-block.tsx` (`TabTorBlock` ~righe 687-791, interfaccia `TorBlockStatus` ~riga 32)

**Interfaces:**
- Consumes: `GET /api/fleet/tor-block/status`, `POST /api/fleet/tor-block/refresh`

- [ ] **Step 1: Aggiorna l'interfaccia di stato (~riga 32)**

```ts
interface TorFleetStatus {
  count: number;
  fetchedAt: string | null;
  lastError: string | null;
  removedCount: number;
  push: Array<{ vpsId: string; vpsName: string; success: boolean; data?: any; error?: string }>;
}
```

- [ ] **Step 2: Riscrivi `TabTorBlock`**

```tsx
function TabTorBlock({ onlineVps, canWrite }: { onlineVps: any[]; canWrite: boolean }) {
  const { toast } = useToast();

  const { data: status, isLoading, refetch } = useQuery<TorFleetStatus>({
    queryKey: ["tor-block-fleet-status"],
    queryFn: async () => { const r = await apiRequest("GET", "/api/fleet/tor-block/status"); return r.json(); },
    refetchInterval: 120000,
  });

  const refreshMutation = useMutation({
    mutationFn: async () => { const r = await apiRequest("POST", "/api/fleet/tor-block/refresh", {}); return r.json(); },
    onSuccess: (data: any) => {
      refetch();
      if (!data.ok) {
        toast({ title: "Refresh fallito", description: data.error, variant: "destructive" });
        return;
      }
      const ok = (data.push || []).filter((r: any) => r.success).length;
      toast({ title: "Lista Tor aggiornata", description: `${data.count} IP, push ok su ${ok}/${(data.push || []).length} VPS` });
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const pushRows = (status?.push || []).slice().sort((a, b) => Number(a.success) - Number(b.success));
  const okCount = pushRows.filter(r => r.success).length;
  const ageMin = status?.fetchedAt ? Math.round((Date.now() - new Date(status.fetchedAt).getTime()) / 60000) : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <CardTitle>Tor Exit-Node Block</CardTitle>
              <CardDescription>
                Lista scaricata e filtrata dalla dashboard (sorgente: check.torproject.org), poi distribuita alla fleet — {okCount}/{pushRows.length} VPS sincronizzati
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
                <RefreshCw className="w-4 h-4 mr-1" />Aggiorna stato
              </Button>
              <Button size="sm" onClick={() => refreshMutation.mutate()} disabled={!canWrite || refreshMutation.isPending}>
                <Play className="w-4 h-4 mr-1" />{refreshMutation.isPending ? "In corso..." : "Forza refresh ora"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="border rounded-md p-3">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">IP in lista</p>
              <p className="text-xl font-mono">{status ? status.count : "—"}</p>
            </div>
            <div className="border rounded-md p-3">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Età lista</p>
              <p className="text-xl font-mono">{ageMin === null ? "mai" : `${ageMin} min`}</p>
            </div>
            <div className="border rounded-md p-3">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">VPS sincronizzati</p>
              <p className="text-xl font-mono">{okCount}/{pushRows.length}</p>
            </div>
            <div className="border rounded-md p-3">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Rimossi dal guard</p>
              <p className="text-xl font-mono">{status ? status.removedCount : "—"}</p>
            </div>
          </div>

          {status?.lastError && (
            <div className="border border-yellow-500/40 rounded-md p-3 text-sm text-yellow-600">
              Ultimo refresh non applicato: {status.lastError} — resta in uso l'ultima lista valida.
            </div>
          )}

          {isLoading ? <LoadingState message="Caricamento stato Tor Block..." /> : (
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>VPS</TableHead>
                    <TableHead>Stato</TableHead>
                    <TableHead>Regole</TableHead>
                    <TableHead>Dettaglio</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pushRows.length === 0 ? (
                    <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Nessun push ancora eseguito</TableCell></TableRow>
                  ) : pushRows.map(r => (
                    <TableRow key={r.vpsId}>
                      <TableCell className="font-medium">{r.vpsName}</TableCell>
                      <TableCell>
                        {r.success ? (
                          <Badge variant="outline" className="text-xs border-green-600/40 text-green-600">Sincronizzato</Badge>
                        ) : r.data && r.data.refused ? (
                          <Badge variant="outline" className="text-xs border-yellow-500/40 text-yellow-600">Rifiutato</Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs border-red-500/40 text-red-500">Errore</Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.data && r.data.rulesChanged ? "aggiornate" : r.success ? "ok" : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-md truncate">
                        {r.error || (r.data && r.data.reason) || ""}
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

- [ ] **Step 3: Verifica compilazione**

Run: `npx tsc --noEmit`
Expected: nessun errore. Se `TorBlockStatus` non è più referenziato, eliminarlo.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/asn-block.tsx
git commit -m "feat: tab Tor Exit mostra lo stato centrale della lista e la sync per-VPS"
```

---

### Task 10: Rollout Fase 2 (canary → fleet)

**Files:** nessuna modifica al repo — task operativo.

- [ ] **Step 1: Deploy in produzione**

```bash
ssh root@185.229.236.50
cd /root/proxy-dashboard && git status && git log --oneline -3
```
Verifica la divergenza prima di procedere, poi `git pull && npm run build && pm2 restart proxy-dashboard`.

- [ ] **Step 2: Verifica che la lista si popoli senza pushare**

```bash
curl -s -b cookies.txt https://secucam.net/api/fleet/tor-block/status | python3 -m json.tool
```
Expected: `count` intorno a 1400, `removedCount: 0`, `lastError: null`

Se `removedCount` è alto, **fermarsi**: significa che il guard sta togliendo IP che non dovrebbe, o che l'upstream è compromesso.

- [ ] **Step 3: Canary su un solo VPS**

Aggiorna l'agent su dragon (100.116.113.227 — ha già la regola ESTABLISHED a posizione 9), poi usa il parametro `vpsIds` per applicare la lista **solo** a lui:

```bash
# L'id di dragon si legge da GET /api/vps (campo `id`, nome "diabolik,dragon,b4zzic4")
curl -s -b cookies.txt -X POST -H "Content-Type: application/json" \
  -d '{"vpsIds":["<ID_DRAGON>"]}' \
  https://secucam.net/api/fleet/tor-block/refresh | python3 -m json.tool
```

Expected: `push` con un solo elemento, `success: true`, `data.rulesChanged: true`.

Se invece arriva `data.refused: true`, leggere `data.reason`: significa che la chain di dragon non ha l'ancora ESTABLISHED o ha `ACCEPT dpt:8880` sopra di essa. Non forzare — è il preflight che sta facendo il suo lavoro.

- [ ] **Step 4: Verifica il canary**

```bash
ssh -i ~/.ssh/id_ed25519 root@100.116.113.227 '
  echo "--- posizione regole ---"; iptables -nvL INPUT --line-numbers | grep -E "tor_exit|RELATED,ESTABLISHED|dpt:8880"
  echo "--- ipset ---"; ipset list tor_exit -t | grep -i "number of entries"
  echo "--- persistenza ---"; grep -c "tor_exit" /etc/ipset.conf
  echo "--- netbird ---"; netbird status | grep -E "Management|Signal"
  echo "--- nginx ---"; systemctl is-active nginx
  echo "--- client 8880 ---"; ss -tn state established "( sport = :8880 )" | wc -l'
```

Expected: LOG e DROP `tor_exit` **subito sotto** la ESTABLISHED generica e **sopra** `ACCEPT dpt:8880`; ipset ~1400 entry; NetBird `Connected`; nginx `active`; connessioni client stabili.

- [ ] **Step 5: Verifica di idempotenza**

Riesegui l'apply sul canary e ricontrolla la chain.
Expected: `rulesChanged: false`, nessuna regola duplicata (`grep -c tor_exit` sulla chain deve restare 2).

- [ ] **Step 6: Verifica che il blocco agisca davvero**

Dopo qualche ora:
```bash
ssh -i ~/.ssh/id_ed25519 root@100.116.113.227 'iptables -nvL INPUT --line-numbers | grep "match-set tor_exit src" '
```
Expected: il contatore pacchetti della riga DROP è **maggiore di zero**. È l'unica prova che il blocco funziona — quella che il design a `-A` non avrebbe mai potuto dare.

- [ ] **Step 7: Rollout fleet**

Aggiorna l'agent su tutta la fleet, poi lascia lavorare il poller orario (o forza con `POST /api/fleet/tor-block/refresh`).

Controlla nella UI che i VPS "Rifiutato" siano zero. Ogni rifiuto indica una chain INPUT senza ancora ESTABLISHED: quel VPS va sistemato con Fase 1 prima di poter ricevere il blocco Tor.

- [ ] **Step 8: Aggiorna CLAUDE.md**

Nella tabella "Endpoint Agent — Riferimento Rapido" sostituisci le voci Tor con:

```
| POST | `/api/tor-block/apply` | Applica la lista Tor ricevuta dalla dashboard (ipset swap + regole iptables) |
| GET | `/api/tor-block/status` | Conteggio, posizione regole, pacchetti droppati |
| POST | `/api/firewall/ensure-established` | Ri-asserisce la regola ACCEPT RELATED,ESTABLISHED generica |
```

Aggiungi in "Memoria Operativa":

```
- **Tor Exit Block**: lista scaricata/validata/filtrata dalla dashboard (poller orario, `server/tor-block.ts`), pushata via `POST /api/tor-block/apply`. Sui VPS niente script/timer/fetch: solo ipset + 2 regole. Le regole vanno **subito sotto la ACCEPT RELATED,ESTABLISHED generica** e sopra `ACCEPT dpt:8880` — mai `-A` (finirebbe sotto e non bloccherebbe nulla). Parsing chain sempre con `iptables -nvL` (`-nL` nasconde la colonna interfaccia e non distingue `-i wt0`).
- **Regola ESTABLISHED generica**: persa a runtime su 39/52 VPS il 2026-08-04 pur essendo in `rules.v4` (causa non identificata). Poller orario `startEstablishedPoller` la ri-asserisce. Senza, il SYN-ACK di ritorno viene droppato da `blocked_asn` → curl/apt/cscli in timeout.
```

```bash
git add CLAUDE.md && git commit -m "docs: aggiorna endpoint agent e memoria operativa per Tor block centralizzato"
```

---

## Note di esecuzione

- **Fase 1 va completata e verificata prima di iniziare Fase 2.** Il preflight di Task 7 rifiuta sui VPS senza ancora ESTABLISHED: con 39 VPS in quello stato il rollout Tor sarebbe inutile.
- I task operativi (3 e 10) toccano il firewall di VPS in produzione con traffico reale. Procedere sempre canary → scaglione piccolo → resto, con le verifiche indicate fra un passo e l'altro, mai in blocco.
- La causa che rimuove la regola ESTABLISHED a runtime **non è stata identificata**. Il poller di Task 2 la ri-asserisce ogni ora, il che risolve il sintomo; se dopo Fase 1 il contatore `fixed` del poller resta stabilmente sopra zero, vale la pena indagare chi la rimuove (sospetti da verificare: `netfilter-persistent` con file stale, `update-asn-block.sh`, restart NetBird).
