# ProxyGuardian

Dashboard di sicurezza centralizzata per la gestione di flotte multi-VPS con Nginx, Fail2ban e MariaDB. Progettata per ambienti connessi tramite rete **NetBird** (WireGuard overlay).

---

## Funzionalità

- **Dashboard** — Fleet overview: stato online/offline di tutti i VPS, servizi attivi, ban totali, connessioni attive. Card cliccabili per accesso diretto al dettaglio.
- **VPS Detail** — Pannello per-VPS con 5 tab: Servizi, IP Bannati, Fail2ban Jail, Configurazioni (editor file), Log (4 tipi)
- **Servizi** — Tabella VPS × servizi (nginx/fail2ban/mariadb) con azioni bulk e individuali (start/stop/restart/reload) su tutti i VPS contemporaneamente
- **Firewall** — Gestione regole nginx per Paesi, ASN, ISP, User-Agent, IP Whitelist, IP Exclusion. Legge dal primo VPS online, applica su tutti.
- **Fail2ban** — Gestione jail (banTime/maxRetry/findTime), editor filtri `filter.d`, editor `jail.local` / `fail2ban.local`. Bulk su tutti i VPS.
- **Log** — Visualizzatore log per VPS (nginx access/error, fail2ban, syslog) con ricerca e filtro real-time con evidenziazione
- **Ricerca** — Ricerca cross-VPS: IP bannati aggregati da tutti i VPS con unban diretto; ricerca grep nei log su tutti i VPS simultaneamente
- **Gestione VPS** — Aggiunta, modifica, eliminazione VPS. Health check automatico.
- **Gestione Utenti** — Multi-utente con ruoli RBAC (Admin / Operator / Viewer)

---

## Architettura

```
ProxyGuardian/
├── client/          # React + Vite (frontend dashboard)
├── server/          # Express API (backend dashboard)
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
```

### Dashboard (client + server)

- **Frontend**: React 18, Vite, TailwindCSS, shadcn/ui, TanStack React Query, Wouter
- **Backend**: Express, TypeScript, persistenza JSON (`data/vps.json`)
- **Auth**: Sessioni con cookie, ruoli RBAC

### Agent VPS (`agent/`)

Processo Node.js standalone da installare su ogni VPS proxy. Espone un'API REST autenticata via `x-api-key`. Gira come utente di sistema `pgagent` con permessi sudoers limitati.

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

**Formati file firewall nginx:**
```
# country_whitelist.conf
IT yes; # Italy

# block_asn.conf
8075 1; # MICROSOFT-CORP-MSN-AS-BLOCK

# block_isp.conf
"~*DigitalOcean" 1;
"Exact ISP Name" 1;

# useragent.rules
~*malicious 1;

# ip_whitelist.conf  (rate limit exclusion)
10.0.0.1 0;

# exclusion_ip.conf  (geo block exclusion)
10.0.0.0/24 1;
```

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

**Prerequisiti:** il VPS deve già avere nginx e fail2ban installati. L'agent deve essere compilato prima dell'installazione.

**Passo 1 — Compila il bundle:**

```bash
git clone https://github.com/perfido19/ProxyGuardian.git
cd ProxyGuardian/agent
npm install
npm run build   # genera agent-bundle.js
```

**Passo 2 — Installa:**

```bash
sudo bash install.sh
# oppure con API key personalizzata:
sudo AGENT_API_KEY=la-tua-chiave bash install.sh
```

Lo script:
1. Crea l'utente di sistema `pgagent`
2. Copia `agent-bundle.js` in `/opt/proxy-guardian-agent/index.js`
3. Configura i permessi sudoers per nginx/fail2ban/mariadb (con wildcard per tutti i flag)
4. Installa e avvia il servizio systemd `proxy-guardian-agent`
5. Scrive la configurazione in `/opt/proxy-guardian-agent/.env`

**Passo 3 — Aggiungi il VPS nella dashboard:**

Vai su **VPS → Aggiungi VPS** e inserisci:
- **Host**: IP NetBird del VPS (es. `100.116.x.x`) — _non_ l'IP pubblico
- **Porta**: `3001`
- **API Key**: mostrata a fine installazione

---

## Rete NetBird

ProxyGuardian è progettato per operare su rete **NetBird** (WireGuard overlay mesh VPN).

- L'agent si lega automaticamente all'IP NetBird (`100.x.x.x`) se rilevato
- La dashboard deve essere anch'essa sulla stessa rete NetBird per raggiungere gli agent
- Configurare una policy di accesso NetBird che permetta la comunicazione tra dashboard e VPS proxy

---

## Variabili d'ambiente

### Dashboard (`.env`)

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `SESSION_SECRET` | — | Segreto per cookie di sessione (obbligatorio in produzione) |
| `PORT` | `5000` | Porta HTTP dashboard |
| `DATA_DIR` | `./data` | Directory persistenza JSON |

### Agent (`/opt/proxy-guardian-agent/.env`)

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `AGENT_API_KEY` | (generato) | Chiave autenticazione API |
| `AGENT_PORT` | `3001` | Porta HTTP agent |
| `AGENT_BIND` | IP NetBird o `0.0.0.0` | Indirizzo di ascolto |

---

## Gestione servizio agent

```bash
systemctl status proxy-guardian-agent
systemctl restart proxy-guardian-agent
journalctl -u proxy-guardian-agent -f
```

---

## Permessi sudoers agent

Il file `/etc/sudoers.d/proxy-guardian-agent` generato dallo script di installazione concede a `pgagent` i permessi NOPASSWD per:

- `systemctl status/start/stop/restart/reload` per nginx, fail2ban, mariadb (con qualsiasi flag)
- `fail2ban-client *` (tutti i sottocomandi)
- `nginx -t` (test configurazione)

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
