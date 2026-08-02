# CrowdSec install da cache pacchetti dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** L'installazione CrowdSec su un VPS non deve più dipendere dalla raggiungibilità di `packagecloud.io` dal VPS stesso — i pacchetti `.deb` vengono scaricati una volta sulla dashboard (che raggiunge packagecloud senza problemi) e trasferiti all'agent via upload binario, con fallback automatico al metodo attuale se la cache non è presente.

**Architecture:** Dashboard scarica e mette in cache 2 file `.deb` in `data/crowdsec-packages/` (bottone admin, on-demand). L'endpoint esistente `POST /api/crowdsec/install/:id` (invariato in UI) controlla la cache: se presente, invia i 2 file all'agent via `POST /api/agent/crowdsec-package` (raw octet-stream, stesso pattern di `agentUpdate` per il bundle agent) e chiama l'install dell'agent con `useCache: true`, che fa `dpkg -i` + `apt-get install -f` invece di curl/gpg/apt-repo/apt-get-install da packagecloud. Se la cache manca o l'upload fallisce, fallback trasparente al comportamento odierno.

**Tech Stack:** Node.js/Express (agent, target node12/CJS via esbuild — niente `??`/`?.`), Node.js/Express + TypeScript (server), React/TanStack Query (frontend). Nessun framework di test automatico nel repo (nessun jest/vitest); verifica = `npm run check` (tsc, lato server) e `npm run build` (esbuild, lato agent) più un test end-to-end manuale nel Task 5.

## Global Constraints

- Agent runtime: Node.js 12+, bundle compilato `--target=node12` — **mai** usare `??` o `?.` in `agent/index.ts`, solo `||`/`&&`.
- Ogni modifica ad `agent/index.ts` richiede rebuild (`cd agent && npm run build`) e il bundle `agent-bundle.js` va committato insieme alle modifiche sorgente.
- `data/` è già interamente in `.gitignore` — `data/crowdsec-packages/` non richiede modifiche a `.gitignore`.
- Le nuove route admin (`refresh`) usano `requireAuth, requireAdmin`; le route di sola lettura (`status`) usano solo `requireAuth` — coerente con lo split già esistente nelle altre route CrowdSec (es. `/api/fleet/crowdsec/summary` è `requireAuth` senza `requireAdmin`).
- Il fallback alla cache assente deve essere sempre silenzioso/automatico — mai un errore visibile all'utente solo perché la cache non è mai stata popolata.
- Stile codice: `agent/index.ts` usa `var` ovunque nel codice esistente (non `const`/`let`) — il nuovo codice in quel file segue la stessa convenzione per coerenza. `server/*.ts` usa `const`/`let` normalmente — invariato.

---

### Task 1: Agent — upload pacchetti + install cache-aware

**Files:**
- Modify: `agent/index.ts:845-953` (blocco `SUDOERS_CONTENT`)
- Modify: `agent/index.ts:2192-2312` (handler `POST /api/crowdsec/install`)
- Create (via build): `agent/agent-bundle.js` (rigenerato da `npm run build`, non editato a mano)

**Interfaces:**
- Consumes: nulla da altri task (primo task, indipendente).
- Produces:
  - `POST /api/agent/crowdsec-package` — richiede header `x-api-key` (già gestito dal middleware globale `requireApiKey` su `/api`) e header `x-package-name: "crowdsec" | "bouncer"`, body raw `application/octet-stream` (limite 80mb). Risponde `{ ok: true }` o `{ error: string }` (400/500). Scrive il file in `/tmp/pg-crowdsec-pkgs/<x-package-name>.deb`.
  - `POST /api/crowdsec/install` — body esteso con campo opzionale `useCache?: boolean` (oltre ai campi esistenti `centralLapi`, `fleetWhitelist`). Se `true` e i due file esistono in `/tmp/pg-crowdsec-pkgs/`, installa da lì invece che da packagecloud. Risposta invariata: `{ ok: boolean, steps: Array<{step, ok, error?}> }`.
  - Nuove righe sudoers (usate dall'`install` quando `useCache: true`): `/usr/bin/dpkg -i /tmp/pg-crowdsec-pkgs/*.deb`, `/usr/bin/apt-get install -f -y`.

- [ ] **Step 1: Aggiungere le 2 righe sudoers per dpkg/apt-get install -f**

In `agent/index.ts`, dentro l'array `SUDOERS_CONTENT` (inizia a riga 845), subito dopo la riga esistente:
```ts
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/apt-get install -y crowdsec crowdsec-firewall-bouncer-iptables",
```
aggiungere:
```ts
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/dpkg -i /tmp/pg-crowdsec-pkgs/*.deb",
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/apt-get install -f -y",
```

- [ ] **Step 2: Aggiungere l'endpoint di upload pacchetti**

In `agent/index.ts`, subito prima di `app.post("/api/crowdsec/install", ...)` (riga 2192), aggiungere:
```ts
app.post("/api/agent/crowdsec-package", express.raw({ type: "*/*", limit: "80mb" }), async (req, res) => {
  var name = req.headers["x-package-name"];
  if (name !== "crowdsec" && name !== "bouncer") {
    return res.status(400).json({ error: "x-package-name deve essere 'crowdsec' o 'bouncer'" });
  }
  var pkg = req.body;
  if (!Buffer.isBuffer(pkg) || pkg.length < 1000) {
    return res.status(400).json({ error: "Pacchetto non valido o troppo piccolo" });
  }
  var dir = "/tmp/pg-crowdsec-pkgs";
  try {
    await runCmd("mkdir -p " + dir, 5000);
    await writeFile(path.join(dir, name + ".deb"), pkg);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

```
Nessun nuovo import necessario: `path`, `writeFile`, `runCmd` sono già importati/definiti in cima al file (righe 4-8, 68).

- [ ] **Step 3: Rendere l'install cache-aware**

In `agent/index.ts`, dentro `app.post("/api/crowdsec/install", ...)` (riga 2192), dopo il parsing esistente di `fleetWhitelist` (riga 2208: `var fleetWhitelist = ...`), aggiungere prima del `try {` (riga 2209):
```ts
  var useCache = req.body && req.body.useCache === true;
```

Poi sostituire il blocco (righe 2217-2238 dell'originale):
```ts
    var gpg = await runCmd(
      "curl -fsSL https://packagecloud.io/crowdsec/crowdsec/gpgkey | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/crowdsec-archive-keyring.gpg",
      30000
    );
    addStep("import GPG key", gpg);

    var distro = await runCmd("lsb_release -cs 2>/dev/null || echo jammy");
    var dist = distro.stdout.trim() || "jammy";
    var repo = await runCmd(
      "echo 'deb [signed-by=/usr/share/keyrings/crowdsec-archive-keyring.gpg] https://packagecloud.io/crowdsec/crowdsec/ubuntu " + dist + " main' | sudo tee /etc/apt/sources.list.d/crowdsec.list > /dev/null",
      5000
    );
    addStep("add apt repo", repo);

    var aptUpd = await runCmd("sudo apt-get update -qq 2>&1", 60000);
    addStep("apt-get update", aptUpd);

    var aptInst = await runCmd(
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y crowdsec crowdsec-firewall-bouncer-iptables 2>&1",
      120000
    );
    addStep("apt-get install crowdsec", aptInst);
```
con:
```ts
    var cacheDir = "/tmp/pg-crowdsec-pkgs";
    var crowdsecDeb = path.join(cacheDir, "crowdsec.deb");
    var bouncerDeb = path.join(cacheDir, "bouncer.deb");
    var hasCache = useCache && existsSync(crowdsecDeb) && existsSync(bouncerDeb);

    if (hasCache) {
      // dpkg -i in due invocazioni separate (un file ciascuna): la regola sudoers
      // "/usr/bin/dpkg -i /tmp/pg-crowdsec-pkgs/*.deb" fa match fnmatch per singolo
      // argomento file, passare 2 path insieme sarebbe ambiguo da matchare.
      var dpkgInst1 = await runCmd("sudo dpkg -i " + crowdsecDeb + " 2>&1", 60000);
      var dpkgInst2 = await runCmd("sudo dpkg -i " + bouncerDeb + " 2>&1", 60000);
      addStep("install da pacchetti cache", {
        ok: dpkgInst1.ok && dpkgInst2.ok,
        stdout: dpkgInst1.stdout + dpkgInst2.stdout,
        stderr: dpkgInst1.stderr + dpkgInst2.stderr,
      });

      var fixDeps = await runCmd("sudo apt-get install -f -y 2>&1", 60000);
      addStep("apt-get install -f (dipendenze)", fixDeps);

      await runCmd("rm -f " + crowdsecDeb + " " + bouncerDeb, 5000);
    } else {
      var gpg = await runCmd(
        "curl -fsSL https://packagecloud.io/crowdsec/crowdsec/gpgkey | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/crowdsec-archive-keyring.gpg",
        30000
      );
      addStep("import GPG key", gpg);

      var distro = await runCmd("lsb_release -cs 2>/dev/null || echo jammy");
      var dist = distro.stdout.trim() || "jammy";
      var repo = await runCmd(
        "echo 'deb [signed-by=/usr/share/keyrings/crowdsec-archive-keyring.gpg] https://packagecloud.io/crowdsec/crowdsec/ubuntu " + dist + " main' | sudo tee /etc/apt/sources.list.d/crowdsec.list > /dev/null",
        5000
      );
      addStep("add apt repo", repo);

      var aptUpd = await runCmd("sudo apt-get update -qq 2>&1", 60000);
      addStep("apt-get update", aptUpd);

      var aptInst = await runCmd(
        "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y crowdsec crowdsec-firewall-bouncer-iptables 2>&1",
        120000
      );
      addStep("apt-get install crowdsec", aptInst);
    }
```
Il resto della funzione (hub update, collezioni, scenari, whitelist, LAPI centrale, bouncer key) resta invariato — nessuna altra modifica in questo handler. `existsSync` è già importato in cima al file (riga 5).

- [ ] **Step 4: Build e verifica**

Run: `cd agent && npm run build`
Expected: esce senza errori, `agent-bundle.js` viene rigenerato (verificare con `git status` che il file risulti modificato).

- [ ] **Step 5: Commit**

```bash
git add agent/index.ts agent/agent-bundle.js
git commit -m "feat: install CrowdSec da pacchetti cache invece che da packagecloud diretto sul VPS"
```

---

### Task 2: Server — helper cache pacchetti + route refresh/status

**Files:**
- Modify: `server/vps-manager.ts:21-22` (costanti top-level) e dopo `agentUpdate` (dopo riga 330)
- Modify: `server/routes.ts:12` (import da `./vps-manager`) e dopo la route uninstall (dopo riga 1718)

**Interfaces:**
- Consumes: Task 1 (`POST /api/agent/crowdsec-package` sull'agent, contratto header/body descritto sopra).
- Produces (usati dal Task 3):
  - `CROWDSEC_PACKAGES_DIR: string` — path assoluto della cache.
  - `CrowdsecPackageManifest { version: string; downloadedAt: string }`
  - `getCrowdsecPackageManifest(): CrowdsecPackageManifest | null`
  - `agentUploadPackage(vps: VpsConfig, name: "crowdsec" | "bouncer", buf: Buffer): Promise<void>` — lancia eccezione se l'upload fallisce (nessun retry).
  - `POST /api/crowdsec/packages/refresh` (admin) → `{ ok: true, version: string, downloadedAt: string }` o `{ error: string }`.
  - `GET /api/crowdsec/packages/status` → `{ cached: boolean, version: string | null, downloadedAt: string | null }`.

- [ ] **Step 1: Costanti e helper in vps-manager.ts**

In `server/vps-manager.ts`, dopo la riga 22 (`const VPS_FILE = join(DATA_DIR, "vps.json");`), aggiungere:
```ts

export const CROWDSEC_PACKAGES_DIR = join(DATA_DIR, "crowdsec-packages");
const CROWDSEC_PACKAGES_MANIFEST = join(CROWDSEC_PACKAGES_DIR, "manifest.json");

export interface CrowdsecPackageManifest {
  version: string;
  downloadedAt: string;
}

export function getCrowdsecPackageManifest(): CrowdsecPackageManifest | null {
  if (!existsSync(CROWDSEC_PACKAGES_MANIFEST)) return null;
  try {
    return JSON.parse(readFileSync(CROWDSEC_PACKAGES_MANIFEST, "utf-8"));
  } catch {
    return null;
  }
}
```
`readFileSync` ed `existsSync` sono già importati in cima al file (riga 2).

- [ ] **Step 2: Helper di upload in vps-manager.ts**

In `server/vps-manager.ts`, subito dopo la fine della funzione `agentUpdate` (dopo la riga 330, prima di `export async function bulkAgentUpdate`), aggiungere:
```ts
export async function agentUploadPackage(vps: VpsConfig, name: "crowdsec" | "bouncer", buf: Buffer): Promise<void> {
  const url = `http://${vps.host}:${vps.port}/api/agent/crowdsec-package`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/octet-stream", "x-api-key": vps.apiKey, "x-package-name": name },
      body: buf,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${vps.name}: upload ${name} fallito - ${res.status} ${text}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

```

- [ ] **Step 3: Import in routes.ts**

In `server/routes.ts:12`, il blocco import da `./vps-manager` diventa:
```ts
import { getAllVps, getVpsById, createVps, updateVps, deleteVps, checkVpsHealth, checkAllVpsHealth, getHealthFromCache, getLastPollTime, startHealthPoller, syncIptvBanFleet, startBanSyncPoller, agentGet, agentPost, agentDelete, bulkGet, bulkPost, agentUpdate, bulkAgentUpdate, SLOW_REQUEST_TIMEOUT, SLOW_PATHS, getCrowdsecPackageManifest, CROWDSEC_PACKAGES_DIR, agentUploadPackage } from "./vps-manager";
```

- [ ] **Step 4: Route refresh + status in routes.ts**

In `server/routes.ts`, subito dopo la route `/api/crowdsec/uninstall/:id` (dopo la riga 1718, prima di `app.get("/api/fleet/crowdsec/summary", ...)` alla riga 1720), aggiungere:
```ts

  app.post("/api/crowdsec/packages/refresh", requireAuth, requireAdmin, async (_req, res) => {
    try {
      mkdirSync(CROWDSEC_PACKAGES_DIR, { recursive: true });
      for (const f of readdirSync(CROWDSEC_PACKAGES_DIR)) {
        if (f.endsWith(".deb")) unlinkSync(join(CROWDSEC_PACKAGES_DIR, f));
      }
      await execFileAsync("apt-get", ["download", "crowdsec", "crowdsec-firewall-bouncer-iptables"], {
        cwd: CROWDSEC_PACKAGES_DIR, timeout: 60000,
      });
      const files = readdirSync(CROWDSEC_PACKAGES_DIR).filter(f => f.endsWith(".deb"));
      const crowdsecFile = files.find(f => f.startsWith("crowdsec_"));
      const bouncerFile = files.find(f => f.startsWith("crowdsec-firewall-bouncer-iptables_"));
      if (!crowdsecFile || !bouncerFile) {
        return res.status(500).json({ error: "Download incompleto: pacchetti mancanti dopo apt-get download" });
      }
      const versionMatch = crowdsecFile.match(/^crowdsec_([^_]+)_/);
      const manifest = { version: versionMatch ? versionMatch[1] : "unknown", downloadedAt: new Date().toISOString() };
      writeFileSync(join(CROWDSEC_PACKAGES_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
      res.json({ ok: true, ...manifest });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/crowdsec/packages/status", requireAuth, (_req, res) => {
    const manifest = getCrowdsecPackageManifest();
    res.json({ cached: !!manifest, version: manifest?.version ?? null, downloadedAt: manifest?.downloadedAt ?? null });
  });
```
`mkdirSync`, `readdirSync`, `unlinkSync`, `writeFileSync`, `join`, `execFileAsync` sono già importati/definiti in cima a `routes.ts` (righe 4-6, 13-14) — nessun nuovo import oltre a quello dello Step 3.

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: nessun errore TypeScript.

- [ ] **Step 6: Commit**

```bash
git add server/vps-manager.ts server/routes.ts
git commit -m "feat: cache pacchetti CrowdSec sulla dashboard (refresh + status)"
```

---

### Task 3: Server — usare la cache nell'install esistente

**Files:**
- Modify: `server/routes.ts:1662-1684` (handler `POST /api/crowdsec/install/:id`)

**Interfaces:**
- Consumes: Task 1 (agent accetta `useCache` + endpoint upload), Task 2 (`getCrowdsecPackageManifest`, `CROWDSEC_PACKAGES_DIR`, `agentUploadPackage`, tutti già importati in `routes.ts` dal Task 2 Step 3).
- Produces: nessuna nuova interfaccia — la route esistente resta identica nella forma della risposta (`{ ok, steps }`), cambia solo il comportamento interno.

- [ ] **Step 1: Sostituire l'handler**

In `server/routes.ts`, l'intero blocco (righe 1662-1684):
```ts
  app.post("/api/crowdsec/install/:id", requireAuth, requireAdmin, async (req, res) => {
    const vps = getVpsById(req.params.id);
    if (!vps) return res.status(404).json({ error: "VPS non trovato" });
    let central: { url: string; login: string; password: string; bouncerKey: string };
    try {
      central = provisionCrowdsecCentral(vps.id);
    } catch (e: any) {
      return res.status(500).json({ error: `Provisioning LAPI centrale fallito: ${e.message}` });
    }
    let fleetWhitelist: string | undefined;
    try {
      fleetWhitelist = readFileSync(join(process.cwd(), "crowdsec", "parsers", "s02-enrich", "fleet-whitelist.yaml"), "utf-8");
    } catch { fleetWhitelist = undefined; }
    try {
      const result = await agentPost(vps, "/api/crowdsec/install", {
        centralLapi: { url: central.url, login: central.login, password: central.password, bouncerKey: central.bouncerKey },
        fleetWhitelist,
      }, SLOW_REQUEST_TIMEOUT);
      res.json(result);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });
```
diventa:
```ts
  app.post("/api/crowdsec/install/:id", requireAuth, requireAdmin, async (req, res) => {
    const vps = getVpsById(req.params.id);
    if (!vps) return res.status(404).json({ error: "VPS non trovato" });
    let central: { url: string; login: string; password: string; bouncerKey: string };
    try {
      central = provisionCrowdsecCentral(vps.id);
    } catch (e: any) {
      return res.status(500).json({ error: `Provisioning LAPI centrale fallito: ${e.message}` });
    }
    let fleetWhitelist: string | undefined;
    try {
      fleetWhitelist = readFileSync(join(process.cwd(), "crowdsec", "parsers", "s02-enrich", "fleet-whitelist.yaml"), "utf-8");
    } catch { fleetWhitelist = undefined; }

    let useCache = false;
    const manifest = getCrowdsecPackageManifest();
    if (manifest) {
      try {
        const files = readdirSync(CROWDSEC_PACKAGES_DIR).filter(f => f.endsWith(".deb"));
        const crowdsecFile = files.find(f => f.startsWith("crowdsec_"));
        const bouncerFile = files.find(f => f.startsWith("crowdsec-firewall-bouncer-iptables_"));
        if (crowdsecFile && bouncerFile) {
          const crowdsecBuf = readFileSync(join(CROWDSEC_PACKAGES_DIR, crowdsecFile));
          const bouncerBuf = readFileSync(join(CROWDSEC_PACKAGES_DIR, bouncerFile));
          await agentUploadPackage(vps, "crowdsec", crowdsecBuf);
          await agentUploadPackage(vps, "bouncer", bouncerBuf);
          useCache = true;
        }
      } catch {
        useCache = false;
      }
    }

    try {
      const result = await agentPost(vps, "/api/crowdsec/install", {
        centralLapi: { url: central.url, login: central.login, password: central.password, bouncerKey: central.bouncerKey },
        fleetWhitelist,
        useCache,
      }, SLOW_REQUEST_TIMEOUT);
      res.json(result);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });
```
Nota: se l'upload fallisce, l'eccezione viene catturata dal blocco `try/catch` interno e `useCache` resta `false` — fallback automatico al metodo packagecloud diretto, coerente col design.

- [ ] **Step 2: Typecheck**

Run: `npm run check`
Expected: nessun errore TypeScript.

- [ ] **Step 3: Commit**

```bash
git add server/routes.ts
git commit -m "feat: install CrowdSec usa la cache pacchetti quando disponibile"
```

---

### Task 4: Frontend — stato cache + bottone refresh

**Files:**
- Modify: `client/src/pages/crowdsec.tsx:12` (import icone)
- Modify: `client/src/pages/crowdsec.tsx` (dentro `OverviewTab`, dopo la riga 148 `});` di chiusura `uninstallMutation` e prima del `return (` alla riga 150; e nel JSX tra la riga 172 `</div>` e la riga 174 `{isLoading ? (`)

**Interfaces:**
- Consumes: Task 2 (`GET /api/crowdsec/packages/status`, `POST /api/crowdsec/packages/refresh`).
- Produces: nessuna interfaccia consumata da altri task (ultimo task di codice, poi Task 5 è verifica).

- [ ] **Step 1: Import icone**

In `client/src/pages/crowdsec.tsx:12`, la riga:
```ts
import { Shield, ShieldCheck, ShieldX, ShieldOff, RefreshCw, Plus, Trash2, Upload, Search, CheckCircle2, XCircle, AlertTriangle, BarChart2, Loader2 } from "lucide-react";
```
diventa:
```ts
import { Shield, ShieldCheck, ShieldX, ShieldOff, RefreshCw, Plus, Trash2, Upload, Search, CheckCircle2, XCircle, AlertTriangle, BarChart2, Loader2, Package, Download } from "lucide-react";
```

- [ ] **Step 2: Query + mutation per lo stato cache**

In `client/src/pages/crowdsec.tsx`, dentro la funzione `OverviewTab` (che inizia a riga 75), subito dopo la chiusura di `uninstallMutation` (riga 148, `});`) e prima di `return (` (riga 150), aggiungere:
```ts

  const { data: pkgStatus, refetch: refetchPkgStatus } = useQuery<{ cached: boolean; version: string | null; downloadedAt: string | null }>({
    queryKey: ["crowdsec-packages-status"],
    queryFn: async () => { const r = await apiRequest("GET", "/api/crowdsec/packages/status"); return r.json(); },
  });

  const refreshPackagesMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/crowdsec/packages/refresh");
      return r.json();
    },
    onSuccess: (result: { ok?: boolean; version?: string; error?: string }) => {
      if (result.ok) {
        toast({ title: "Pacchetti CrowdSec aggiornati", description: `Versione ${result.version}` });
        refetchPkgStatus();
      } else {
        toast({ title: "Aggiornamento pacchetti fallito", description: result.error, variant: "destructive" });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Aggiornamento pacchetti fallito", description: err.message, variant: "destructive" });
    },
  });
```

- [ ] **Step 3: Riga di stato + bottone nel JSX**

In `client/src/pages/crowdsec.tsx`, subito dopo la chiusura del blocco header (riga 172, `</div>`) e prima di `{isLoading ? (` (riga 174), aggiungere:
```tsx

      <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Package className="w-4 h-4" />
          {pkgStatus?.cached
            ? <span>Pacchetti in cache: v{pkgStatus.version} ({new Date(pkgStatus.downloadedAt!).toLocaleString("it-IT")})</span>
            : <span>Nessun pacchetto in cache — install userà packagecloud direttamente dal VPS</span>}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={refreshPackagesMutation.isPending}
          onClick={() => refreshPackagesMutation.mutate()}
        >
          {refreshPackagesMutation.isPending
            ? <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            : <Download className="w-4 h-4 mr-1" />}
          Aggiorna pacchetti
        </Button>
      </div>
```

- [ ] **Step 4: Typecheck**

Run: `npm run check`
Expected: nessun errore TypeScript.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/crowdsec.tsx
git commit -m "feat: mostra stato cache pacchetti CrowdSec e bottone refresh in UI"
```

---

### Task 5: Verifica end-to-end + deploy

**Files:** nessuna modifica codice — solo verifica ed eventuale push/deploy.

**Interfaces:**
- Consumes: tutto (Task 1-4).
- Produces: nulla.

**Nota:** gli step di deploy su produzione (185.229.236.50 e fleet VPS) sono azioni con impatto su infrastruttura live — confermare esplicitamente con l'utente prima di eseguirli, non farlo autonomamente.

- [ ] **Step 1: Push del bundle agent su GitHub**

I nuovi VPS deployati scaricano `agent/agent-bundle.js` da GitHub `main` — senza push, un nuovo VPS deployato dopo questo lavoro scaricherebbe comunque l'agent vecchio.
```bash
git push origin main
```

- [ ] **Step 2: Hot-deploy dashboard**

Copiare i file modificati (`server/vps-manager.ts`, `server/routes.ts`, `client/src/pages/crowdsec.tsx`, `agent/agent-bundle.js` se un VPS esistente verrà reinstallato) su `185.229.236.50:/root/proxy-dashboard`, poi:
```bash
cd /root/proxy-dashboard && npm run build && pm2 restart proxy-dashboard
```

- [ ] **Step 3: Popolare la cache**

Nella pagina CrowdSec della dashboard, premere "Aggiorna pacchetti". Verificare via `GET /api/crowdsec/packages/status` (o il badge in UI) che `cached: true` con una versione valida.

- [ ] **Step 4: Test su un VPS reale**

Scegliere un VPS su cui l'install CrowdSec oggi si blocca (o un VPS fleet già installato: prima `POST /api/crowdsec/uninstall/:id`, poi reinstallare). Premere "Installa" e verificare:
- Tutti gli step in risposta hanno `ok: true`, incluso "install da pacchetti cache".
- `crowdsec` e `crowdsec-firewall-bouncer` risultano attivi (`GET /api/crowdsec/status` sull'agent).
- `cscli bouncers list` sulla dashboard mostra il bouncer del VPS registrato sulla LAPI centrale.

- [ ] **Step 5: Verifica fallback**

Rinominare temporaneamente `data/crowdsec-packages/` sulla dashboard (es. `mv data/crowdsec-packages data/crowdsec-packages.bak`), rilanciare l'install su un secondo VPS, confermare che tutti gli step "import GPG key" / "add apt repo" / "apt-get update" / "apt-get install crowdsec" compaiono e completano con `ok: true` (percorso vecchio, invariato). Poi ripristinare la cartella:
```bash
mv data/crowdsec-packages.bak data/crowdsec-packages
```
