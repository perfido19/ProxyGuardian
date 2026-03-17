# ProxyGuardian

Dashboard di sicurezza per la gestione di VPS con Nginx, Fail2ban e ModSecurity. Progettata per ambienti multi-VPS connessi tramite rete **NetBird**.

---

## Funzionalità

- **Dashboard** — Panoramica in tempo reale: ban attivi, connessioni, richieste (24h), andamento temporale dei ban
- **Servizi** — Controllo di nginx, fail2ban, mariadb (start / stop / restart / reload)
- **Firewall** — Gestione regole iptables / nftables
- **Fail2ban** — Visualizzazione e sblocco IP bannati, gestione jail
- **Log** — Visualizzatore log nginx (access/error), fail2ban, sistema
- **Configurazioni** — Editor per file di configurazione nginx e fail2ban
- **Gestione VPS** — Aggiunta, modifica, monitoraggio salute dei VPS remoti
- **VPS Detail** — Pannello per-VPS: servizi, IP bannati, log in tempo reale
- **Bulk Operations** — Azioni di massa su più VPS contemporaneamente
- **Gestione Utenti** — Multi-utente con ruoli (Admin / Operator / Viewer)

---

## Architettura

```
ProxyGuardian/
├── client/          # React + Vite (frontend dashboard)
├── server/          # Express API (backend dashboard)
├── agent/           # Agent standalone per VPS remoti
└── shared/          # Schema condivisi (Zod)
```

### Dashboard (client + server)

- **Frontend**: React 18, Vite, TailwindCSS, shadcn/ui, TanStack React Query, Wouter
- **Backend**: Express, TypeScript, persistenza JSON (`data/vps.json`)
- **Auth**: Sessioni con cookie, ruoli RBAC

### Agent VPS (`agent/`)

Processo Node.js standalone da installare su ogni VPS. Espone un'API REST autenticata via `x-api-key`.

**Endpoint principali:**

| Metodo | Path | Descrizione |
|--------|------|-------------|
| `GET` | `/health` | Ping / stato agent |
| `GET` | `/api/services` | Stato nginx, fail2ban, mariadb |
| `POST` | `/api/services/:name/action` | start / stop / restart / reload |
| `GET` | `/api/banned-ips` | IP bannati da fail2ban |
| `POST` | `/api/unban` | Sblocca IP specifico |
| `POST` | `/api/unban-all` | Sblocca tutti gli IP |
| `GET` | `/api/logs/:type` | Log nginx/fail2ban/system |
| `GET` | `/api/system` | CPU, RAM, disco, uptime |
| `GET/POST` | `/api/config/:filename` | Leggi/scrivi configurazioni |
| `POST` | `/api/nginx/test` | nginx -t |
| `GET` | `/api/fail2ban/jails` | Lista jail attive |

---

## Installazione

### 1. Dashboard

```bash
git clone https://github.com/perfido19/ProxyGuardian.git
cd ProxyGuardian
npm install
cp .env.example .env   # imposta SESSION_SECRET e altre variabili
npm run dev
```

La dashboard sarà disponibile su `http://localhost:5000`.

### 2. Agent su VPS remoto

**Installazione con singolo comando** (richiede sudo):

```bash
curl -fsSL https://raw.githubusercontent.com/perfido19/ProxyGuardian/main/agent/install.sh | sudo bash
```

Oppure con API key personalizzata:

```bash
curl -fsSL https://raw.githubusercontent.com/perfido19/ProxyGuardian/main/agent/install.sh | sudo AGENT_API_KEY=la-tua-chiave bash
```

Lo script:
1. Installa Node.js 20 se non presente
2. Crea l'utente di sistema `pgagent`
3. Configura i permessi sudoers per nginx/fail2ban/mariadb
4. Scarica e installa `agent-bundle.js` come servizio systemd
5. Genera una API key casuale (se non fornita) e la mostra a schermo

Al termine, aggiungere il VPS nella dashboard con IP NetBird, porta e API key.

#### Build manuale dell'agent

```bash
cd agent
npm install
npm run build   # genera agent-bundle.js
```

---

## Rete NetBird

ProxyGuardian è progettato per operare su rete **NetBird** (WireGuard overlay). L'agent si lega automaticamente all'IP NetBird (`100.x.x.x`) se rilevato, altrimenti ascolta su `0.0.0.0` (proteggere la porta con firewall).

---

## Variabili d'ambiente

### Dashboard (`.env`)

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `SESSION_SECRET` | — | Segreto per cookie di sessione |
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

## Stack tecnico

| Layer | Tecnologia |
|-------|------------|
| Frontend | React 18, Vite, TailwindCSS v3 |
| UI Components | shadcn/ui, Radix UI |
| State / Fetch | TanStack React Query |
| Router | Wouter |
| Backend | Express, TypeScript |
| Validazione | Zod |
| Agent | Node.js + Express (bundle ESBuild) |
| Fonts | Chakra Petch, DM Sans, JetBrains Mono |

---

## Licenza

MIT
