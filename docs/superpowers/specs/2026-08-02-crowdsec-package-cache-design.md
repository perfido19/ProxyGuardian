# CrowdSec install da cache pacchetti dashboard — design

## Obiettivo
L'installazione CrowdSec su VPS nuovi si blocca perché l'agent scarica GPG key + repo apt + pacchetti direttamente da `packagecloud.io` *dal VPS target* (`agent/index.ts:2217-2238`), e i VPS nuovi hanno spesso uscita inaffidabile verso quell'host (stesso pattern del problema packagecloud/ASN già risolto altrove — vedi `[[project_iptables_established_related_2026-07-08]]`). Workaround manuale attuale: scaricare i `.deb` sulla dashboard (che raggiunge packagecloud senza problemi) e trasferirli a mano sul VPS. Questo design automatizza quel workaround.

## Scope
- Cache dei pacchetti `.deb` (`crowdsec`, `crowdsec-firewall-bouncer-iptables`) sulla dashboard, scaricata on-demand da un bottone admin (non refresh automatico — la versione CrowdSec non cambia abbastanza spesso da giustificarlo).
- L'endpoint di install esistente (`POST /api/crowdsec/install/:id`, usato sia da Deploy VPS che da fleet già in produzione) usa la cache se presente, altrimenti fallback identico al comportamento attuale (curl+apt da packagecloud sul VPS). Nessun nuovo bottone in UI per l'install stesso.
- Trasferimento pacchetti dashboard→agent via raw `octet-stream`, riusando il pattern già esistente in `agentUpdate` (`server/vps-manager.ts:309`, usato per il push del bundle agent) — non JSON+base64 (overhead +33%, nessun precedente nel codice per payload di questa dimensione).
- Dimensioni reali verificate sulla dashboard: `crowdsec` ~60MB, `crowdsec-firewall-bouncer-iptables` ~4.4MB.

## Fuori scope
- Refresh automatico/programmato della cache.
- Gestione di distro/arch diverse dalla dashboard (assunzione: stessa famiglia Ubuntu/Debian amd64 di tutta la fleet, coerente con lo stato attuale).
- Retry automatico o code di upload — l'install resta un'azione manuale singola per VPS, come oggi.

## Componenti

### Dashboard (server)
- **Cache directory**: `data/crowdsec-packages/` — non committata in git (aggiunta a `.gitignore`), contiene `crowdsec_<versione>.deb`, `crowdsec-firewall-bouncer-iptables_<versione>.deb`, `manifest.json` (`{ version: string, downloadedAt: string }`).
- **`POST /api/crowdsec/packages/refresh`** (`requireAuth`, `requireAdmin`): esegue `apt-get download crowdsec crowdsec-firewall-bouncer-iptables` con cwd in `data/crowdsec-packages/` (richiede che la dashboard abbia il repo packagecloud già configurato — è già così, dato che la LAPI centrale gira lì), sovrascrive i `.deb` esistenti, riscrive `manifest.json`. Timeout lungo (60s, stesso ordine di grandezza di `apt-get update` nell'agent).
- **`GET /api/crowdsec/packages/status`** (`requireAuth`): legge `manifest.json`, risponde `{ cached: boolean, version: string | null, downloadedAt: string | null }` per mostrare stato in UI.
- **`POST /api/crowdsec/install/:id`** modificato:
  1. Legge `manifest.json` dalla cache.
  2. Se presente: per ciascuno dei 2 file, `POST` octet-stream a `agent /api/agent/crowdsec-package` (header `x-package-name: crowdsec|bouncer`), poi chiama `agent /api/crowdsec/install` con body esteso `{ centralLapi, fleetWhitelist, useCache: true }`.
  3. Se assente, o se uno dei due upload fallisce: chiama `agent /api/crowdsec/install` con `{ centralLapi, fleetWhitelist, useCache: false }` (comportamento identico a oggi, nessuna modifica al fallback).
  4. Risposta al frontend invariata nella forma (`{ ok, steps }`).

### Agent
- **`POST /api/agent/crowdsec-package`** (nuovo, `express.raw({ type: "*/*", limit: "80mb" })`, header `x-package-name` obbligatorio): scrive il buffer ricevuto in `/tmp/pg-crowdsec-pkgs/<x-package-name>.deb` (crea la dir se assente). Risponde `{ ok: true }`.
- **`POST /api/crowdsec/install`** modificato: se `req.body.useCache === true` e `/tmp/pg-crowdsec-pkgs/*.deb` esistono entrambi:
  - Salta gli step "import GPG key", "add apt repo", "apt-get update", "apt-get install crowdsec" (righe 2217-2238 attuali).
  - Nuovo step "install da pacchetti cache": `sudo dpkg -i /tmp/pg-crowdsec-pkgs/*.deb 2>&1` seguito da `sudo apt-get install -f -y 2>&1` (risolve dipendenze da repo Ubuntu standard, non da packagecloud).
  - Cleanup: `rm -f /tmp/pg-crowdsec-pkgs/*.deb` dopo install riuscita.
  - Resto del flusso (hub update, collezioni, scenari, whitelist fleet, credenziali LAPI centrale, bouncer key) **invariato**.
  - Se `useCache` falso o file assenti: flusso attuale invariato (curl/gpg/repo/apt-get).

### Sudoers (agent)
Aggiunte a `SUDOERS_CONTENT` (non sostituzioni, stesso file riscritto a ogni run di install/disable/uninstall):
```
pgagent ALL=(ALL) NOPASSWD: /usr/bin/dpkg -i /tmp/pg-crowdsec-pkgs/*.deb
pgagent ALL=(ALL) NOPASSWD: /usr/bin/apt-get install -f -y
```

### Frontend
- `client/src/pages/fleet-config.tsx`, sezione CrowdSec: riga con versione + data cache (da `GET /api/crowdsec/packages/status`) e bottone "Aggiorna pacchetti CrowdSec" → chiama `refresh`. Nessuna modifica al bottone "Installa CrowdSec" per singolo VPS già esistente — usa la cache in automatico.

## Data flow

**Refresh cache (admin, on-demand):**
```
Dashboard: apt-get download crowdsec crowdsec-firewall-bouncer-iptables
  → data/crowdsec-packages/*.deb + manifest.json
```

**Install su VPS (bottone esistente, invariato in UI):**
```
1. Server legge manifest cache
2. Se presente:
   a. POST octet-stream .deb crowdsec  → agent /api/agent/crowdsec-package
   b. POST octet-stream .deb bouncer   → agent /api/agent/crowdsec-package
   c. POST /api/crowdsec/install { ..., useCache: true }
      → agent: dpkg -i /tmp/pg-crowdsec-pkgs/*.deb
        apt-get install -f -y
        [flusso invariato: hub update, collezioni, scenari, whitelist, LAPI, bouncer key]
3. Se assente o upload fallito:
   → POST /api/crowdsec/install { ..., useCache: false }  (comportamento odierno)
```

## Error handling
- **Cache assente/manifest mancante** → fallback silenzioso al metodo attuale. Nessuna regressione per chi non ha mai premuto "refresh".
- **Upload `.deb` fallisce** (timeout/rete) → non si passa a `useCache: true`; si richiama l'install con `useCache: false` (fallback automatico al metodo packagecloud diretto per quel run).
- **`dpkg -i` fallisce** (arch/distro mismatch, conflitto versione) → step marcato `ok:false` con stderr troncato (pattern `addStep` esistente), **nessun fallback automatico a packagecloud** — un errore di pacchetto si ripeterebbe identico anche da remoto; l'admin deve investigare (es. verificare che il VPS target sia stessa famiglia Ubuntu della dashboard).
- **`apt-get install -f -y` fallisce** (dipendenza non risolvibile da repo standard del VPS) → step fallisce, flusso prosegue con gli step successivi già protetti da `|| true` dove già previsto oggi (collezioni/scenari), coerente col comportamento attuale quando `apt-get install crowdsec` fallisce.
- **Cache stale** (versione vecchia) → nessun controllo automatico di età; visibile in UI (data+versione), responsabilità admin decidere se rifare refresh.
- **Race su `/tmp/pg-crowdsec-pkgs/`** tra install concorrenti sullo stesso VPS → non gestito, coerente con altri file temporanei del flusso esistente (es. `/tmp/pg-sudoers-crowdsec`) — accettabile perché l'install è un'azione manuale singola per VPS.

## Testing/rollout
1. `cd agent && npm run build` dopo le modifiche a `agent/index.ts` (nuovo endpoint + install condizionale) — bundle va committato.
2. Hot-deploy dashboard su `185.229.236.50:/root/proxy-dashboard` (copia file, `npm run build && pm2 restart proxy-dashboard`).
3. Premere "Aggiorna pacchetti CrowdSec", verificare `data/crowdsec-packages/` popolata correttamente (2 `.deb` + manifest).
4. Test end-to-end su un VPS reale che oggi si blocca (o su un VPS fleet: `uninstall` poi reinstall da cache) — verificare tutti gli step `ok:true`, servizi `crowdsec`/`crowdsec-firewall-bouncer` attivi, `cscli bouncers list` mostra il bouncer registrato sulla LAPI centrale.
5. Verifica fallback: rinominare temporaneamente `data/crowdsec-packages/`, rilanciare install su un secondo VPS, confermare che passa dal vecchio percorso senza errori; poi ripristinare la cartella.
6. Commit `agent-bundle.js` + sorgenti + bottone frontend, push su `main` (i nuovi VPS deployati scaricano il bundle da GitHub).
7. Nessun rollout fleet-wide forzato necessario — cambiamento retrocompatibile via fallback, si attiva da solo al primo refresh cache.
