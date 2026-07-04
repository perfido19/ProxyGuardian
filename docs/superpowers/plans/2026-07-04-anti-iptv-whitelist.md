# Anti-IPTV Whitelist Fleet-Wide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Whitelist IP/CIDR fleet-wide per anti-iptv, gestibile da un'unica sezione della dashboard, sincronizzata su tutti i VPS enabled.

**Architecture:** File centrale `scripts/iptv-whitelist.txt` nel repo dashboard è la fonte di verità. Il salvataggio via UI valida gli IP/CIDR, scrive il file, poi chiama in parallelo un nuovo endpoint agent (`POST /api/anti-iptv/whitelist`) su ogni VPS enabled, che ricostruisce l'ipset `iptv_whitelist` (già letto da `anti-iptv.py`, mai finora popolato) via `ipset restore` e lo persiste su `/etc/ipset.conf` (riusa `ipset-restore.service` già installato per ASN block).

**Tech Stack:** Express + TypeScript (server, agent), React + TanStack Query + shadcn/ui (client), esbuild target node12 per il bundle agent.

## Global Constraints

- Agent (`agent/index.ts`) deve restare compatibile Node.js 12 — niente `?.` o `??`, solo `||`/`&&` (da CLAUDE.md).
- Ogni modifica a `agent/index.ts` richiede rebuild: `cd agent && npm run build`, e il bundle rigenerato va committato insieme al sorgente.
- Nessun `npm install` — usare solo dipendenze già presenti (`child_process`, `fs`, già importate in entrambi i file).
- Non esiste framework di test nel progetto (`package.json` non ha script `test` né devDependency di test). La verifica è: `npm run check` (tsc) per i tipi, e controlli manuali via `node -e` / `curl` contro un agente reale — stesso metodo usato in tutta questa sessione. Non inventare comandi `jest`/`pytest` che non esistono.
- Non toccare `server/auth.ts` senza conferma esplicita (da CLAUDE.md) — questo piano non lo tocca.

---

### Task 1: Validatore IP/CIDR + endpoint agent per la whitelist

**Files:**
- Modify: `agent/index.ts` (aggiungere dopo la route `app.post("/api/anti-iptv/params", ...)` che termina intorno alla riga 1702, prima di `app.get("/api/anti-iptv/status", ...)`)

**Interfaces:**
- Produces: `isValidIpOrCidr(value: string): boolean` — funzione pura, nessuna dipendenza esterna.
- Produces: endpoint `POST /api/anti-iptv/whitelist` — riceve `{ entries: string[] }`, risponde `{ ok: true, count: number }` o `{ error: string }`.
- Consumes: `runCmd` (già definita riga 68), pattern di `spawn` con stdin già visto in `sudoWriteFile` (riga 76).

- [ ] **Step 1: Aggiungi il validatore IP/CIDR puro**

In `agent/index.ts`, subito prima di `app.get("/api/anti-iptv/detect", ...)` (circa riga 1627, cerca il commento `// ─── Anti-IPTV ...` se presente o il testo esatto `app.get("/api/anti-iptv/detect"`), inserisci:

```typescript
function isValidIpOrCidr(value: string): boolean {
  var m = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
  if (!m) return false;
  for (var i = 1; i <= 4; i++) {
    var octet = parseInt(m[i], 10);
    if (octet < 0 || octet > 255) return false;
  }
  if (m[5] !== undefined) {
    var prefix = parseInt(m[5], 10);
    if (prefix < 0 || prefix > 32) return false;
  }
  return true;
}
```

- [ ] **Step 2: Verifica manuale del validatore (nessun framework di test nel progetto)**

Esegui, dalla root del repo:

```bash
node -e '
function isValidIpOrCidr(value) {
  var m = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
  if (!m) return false;
  for (var i = 1; i <= 4; i++) {
    var octet = parseInt(m[i], 10);
    if (octet < 0 || octet > 255) return false;
  }
  if (m[5] !== undefined) {
    var prefix = parseInt(m[5], 10);
    if (prefix < 0 || prefix > 32) return false;
  }
  return true;
}
var cases = [
  ["1.2.3.4", true],
  ["1.2.3.0/24", true],
  ["255.255.255.255/32", true],
  ["1.2.3.256", false],
  ["1.2.3.4/33", false],
  ["not-an-ip", false],
  ["1.2.3", false],
  ["", false],
];
var failed = 0;
cases.forEach(function(c) {
  var result = isValidIpOrCidr(c[0]);
  if (result !== c[1]) { console.log("FAIL", c[0], "expected", c[1], "got", result); failed++; }
});
console.log(failed === 0 ? "ALL PASS" : failed + " FAILED");
'
```

Expected output: `ALL PASS`

- [ ] **Step 3: Aggiungi l'endpoint `POST /api/anti-iptv/whitelist`**

Subito dopo la funzione `isValidIpOrCidr` appena aggiunta, inserisci:

```typescript
app.post("/api/anti-iptv/whitelist", async (req, res) => {
  try {
    var entries = req.body && req.body.entries;
    if (!Array.isArray(entries)) return res.status(400).json({ error: "entries deve essere un array" });
    var clean: string[] = [];
    for (var i = 0; i < entries.length; i++) {
      var e = String(entries[i]).trim();
      if (!e) continue;
      if (!isValidIpOrCidr(e)) return res.status(400).json({ error: "Valore non valido: " + e });
      clean.push(e);
    }
    await runCmd("sudo ipset create iptv_whitelist hash:net -exist");
    var restoreInput = "flush iptv_whitelist\n";
    for (var j = 0; j < clean.length; j++) {
      restoreInput += "add iptv_whitelist " + clean[j] + " -exist\n";
    }
    await new Promise<void>(function(resolve, reject) {
      var child = require("child_process").spawn("sudo", ["ipset", "restore"], { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", reject);
      child.on("close", function(code: number) {
        if (code === 0) resolve(); else reject(new Error("ipset restore exit " + code));
      });
      child.stdin.write(restoreInput, "utf-8");
      child.stdin.end();
    });
    await runCmd("sudo ipset save > /etc/ipset.conf 2>/dev/null || sudo sh -c 'ipset save > /etc/ipset.conf'");
    res.json({ ok: true, count: clean.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

Nota: `runCmd` usa `execAsync` (shell string, niente redirezione con permessi elevati affidabile per `>` su file root-only) — per questo il save usa `sudo sh -c '...'` come fallback esplicito nello stesso comando shell, evitando che la redirezione `>` giri con permessi utente invece che root.

- [ ] **Step 4: Type-check**

```bash
cd /home/massimo/Progetti/ProxyGuardian && npm run check
```

Expected: nessun errore TypeScript (exit code 0).

- [ ] **Step 5: Commit**

```bash
git add agent/index.ts
git commit -m "feat: endpoint agent per whitelist anti-iptv (ipset iptv_whitelist)"
```

---

### Task 2: Rebuild bundle agent

**Files:**
- Modify: `agent/agent-bundle.js` (generato, non a mano)

**Interfaces:**
- Consumes: `agent/index.ts` da Task 1.
- Produces: `agent/agent-bundle.js` aggiornato, pronto per il deploy fleet (Task 5).

- [ ] **Step 1: Build**

```bash
cd /home/massimo/Progetti/ProxyGuardian/agent && npm run build
```

Expected: output `agent-bundle.js  X.Xmb` senza errori esbuild.

- [ ] **Step 2: Verifica sintattica del bundle (node può caricarlo senza eseguirlo)**

```bash
node --check /home/massimo/Progetti/ProxyGuardian/agent/agent-bundle.js
```

Expected: nessun output (exit 0 = sintassi valida). Se stampa un `SyntaxError`, il bundle non è deployabile.

- [ ] **Step 3: Commit**

```bash
git add agent/agent-bundle.js
git commit -m "chore: rebuild agent bundle con endpoint whitelist anti-iptv"
```

---

### Task 3: Route fleet server + file centrale whitelist

**Files:**
- Modify: `server/routes.ts` (aggiungere dopo il blocco `app.post("/api/fleet/anti-iptv/params", ...)`, cerca `bulkPost(targetIds, "/api/anti-iptv/params", body)` intorno alla riga 739, il blocco finisce poco dopo — inserisci subito dopo la chiusura di quella route)
- Create: `scripts/iptv-whitelist.txt` (file iniziale vuoto con header)

**Interfaces:**
- Consumes: `bulkPost` da `./vps-manager` (già importato in routes.ts riga 12), `requireAuth`/`requireAdmin` (già importati riga 10), `readFileSync`/`writeFileSync`/`existsSync` (già importati riga 12), `join` da `path` (già importato riga 13).
- Produces: `GET /api/fleet/anti-iptv/whitelist` → `{ content: string }`; `POST /api/fleet/anti-iptv/whitelist` → `{ ok: true, content: string, syncResults: BulkResult[] }` o `{ error: string }`.

- [ ] **Step 1: Crea il file iniziale**

```bash
mkdir -p /home/massimo/Progetti/ProxyGuardian/scripts
```

Crea `scripts/iptv-whitelist.txt` con questo contenuto esatto:

```
# Whitelist anti-iptv fleet-wide — un IP o CIDR per riga, commenti con #
# Sincronizzata su tutti i VPS enabled tramite dashboard → Anti-IPTV
```

- [ ] **Step 2: Aggiungi le route fleet in `server/routes.ts`**

Trova il blocco esistente (intorno alla riga 726-740):

```typescript
  app.post("/api/fleet/anti-iptv/params", requireAuth, requireAdmin, async (req, res) => {
```

Localizza la fine di quella route (la chiusura `});` subito dopo la riga con `bulkPost(targetIds, "/api/anti-iptv/params", body)`), e subito dopo inserisci:

```typescript
  const IPTV_WHITELIST_PATH = join(process.cwd(), "scripts", "iptv-whitelist.txt");

  function readIptvWhitelistFile(): string {
    try { return existsSync(IPTV_WHITELIST_PATH) ? readFileSync(IPTV_WHITELIST_PATH, "utf-8") : ""; } catch { return ""; }
  }

  function parseIptvWhitelistEntries(content: string): string[] {
    return content.split("\n")
      .map(line => line.split("#")[0].trim())
      .filter(Boolean);
  }

  const IP_OR_CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
  function isValidIpOrCidr(value: string): boolean {
    const m = value.match(IP_OR_CIDR_RE);
    if (!m) return false;
    for (let i = 1; i <= 4; i++) {
      const octet = parseInt(m[i], 10);
      if (octet < 0 || octet > 255) return false;
    }
    if (m[5] !== undefined) {
      const prefix = parseInt(m[5], 10);
      if (prefix < 0 || prefix > 32) return false;
    }
    return true;
  }

  app.get("/api/fleet/anti-iptv/whitelist", requireAuth, (_req, res) => {
    res.json({ content: readIptvWhitelistFile() });
  });

  app.post("/api/fleet/anti-iptv/whitelist", requireAuth, requireAdmin, async (req, res) => {
    const { content } = req.body;
    if (typeof content !== "string") return res.status(400).json({ error: "content required" });
    const entries = parseIptvWhitelistEntries(content);
    const invalid = entries.filter(e => !isValidIpOrCidr(e));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Righe non valide: ${invalid.join(", ")}` });
    }
    writeFileSync(IPTV_WHITELIST_PATH, content, "utf-8");
    const targetVpsIds = getAllVps().filter(v => v.enabled).map(v => v.id);
    const syncResults = await bulkPost(targetVpsIds, "/api/anti-iptv/whitelist", { entries });
    res.json({ ok: true, content, syncResults });
  });
```

- [ ] **Step 3: Type-check**

```bash
cd /home/massimo/Progetti/ProxyGuardian && npm run check
```

Expected: nessun errore.

- [ ] **Step 4: Verifica manuale con server dev**

Avvia il server in un terminale separato:

```bash
cd /home/massimo/Progetti/ProxyGuardian && npm run dev
```

In un altro terminale, dopo il login (sostituisci con credenziali valide da `.env`):

```bash
curl -s -c /tmp/plan_cookie.txt -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<password da .env>"}'

curl -s -b /tmp/plan_cookie.txt http://localhost:5000/api/fleet/anti-iptv/whitelist
```

Expected: `{"content":"# Whitelist anti-iptv fleet-wide — un IP o CIDR per riga, commenti con #\n# Sincronizzata su tutti i VPS enabled tramite dashboard → Anti-IPTV\n"}`

Poi testa la validazione:

```bash
curl -s -b /tmp/plan_cookie.txt -X POST http://localhost:5000/api/fleet/anti-iptv/whitelist \
  -H "Content-Type: application/json" \
  -d '{"content":"not-an-ip\n1.2.3.4"}'
```

Expected: `{"error":"Righe non valide: not-an-ip"}` (status 400) — nessuna sincronizzazione fleet deve partire con input non valido.

Ferma il server dev (Ctrl+C) prima di procedere.

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts scripts/iptv-whitelist.txt
git commit -m "feat: route fleet GET/POST whitelist anti-iptv"
```

---

### Task 4: UI whitelist nella pagina Anti-IPTV

**Files:**
- Modify: `client/src/pages/anti-iptv-management.tsx`

**Interfaces:**
- Consumes: `GET /api/fleet/anti-iptv/whitelist` → `{ content: string }`; `POST /api/fleet/anti-iptv/whitelist` → `{ ok: true, content: string, syncResults: BulkResult[] }` (da Task 3).
- Consumes: componente `Textarea` da `@/components/ui/textarea` (già presente nel progetto).

- [ ] **Step 1: Aggiungi l'import di Textarea**

In `client/src/pages/anti-iptv-management.tsx`, riga 9, dopo `import { Input } from "@/components/ui/input";` aggiungi:

```typescript
import { Textarea } from "@/components/ui/textarea";
```

- [ ] **Step 2: Aggiungi il tipo per il risultato di sync**

Dopo l'interface `ParamsResponse` (righe 38-41), aggiungi:

```typescript
interface WhitelistSyncResult {
  vpsId: string;
  vpsName: string;
  success: boolean;
  data?: any;
  error?: string;
}

interface WhitelistResponse {
  ok: boolean;
  content: string;
  syncResults: WhitelistSyncResult[];
}
```

- [ ] **Step 3: Aggiungi query, stato e mutation per la whitelist**

Dentro `export default function AntiIptvManagement() {`, subito dopo la riga `const [lastResult, setLastResult] = useState<ParamsResponse | null>(null);` (riga 85), aggiungi:

```typescript
  const { data: whitelistData } = useQuery<{ content: string }>({
    queryKey: ["/api/fleet/anti-iptv/whitelist"],
  });
  const [whitelistText, setWhitelistText] = useState("");
  const [whitelistSyncResult, setWhitelistSyncResult] = useState<WhitelistResponse | null>(null);
  const [whitelistDirty, setWhitelistDirty] = useState(false);

  if (whitelistData && !whitelistDirty && whitelistText === "") {
    setWhitelistText(whitelistData.content);
  }

  const whitelistMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/fleet/anti-iptv/whitelist", { content: whitelistText });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Errore sconosciuto");
      }
      return res.json() as Promise<WhitelistResponse>;
    },
    onSuccess: (res) => {
      setWhitelistSyncResult(res);
      setWhitelistDirty(false);
      const ok = res.syncResults.filter(r => r.success).length;
      const fail = res.syncResults.filter(r => !r.success).length;
      toast({
        title: "Whitelist sincronizzata",
        description: `${ok} successi, ${fail} errori su ${res.syncResults.length} VPS`,
        variant: fail > 0 ? "destructive" : "default",
      });
    },
    onError: (err: Error) => toast({ title: "Errore", description: err.message, variant: "destructive" }),
  });
```

Nota: il pattern `if (whitelistData && !whitelistDirty && whitelistText === "")` dentro il corpo del componente (non in un `useEffect`) è intenzionale e sicuro qui — è idempotente (stessa condizione, stesso risultato) e serve solo a precaricare il testo la prima volta che i dati arrivano; React tollera `setState` durante il render per questo pattern di derivazione da props/query.

- [ ] **Step 4: Aggiungi la Card whitelist nel JSX**

Subito prima della chiusura `{lastResult && (` (riga 223), inserisci una nuova Card:

```typescript
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Whitelist</CardTitle>
          <CardDescription>
            IP o CIDR mai bannati dall'anti-iptv, uno per riga (es. <code>1.2.3.4</code> o <code>1.2.3.0/24</code>). Commenti con <code>#</code>. Sincronizzata su tutti i VPS enabled al salvataggio.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            value={whitelistText}
            onChange={e => { setWhitelistText(e.target.value); setWhitelistDirty(true); }}
            rows={8}
            className="font-mono text-sm"
            placeholder="1.2.3.4&#10;5.6.7.0/24"
            disabled={!isAdmin}
          />
          {isAdmin && (
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={() => whitelistMutation.mutate()}
                disabled={whitelistMutation.isPending}
              >
                {whitelistMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
                Salva whitelist
              </Button>
            </div>
          )}
          {whitelistSyncResult && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>VPS</TableHead>
                  <TableHead>Esito</TableHead>
                  <TableHead>Dettaglio</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {whitelistSyncResult.syncResults.map(r => (
                  <TableRow key={r.vpsId}>
                    <TableCell className="font-mono text-xs">{r.vpsName}</TableCell>
                    <TableCell>
                      {r.success
                        ? <Badge className="bg-green-600 text-white">OK</Badge>
                        : <Badge className="bg-destructive text-white">Errore</Badge>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.error || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

```

- [ ] **Step 5: Type-check e build frontend**

```bash
cd /home/massimo/Progetti/ProxyGuardian && npm run check
```

Expected: nessun errore TypeScript.

```bash
cd /home/massimo/Progetti/ProxyGuardian && npx vite build --mode development 2>&1 | tail -20
```

Expected: build completata senza errori (`✓ built in ...`).

- [ ] **Step 6: Verifica visuale manuale**

```bash
cd /home/massimo/Progetti/ProxyGuardian && npm run dev
```

Apri il browser su `http://localhost:5000/anti-iptv`, fai login come admin, verifica:
- La Card "Whitelist" appare sotto la Card "Stato fleet".
- La textarea mostra il contenuto di `scripts/iptv-whitelist.txt`.
- Scrivendo un IP non valido e salvando, appare un toast di errore rosso con il messaggio dal server.
- Scrivendo `1.2.3.4` e salvando, appare un toast con il conteggio successi/errori e la tabella risultati per-VPS sotto la textarea.

Ferma il server dev prima di procedere.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/anti-iptv-management.tsx
git commit -m "feat: UI whitelist fleet-wide in pagina Anti-IPTV"
```

---

### Task 5: Deploy fleet-wide

**Files:** nessuno (solo operazioni git + deploy, stesso procedimento già usato in questa sessione per gli altri fix agent)

**Interfaces:**
- Consumes: tutti i commit dei Task 1-4, già pushati su `main`.

- [ ] **Step 1: Push su GitHub**

```bash
cd /home/massimo/Progetti/ProxyGuardian && git push origin main
```

- [ ] **Step 2: Aggiorna il checkout sul dashboard di produzione**

```bash
ssh root@185.229.236.50 'cd /root/proxy-dashboard && git pull'
```

Expected: `Fast-forward` con i file di questo piano elencati.

- [ ] **Step 3: Rebuild e restart del dashboard (serve il nuovo bundle server con le route fleet)**

```bash
ssh root@185.229.236.50 'cd /root/proxy-dashboard && npm run build && pm2 restart proxy-dashboard'
```

Expected: build completata, `pm2 restart` conferma il processo riavviato.

- [ ] **Step 4: Push del bundle agent aggiornato su ogni VPS enabled**

Dal dashboard (ha già l'elenco VPS + api key in `data/vps.json`):

```bash
ssh root@185.229.236.50 '
cd /root/proxy-dashboard
python3 -c "
import json
data = json.load(open(\"data/vps.json\"))
for v in data:
    if v.get(\"enabled\"):
        print(v[\"id\"] + \"|\" + v[\"name\"] + \"|\" + v[\"host\"] + \"|\" + v[\"apiKey\"])
" > /tmp/deploy_vps_list.txt
success=0; fail=0
while IFS="|" read -r id name host key; do
  result=$(curl -s -m 15 -X POST "http://$host:3001/api/agent/update" -H "x-api-key: $key" -H "Content-Type: application/octet-stream" --data-binary @/root/proxy-dashboard/agent/agent-bundle.js)
  if echo "$result" | grep -q "\"ok\":true"; then success=$((success+1)); else fail=$((fail+1)); echo "FAIL: $name -> $result"; fi
done < /tmp/deploy_vps_list.txt
echo "TOTALE: success=$success fail=$fail"
'
```

Expected: la maggior parte dei VPS risponde `success`. VPS noti come temporaneamente instabili (verificare con l'utente quali al momento del deploy) potrebbero fallire — rilanciare la stessa chiamata solo per quelli falliti dopo qualche secondo.

- [ ] **Step 5: Verifica end-to-end su un VPS reale**

Scegli un VPS enabled raggiungibile (es. quello usato per gli ultimi test in questa sessione) e verifica che l'endpoint agent risponda:

```bash
ssh root@185.229.236.50 '
curl -s -X POST "http://<NETBIRD_IP_VPS>:3001/api/anti-iptv/whitelist" \
  -H "x-api-key: <API_KEY_VPS>" -H "Content-Type: application/json" \
  -d "{\"entries\":[\"1.2.3.4\",\"5.6.7.0/24\"]}"
'
```

Expected: `{"ok":true,"count":2}`

Poi verifica che l'ipset sia stato effettivamente popolato:

```bash
ssh root@185.229.236.50 '
curl -s "http://<NETBIRD_IP_VPS>:3001/api/ipset/iptv_whitelist" -H "x-api-key: <API_KEY_VPS>"
'
```

Expected: risposta con `"count":2` e i due membri `1.2.3.4` e `5.6.7.0/24`.

- [ ] **Step 6: Verifica dalla dashboard di produzione**

Apri `https://<dominio-dashboard>/anti-iptv` (o l'IP del dashboard sulla porta 5000/443 a seconda della config), fai login, apri la Card "Whitelist", inserisci gli stessi due valori di test, salva, e conferma che la tabella risultati mostri successo sul VPS scelto per il test.

- [ ] **Step 7: Pulizia dati di test**

Se hai aggiunto `1.2.3.4`/`5.6.7.0/24` solo per il test, sostituisci il contenuto della whitelist dalla UI con il contenuto reale desiderato (o vuoto) e salva di nuovo, per non lasciare voci di test in produzione.

---

## Self-Review

**Copertura spec:**
- Storage centrale `scripts/iptv-whitelist.txt` → Task 3, Step 1. ✓
- Validazione IP/CIDR (ottetti 0-255, prefisso 0-32) → Task 1 (agent) e Task 3 (server, difesa in profondità). ✓
- Sync sincrono via chiamata diretta all'agent, nessun watcher → Task 3 Step 2 (`bulkPost` diretto), Task 1 Step 3 (endpoint agent). ✓
- Persistenza ipset via `ipset save` + riuso `ipset-restore.service` → Task 1 Step 3. ✓
- UI: textarea + bottone salva + tabella risultati per-VPS, solo admin → Task 4. ✓
- Deploy fleet-wide → Task 5. ✓

**Scan placeholder:** nessun TBD/TODO nel piano; ogni step ha codice completo o comando esatto con output atteso.

**Coerenza tipi:** `isValidIpOrCidr` ha la stessa firma e stessa logica in Task 1 (agent, sintassi `var`/node12-safe) e Task 3 (server, sintassi `const`/moderna — il server non ha il vincolo node12). `WhitelistResponse`/`WhitelistSyncResult` in Task 4 matchano esattamente la forma di risposta prodotta in Task 3 (`{ ok, content, syncResults }` con `syncResults` che è un `BulkResult[]` — stessa forma di `vpsId/vpsName/success/data/error` già usata da `ParamsResult` in questo stesso file).
