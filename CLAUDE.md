# ProxyGuardian — Claude Code Context

## Project Overview
Full-stack dashboard per la gestione di infrastrutture proxy (nginx, fail2ban, MariaDB) su una fleet di VPS connessi via rete **NetBird** (WireGuard mesh). Ogni VPS remoto ha un agent Node.js standalone che espone una REST API autenticata.

## Stack
| Layer | Tecnologia |
|---|---|
| Frontend | React 18 + TypeScript + Vite + TailwindCSS + shadcn/ui |
| Backend | Express.js + TypeScript (porta 5000) |
| Persistenza | JSON file (`data/vps.json`) — nessun database |
| Agent remoto | Node.js + Express standalone (porta 3001, su ogni VPS) |
| Rete | NetBird mesh WireGuard (IP range 100.x.x.x) |
| Auth | Cookie session + ruoli RBAC (admin / operator / viewer) |
| Validazione | Zod (schemi in `shared/schema.ts`) |
| Build agent | ESBuild → `agent/agent-bundle.js` |
| Deploy dashboard | PM2 su VPS dashboard in `/root/proxy-dashboard/` |

## Struttura Reale del Progetto
```
ProxyGuardian/
├── CLAUDE.md
├── .env                          ← secrets (SESSION_SECRET, PORT, DATA_DIR)
├── client/                       ← React + Vite (frontend)
│   └── src/
│       ├── App.tsx               ← routing (Wouter)
│       ├── components/           ← shadcn/ui + custom (app-sidebar, loading-state)
│       ├── hooks/                ← use-auth, use-vps, use-toast, use-mobile
│       ├── lib/                  ← queryClient, apiRequest
│       └── pages/
│           ├── dashboard.tsx     ← fleet overview, stats per VPS
│           ├── services.tsx      ← stato nginx/fail2ban/mariadb, bulk actions
│           ├── fail2ban-management.tsx ← jail, filtri, configurazioni
│           ├── firewall.tsx      ← paesi, ASN, ISP, user-agent, IP whitelist/exclusion
│           ├── logs.tsx          ← visualizzatore log real-time
│           ├── ricerca.tsx       ← ricerca IP bannati + grep log cross-VPS
│           ├── vps-detail.tsx    ← pannello per-VPS (5 tab)
│           ├── vps-manager.tsx   ← gestione VPS (add/edit/delete)
│           ├── ip-investigator.tsx ← analisi cross-fleet IP (log, username, ban)
│           └── user-management.tsx ← gestione utenti
├── server/                       ← Express API
│   ├── index.ts                  ← entry point, middleware, logging
│   ├── routes.ts                 ← tutti gli endpoint REST
│   ├── auth.ts                   ← sessioni, RBAC
│   ├── storage.ts                ← lettura/scrittura data/vps.json
│   ├── vps-manager.ts            ← proxy calls agli agent remoti, bulk ops
│   └── vite.ts                   ← serve frontend in dev/prod
├── agent/                        ← Agent standalone per VPS remoti
│   ├── index.ts                  ← sorgente TypeScript
│   ├── agent-bundle.js           ← bundle ESBuild (committato nel repo)
│   ├── install.sh                ← script installazione curl|bash
│   └── package.json
├── shared/
│   └── schema.ts                 ← schemi Zod condivisi frontend/backend
└── data/
    └── vps.json                  ← persistenza VPS (non committato)
```

## Architettura — Concetti Chiave

### Dashboard ↔ Agent
- Il server Express fa da **proxy/orchestrator**: riceve richieste dal frontend e le inoltra agli agent
- Endpoint proxy: `GET/POST /api/vps/:id/proxy/*` → forwarda al VPS corrispondente
- Bulk operations: `POST /api/vps/bulk/get` e `POST /api/vps/bulk/post` → parallelizza su tutti i VPS
- Ogni VPS ha: `{ id, name, host, port, apiKey }` persistito in `data/vps.json`
- Connessioni misurate sulla **porta 8880** (proxy squid)

### Auth
- Cookie session con `express-session`
- Ruoli: `admin` > `operator` > `viewer`
- Credenziali default configurabili via `.env`

### Agent VPS
- Autenticazione: header `x-api-key` o `Authorization: Bearer <key>`
- Si lega all'IP NetBird (`100.x.x.x`) se rilevato, altrimenti `0.0.0.0`
- Installazione: `curl -fsSL .../agent/install.sh | sudo bash`
- Service systemd: `proxy-guardian-agent` come utente `pgagent`
- Sudoers: wildcard su `systemctl status *`, `fail2ban-client *`, `nginx -t`

## Regole di Sviluppo

### Generale
- TypeScript ovunque — minimizzare `any`
- Variabili d'ambiente sempre in `.env`, mai hardcoded
- Nessun database — la persistenza è solo `data/vps.json` via `server/storage.ts`

### Frontend
- Componenti shadcn/ui come base UI — non reinventare primitive
- Stato server tramite **TanStack React Query** — no stato globale complesso
- Chiamate API tramite `apiRequest` da `lib/queryClient.ts`
- Hook centralizzati in `hooks/` (es. `useVpsList`, `useVpsHealth`)
- Routing con **Wouter** (non React Router)

### Backend
- Tutta la logica in `server/routes.ts` e `server/vps-manager.ts`
- Proxy agli agent via `vps-manager.ts` — non chiamare agent direttamente dalle route
- Validazione input con schemi Zod da `shared/schema.ts`

### Agent
- Codice minimale e autonomo — nessuna dipendenza dal server centrale
- **Requisito runtime: Node.js 12+** — il bundle è compilato con `--target=node12`; non usare `??` o `?.` nel sorgente (sostituire con `||` e `&&`)
- Ogni modifica a `agent/index.ts` richiede rebuild: `cd agent && npm run build`
- Il bundle `agent-bundle.js` va committato dopo ogni rebuild
- Dopo push, aggiornare il VPS: `git pull && npm run build && pm2 restart proxy-dashboard`

## Workflow Git
- Branch unico: `main`
- Push tramite token GitHub o GitHub Desktop
- Deploy automatico: SSH su `185.229.236.50` → `git pull + npm run build + pm2 restart`
- Commit message format: `feat:`, `fix:`, `chore:` + descrizione breve

## Memoria Operativa
- `Deploy VPS` in `client/src/pages/deploy-vps.tsx` espone due checkbox:
  - `installAsnBlock` default `true`
  - `installAntiIptv` default `false`
- Il copy corrente sotto Anti-IPTV e`: `Selezione per installare lo script anti-IPTV.`
- Il deploy non deve evidenziare i nomi dei VPS che "contengono" ASN Block o Anti-IPTV.
- La logica server in `server/routes.ts` genera uno script di deploy che, se richiesto:
  - installa stack AsnBlock completo dai file in `scripts/`
  - installa stack Anti-IPTV completo dai file in `scripts/`
  - copia anche `agent/asn-log-stats.py` sul VPS nuovo
- Deploy VPS: `main.netbird.cloud:8880` resta l'upstream backend. Lo script deve connettere NetBird prima del primo `nginx -t`, poi risolvere `main.netbird.cloud` dalla network map NetBird e scriverlo in `/etc/hosts`.
- Deploy VPS: Fail2Ban deve installare il template Dynadoctor da `scripts/fail2ban/jail.local` e i filtri `404-0`, `block22`, `nginx-abuse`, `xtream`, `xtream-api`.
- Deploy VPS: ASN Block usa le liste fleet in `asn-block/asn-blocklist.txt` e `asn-block/asn-whitelist.txt`, gli script ASN in `scripts/`, e installa/allinea `maxminddb==2.6.3`.
- Deploy VPS: i file nginx fleet `asn-block/country_whitelist.conf`, `asn-block/block_asn.conf`, `asn-block/block_isp.conf` devono restare allineati a `dynadoctor`; `secucam` e `PROJECT.GA` sono stati sincronizzati live con checksum identici il 2026-05-03. La whitelist paese vuota causa `403` su link `/get.php` da paesi non autorizzati.
- ASN Block dashboard: la sorgente operativa modificabile e' `asn-block/asn-blocklist.txt`; il tab `ASN Block` -> `Blocklist ASN` salva il file centrale, lo copia su tutti i VPS abilitati e rigenera `blocked_asn`.
- ASN Block dashboard: `DynamoXc` e' escluso dagli aggiornamenti fleet della lista ASN da bloccare (`/api/fleet/asn/blocklist` e sync GitHub) perché mantiene una blocklist dedicata.
- Agent: `/api/ipset/:name` deve limitare i membri di default (per `blocked_asn` molto grandi) e `/api/asn/stats` deve usare `asn-log-stats.py --source auto` con fallback `kern`.
- Importante: nuovi deploy scaricano `agent/agent-bundle.js` da GitHub `main`; dopo modifiche agent bisogna committare e pushare il bundle o i nuovi VPS scaricheranno agent vecchio.
- Per dashboard production (`185.229.236.50`, path `/root/proxy-dashboard`) va bene anche un hot deploy manuale: copiare i file cambiati, poi `cd /root/proxy-dashboard && npm run build && pm2 restart proxy-dashboard`.
- Caso reale noto: `dynadoctor` non popolava la mappa ASN perché lo script remoto `asn-log-stats.py` era vecchio e incompatibile con `--source nginx`; fix live gia` applicato.
- **NetBird Update**: sezione in `fleet-config.tsx` per aggiornare la fleet all'ultima versione. Endpoint agent `/api/netbird/version` e `/api/netbird/update`. Route fleet: `GET /api/fleet/netbird/update-status`, `POST /api/fleet/netbird/update`. Sudoers richiede: `apt install --only-upgrade netbird *`. Versione target dinamica da `GET /api/fleet/netbird/latest-version` (GitHub releases API, cache 1h, fallback `0.73.1`).
- **NetBird fix boot loop**: su tutta la fleet aggiunto `100.116.117.155 main.netbird.cloud` in `/etc/hosts` e dropin systemd `sleep 10 && systemctl restart nginx || true` — evita loop netbird se tunnel non ancora su al boot.
- **IP Investigator**: pagina `/ip-investigator` — input IP → analisi cross-fleet (grep log + ipset ban check in parallelo su tutti i VPS). Tre endpoint fleet: `POST /api/fleet/ip-investigate`, `POST /api/fleet/ip-ban`, `POST /api/fleet/ip-unban`. Il ban check è **sempre** eseguito indipendentemente dai log (log ruotati → mostra "solo ban"). Agent `/api/grep` restituisce `{ entries: [{id, level, message}] }` — campo corretto è `entries[].message`.
- **Anti-IPTV soglia**: `MAX_USERNAME=4` (portato a 4 il 2026-07-02, era 3 dal 2026-06-28, era 2 dal 2026-06-20) su 52/53 VPS proxy (DynamoXc escluso). Due varianti script: bash (`/usr/local/sbin/anti-iptv.sh`, 47 VPS, valore diretto nella variabile) e python (`/usr/local/sbin/anti-iptv.py`, 5 VPS: Smarters, gruppo1 salerno, PROJECT.GA, gruppo3 salerno, Secucam — valore nel default hardcoded `os.environ.get("MAX_USERNAME", "N")`, nessun override env nel systemd unit). DynamoXc: NON installato, skippa sempre. Fix 2026-06-28: dropin `whitelist-netbird.conf` corretto su 5 VPS (bug `||` mancante causava crash loop anti-iptv); dropin aggiunto su 4 VPS che ne erano privi.
- **Anti-IPTV main backend** (80.244.4.35): **DISABILITATO** — `anti-iptv.service` inactive/disabled (fermo dal 2026-06-21, verificato live 2026-07-02), ipset `iptv_ban` 0 entries, non riabilitare senza conferma esplicita. Config residua: `MAX_USERNAME=6` (inerte), script Python `/usr/local/sbin/anti-iptv.py`, LOGFILE=`/home/xtreamcodes/iptv_xtream_codes/logs/main.access.log`. Chain `ANTI_IPTV` presente in INPUT pos 9 ma inoffensiva (ipset vuoto). Fleet proxy VPS (52/53, esclude DynamoXc): `MAX_USERNAME=4` dal 2026-07-02.
- **BanSync interval**: 60s (era 5min). Configurato in `startBanSyncPoller(60000)` in `server/routes.ts`.
- **nginx rate limiting fleet**: zona `auth_slow` (`25r/m`, chiave `$auth_key`) nell'`http {}` block + `limit_req zone=auth_slow burst=10 nodelay` nel location `player_api.php|get.php|xmltv.php` su tutti i 53 VPS. Chiave `$auth_key` è vuota per richieste EPG (`get_short_epg`, `get_simple_data_table`) → escluse dal rate limit. Zona esistente `login_api` (1r/s) rimane. Verificato e deployato 2026-07-01.
- **NetBird P2P fleet (2026-06-28)**: tutti i 53 VPS aggiornati con `iptables -I INPUT 1 -p udp --dport 51820 -j ACCEPT` + `iptables-save > /etc/iptables/rules.v4`. Senza questa regola il WireGuard handshake in ingresso veniva droppato dal DROP finale e NetBird cadeva su relay (latenza 390ms+). Con il fix: 56/56 peer P2P diretti (0 relay). **Critico: la regola deve essere a posizione 1 (prima del DROP); se inserita con `-A` finisce dopo il DROP ed è inutile. Il dashboard VPS stesso (185.229.236.50) deve avere la regola — fix applicato 2026-06-28. Ogni nuovo VPS deployato deve riceverla.**
- **CrowdSec bouncer reboot fix (2026-06-28)**: dropin `/etc/systemd/system/crowdsec-firewall-bouncer.service.d/wait-lapi.conf` su Secucam, PROJECT.GA, DynamoXc. Aspetta max 150s che la LAPI (100.116.132.180:8080) sia raggiungibile via NetBird prima di avviare il bouncer. Senza questo, al reboot il bouncer parte senza bans perché NetBird non ha ancora stabilito il tunnel.
- **VPS 9.6GB disk (gruppo "rob" e alcuni "merc")**: disco si riempie per journal (`/var/log/journal`) e log xtreamcodes (`/opt/log/YYYYMMDD`). Pulizia periodica: `journalctl --vacuum-size=80M` e `find /opt/log -maxdepth 1 -type d -name "2026*" -mtime +30 -exec rm -rf {} +`.

## Endpoint Agent — Riferimento Rapido
| Metodo | Path | Descrizione |
|---|---|---|
| GET | `/health` | Ping, hostname, timestamp |
| GET | `/api/services` | Stato nginx/fail2ban/mariadb |
| POST | `/api/services/:name/action` | start/stop/restart/reload |
| GET | `/api/banned-ips` | IP bannati da fail2ban |
| POST | `/api/unban` | Sblocca IP da jail |
| POST | `/api/unban-all` | Sblocca tutti gli IP |
| GET | `/api/stats` | Connessioni porta 8880, ban attivi |
| GET | `/api/logs/:type` | nginx_access/nginx_error/fail2ban/system |
| GET | `/api/grep` | Ricerca nei log con query sanitizzata |
| GET | `/api/system` | CPU, RAM, disco, uptime |
| GET/POST | `/api/config/:filename` | Leggi/scrivi file config nginx/fail2ban |
| GET | `/api/fail2ban/jails` | Lista jail con parametri |
| POST | `/api/fail2ban/jails/:name` | Modifica parametri jail |
| GET | `/api/fail2ban/filters` | Lista filter.d |
| GET/POST | `/api/fail2ban/filters/:name` | Leggi/scrivi filtro |
| POST | `/api/nginx/test` | nginx -t |
| POST | `/api/nginx/reload` | test + reload nginx |
| GET | `/api/netbird/version` | Versione NetBird installata |
| POST | `/api/netbird/update` | Aggiorna NetBird all'ultima versione |
| GET | `/api/ipset/:name` | Membri ipset (default limit, per blocked_asn grandi) |
| POST | `/api/ipset/:name/add` | Aggiunge IP a ipset (usato da BanSync per iptv_ban) |

## Do NOT
- Non committare `.env` o `data/vps.json`
- Non esporre agent su IP pubblici — solo NetBird o con firewall
- Non modificare `server/auth.ts` senza conferma esplicita
- Non dimenticare il rebuild di `agent-bundle.js` dopo modifiche all'agent
- Non usare `npm install` senza verificare le dipendenze già presenti
