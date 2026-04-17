# ProxyGuardian

Dashboard di sicurezza centralizzata per la gestione di flotte multi-VPS con Nginx, Fail2ban e MariaDB. Progettata per ambienti connessi tramite rete **NetBird** (WireGuard overlay).

---

## Funzionalità

- **Dashboard** — Fleet overview: stato online/offline di tutti i VPS, servizi attivi, ban totali, connessioni attive porta 8880. Card cliccabili per accesso diretto al dettaglio.
- **VPS Detail** — Pannello per-VPS con tab: Servizi, IP Bannati, Fail2ban Jail, Configurazioni (editor file), Log, Panoramica (mappa ASN), NetBird
- **Servizi** — Tabella VPS × servizi (nginx/fail2ban/mariadb) con azioni bulk e individuali (start/stop/restart/reload) su tutti i VPS contemporaneamente
- **Firewall** — Gestione regole nginx per Paesi, ASN, ISP, User-Agent, IP Whitelist, IP Exclusion. ModSecurity: stato engine, editor config, editor CRS, audit log.
- **ASN Block** — Gestione blocco ASN/IP con aggiornamento liste da BGP, mappa geografica, statistiche. Integrazione ipset per blocchi efficienti.
- **Fail2ban** — Gestione jail (banTime/maxRetry/findTime), editor filtri `filter.d`, editor `jail.local` / `fail2ban.local`. Bulk su tutti i VPS.
- **Log** — Visualizzatore log per VPS (nginx access/error, fail2ban, syslog) con ricerca e filtro real-time con evidenziazione
- **Ricerca** — Ricerca cross-VPS: IP bannati aggregati da tutti i VPS con unban diretto; ricerca grep nei log su tutti i VPS simultaneamente
- **Gestione VPS** — Aggiunta, modifica, eliminazione VPS. Health check automatico.
- **Gestione Utenti** — Multi-utente con ruoli RBAC (Admin / Operator / Viewer)
- **Fleet Upgrade** — Deploy aggiornamento nginx + moduli su tutti i VPS da dashboard, con verifica versioni e log in real-time
- **Fleet Config** — Verifica ottimizzazione nginx su tutta la fleet (6 fingerprint), deploy config standardizzata con un click, installazione chiave SSH per Fleet Upgrade

---

## Architettura

```
ProxyGuardian/
├── client/          # React + Vite (frontend dashboard)
├── server/          # Express API (backend dashboard)
│   └── nginx-template.conf  # Config nginx ottimizzata per proxy IPTV
├── agent/           # Agent standalone per VPS remoti
└── shared/          # Schema condivisi (Zod)
```

### Flusso dati

```
Browser → Dashboard (Express :5000) → Agent (:3001) su ogni VPS proxy
                                    ↓
                         /api/vps/:id/proxy/*     (singolo VPS)
                         /api/vps/bulk/get        (lettura da tutti)
                         /api/vps/bulk/post       (scrittura su tutti)
                         /api/fleet/nginx/status  (verifica ottimizzazione)
                         /api/fleet/nginx/apply   (deploy config fleet)
```

### Dashboard (client + server)

- **Frontend**: React 18, Vite, TailwindCSS, shadcn/ui, TanStack React Query, Wouter
- **Backend**: Express, TypeScript, persistenza JSON (`data/vps.json`)
- **Auth**: Sessioni con cookie, ruoli RBAC

### Agent VPS (`agent/`)

Processo Node.js standalone da installare su ogni VPS proxy. Espone un'API REST autenticata via `x-api-key`. Gira come utente di sistema `pgagent` con permessi sudoers limitati.

**Versione corrente: v1.3.2**

**Endpoint API agent:**

| Metodo | Path | Descrizione |
|--------|------|-------------|
| `GET` | `/health` | Ping / stato agent |
| `GET` | `/api/services` | Stato nginx, fail2ban, mariadb |
| `POST` | `/api/services/:name/action` | start / stop / restart / reload |
| `GET` | `/api/banned-ips` | IP bannati da fail2ban |
| `POST` | `/api/unban` | Sblocca IP specifico |
| `POST` | `/api/unban-all` | Sblocca tutti gli IP |
| `GET` | `/api/stats` | Connessioni attive, ban totali |
| `GET` | `/api/logs/:type` | Log nginx/fail2ban/syslog (`?lines=N`) |
| `GET` | `/api/grep` | Ricerca grep nei log (`?q=term&type=logtype`) |
| `GET` | `/api/system` | CPU, RAM, disco, uptime |
| `GET/POST` | `/api/config/:filename` | Leggi/scrivi file di configurazione |
| `POST` | `/api/nginx/test` | `nginx -t` |
| `POST` | `/api/nginx/reload` | `nginx -t && systemctl reload nginx` |
| `GET` | `/api/fail2ban/jails` | Lista jail attive con parametri |
| `POST` | `/api/fail2ban/jails/:name` | Aggiorna banTime/maxRetry/findTime |
| `GET` | `/api/fail2ban/filters` | Lista nomi filtri in `filter.d/` |
| `GET` | `/api/fail2ban/filters/:name` | Leggi contenuto filtro |
| `POST` | `/api/fail2ban/filters/:name` | Scrivi filtro + reload fail2ban |
| `POST` | `/api/agent/update` | Aggiorna bundle agent (Fleet Upgrade) |
| `POST` | `/api/system/install-ssh-key` | Installa chiave SSH pubblica in authorized_keys |
| `POST` | `/api/system/setup-nginx-dirs` | Crea directory cache nginx |
| `POST` | `/api/system/update-sudoers` | Aggiorna regole sudoers |
| `GET` | `/api/system/sudoers-status` | Verifica regole sudoers presenti |

**File di configurazione supportati (`/api/config/:filename`):**

| File | Path |
|------|------|
| `nginx.conf` | `/etc/nginx/nginx.conf` |
| `jail.local` | `/etc/fail2ban/jail.local` |
| `fail2ban.local` | `/etc/fail2ban/fail2ban.local` |
| `country_whitelist.conf` | `/etc/nginx/country_whitelist.conf` |
| `block_asn.conf` | `/etc/nginx/block_asn.conf` |
| `block_isp.conf` | `/etc/nginx/block_isp.conf` |
| `useragent.rules` | `/etc/nginx/useragent.rules` |
| `ip_whitelist.conf` | `/etc/nginx/ip_whitelist.conf` |
| `exclusion_ip.conf` | `/etc/nginx/exclusion_ip.conf` |

---

## Installazione

### 1. Dashboard

```bash
git clone https://github.com/perfido19/ProxyGuardian.git
cd ProxyGuardian
npm install
npm run build
npm start
```

Con PM2 (raccomandato per produzione):

```bash
npm run build
pm2 start dist/index.js --name proxy-dashboard
pm2 save
pm2 startup
```

La dashboard sarà disponibile su `http://localhost:5000`.

### 2. Agent su VPS remoto

**Prerequisiti:** il VPS deve già avere nginx e fail2ban installati.

**Installazione con un comando (scarica bundle da GitHub):**

```bash
curl -fsSL https://raw.githubusercontent.com/perfido19/ProxyGuardian/main/agent/install.sh | sudo bash
# oppure con API key personalizzata:
curl -fsSL https://raw.githubusercontent.com/perfido19/ProxyGuardian/main/agent/install.sh | sudo AGENT_API_KEY=la-tua-chiave bash
```

Lo script:
1. Installa Node.js 20 se non presente
2. Crea l'utente di sistema `pgagent`
3. Scarica `agent-bundle.js` da GitHub e lo installa in `/opt/proxy-guardian-agent/`
4. Configura i permessi sudoers completi (nginx, fail2ban, mariadb, netbird, SSH, cache dirs)
5. Imposta i permessi su `/etc/nginx/nginx.conf` per Fleet Config
6. Installa e avvia il servizio systemd `proxy-guardian-agent`

**Aggiungi il VPS nella dashboard:**

Vai su **VPS → Aggiungi VPS** e inserisci:
- **Host**: IP NetBird del VPS (es. `100.116.x.x`) — _non_ l'IP pubblico
- **Porta**: `3001`
- **API Key**: mostrata a fine installazione

---

## Rete NetBird

ProxyGuardian è progettato per operare su rete **NetBird** (WireGuard overlay mesh VPN).

- L'agent si lega automaticamente all'IP NetBird (`100.x.x.x`) se rilevato
- La dashboard deve essere anch'essa sulla stessa rete NetBird per raggiungere gli agent
- Configurare una policy di accesso NetBird che permetta la comunicazione tra dashboard e VPS proxy sulla porta `3001`

---

## Fleet Config — Ottimizzazione nginx

La pagina **Fleet Config** verifica e applica la configurazione nginx ottimizzata su tutta la fleet.

**6 fingerprint verificati:**
1. Cache streaming 50GB (`stream_cache:200m max_size=50g`)
2. ModSecurity attivo (`modsecurity on`)
3. Socket reuseport (`listen 8880 reuseport`)
4. Upstream keepalive 32 (`keepalive 32`)
5. Open file cache (`open_file_cache max=10000`)
6. Proxy buffers 512k (`proxy_buffers 16 512k`)

La configurazione template si trova in `server/nginx-template.conf` ed è ottimizzata per **proxy IPTV/media** su porta 8880 (senza CSP o altri header browser-side che interferirebbero con i player).

---

## Variabili d'ambiente

### Dashboard (`.env`)

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `SESSION_SECRET` | — | Segreto per cookie di sessione (obbligatorio in produzione) |
| `PORT` | `5000` | Porta HTTP dashboard |
| `DATA_DIR` | `./data` | Directory persistenza JSON |
| `NETBIRD_SETUP_KEY` | — | Setup key usata da Deploy VPS per installare/joinare NetBird |
| `DEPLOY_AGENT_GIT_REF` | `main` | Ref GitHub usato da Deploy VPS per scaricare `agent-bundle.js` |

### Agent (`/opt/proxy-guardian-agent/.env`)

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `AGENT_API_KEY` | (generato) | Chiave autenticazione API |
| `AGENT_PORT` | `3001` | Porta HTTP agent |
| `AGENT_BIND` | IP NetBird o `0.0.0.0` | Indirizzo di ascolto |

---

## Migrazione Dashboard

Per spostare il VPS dashboard su una nuova macchina sono disponibili due script in `scripts/`:

```bash
sudo bash scripts/dashboard-backup.sh /root/proxyguardian-dashboard-backup.tar.gz
sudo bash scripts/dashboard-restore.sh /root/proxyguardian-dashboard-backup.tar.gz
```

Il backup include:

- snapshot completo di `/root/proxy-dashboard` esclusi `.git`, `node_modules`, `dist`
- `.env`, `data/`, `asn-block/`, bundle agent e override locali del repo
- file runtime di sistema: nginx, SSL, GeoIP, PM2 dump, chiave SSH dashboard
- manifest, checksum, `git status`, `git diff`, `netbird status`

Note operative:

- `dashboard-backup.sh --include-sessions` include anche `data/sessions`
- `dashboard-restore.sh --dry-run` valida l'archivio senza modificare il server
- NetBird va comunque collegato sul nuovo VPS prima dei test verso gli agent
- La checklist completa di cutover si trova in `DASHBOARD_CUTOVER_CHECKLIST.md`

---

## Gestione servizio agent

```bash
systemctl status proxy-guardian-agent
systemctl restart proxy-guardian-agent
journalctl -u proxy-guardian-agent -f
```

---

## Stack tecnico

| Layer | Tecnologia |
|-------|------------|
| Frontend | React 18, Vite, TailwindCSS v3 |
| UI Components | shadcn/ui, Radix UI |
| State / Fetch | TanStack React Query |
| Router | Wouter |
| Backend | Express, TypeScript |
| Validazione | Zod |
| Agent | Node.js + Express (bundle CJS via ESBuild) |
| VPN | NetBird (WireGuard overlay) |

---

## Licenza

MIT
