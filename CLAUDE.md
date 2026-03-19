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
- Ogni modifica a `agent/index.ts` richiede rebuild: `cd agent && npm run build`
- Il bundle `agent-bundle.js` va committato dopo ogni rebuild
- Dopo push, aggiornare il VPS: `git pull && npm run build && pm2 restart proxy-dashboard`

## Workflow Git
- Branch unico: `main`
- Push tramite token GitHub o GitHub Desktop
- Deploy automatico: SSH su `185.229.236.50` → `git pull + npm run build + pm2 restart`
- Commit message format: `feat:`, `fix:`, `chore:` + descrizione breve

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

## Do NOT
- Non committare `.env` o `data/vps.json`
- Non esporre agent su IP pubblici — solo NetBird o con firewall
- Non modificare `server/auth.ts` senza conferma esplicita
- Non dimenticare il rebuild di `agent-bundle.js` dopo modifiche all'agent
- Non usare `npm install` senza verificare le dipendenze già presenti
