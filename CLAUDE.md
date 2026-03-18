# ProxyGuardian — Claude Code Context

## Project Overview
Full-stack dashboard for managing proxy infrastructure (nginx, fail2ban, MariaDB) across a fleet
of 64 VPS machines connected via NetBird mesh WireGuard network.

## Stack
| Layer | Technology |
|---|---|
| Frontend | React + TypeScript + Shadcn/ui + Tailwind CSS |
| Backend | Express.js (orchestrator, main server) |
| Database | MariaDB |
| Remote Agents | Lightweight Express (port 3001, deployed on each VPS) |
| Network | NetBird mesh WireGuard |
| Auth | Session-based, 3 roles: admin / operator / viewer |

## Project Structure
```
ProxyGuardian/
├── CLAUDE.md
├── .env                        ← secrets, never commit
├── .env.example                ← template senza valori reali
├── frontend/                   ← React + Vite
│   ├── CLAUDE.md
│   ├── src/
│   │   ├── components/         ← Shadcn/ui + custom components
│   │   ├── pages/              ← route-level components
│   │   ├── hooks/              ← custom React hooks
│   │   ├── lib/                ← utilities, api client
│   │   └── types/              ← TypeScript types condivisi
│   └── ...
├── backend/                    ← Express orchestrator
│   ├── CLAUDE.md
│   ├── src/
│   │   ├── routes/             ← endpoint REST
│   │   ├── middleware/         ← auth, logging, error handling
│   │   ├── services/           ← business logic
│   │   ├── db/                 ← MariaDB queries
│   │   └── types/              ← TypeScript types
│   └── ...
└── agent/                      ← Express agent (deployato sui VPS)
    ├── CLAUDE.md
    └── src/
        ├── routes/             ← endpoint agente
        └── middleware/         ← API key auth
```

## Architecture — Key Concepts

### Orchestrator ↔ Agent Communication
- Agenti in ascolto su **porta 3001** su ogni VPS
- Auth tramite **shared API key** nell'header `X-API-Key`
- Comunicazione tramite **NetBird IPs** (non IP pubblici)
- Orchestrator fa poll / call dirette agli agenti per raccogliere metriche e inviare comandi

### Session Auth (Orchestrator)
- Session-based con express-session
- 3 ruoli con permessi crescenti:
  - `viewer` → sola lettura
  - `operator` → operazioni sui proxy, fail2ban
  - `admin` → gestione utenti, configurazioni globali, bulk ops

## Coding Rules

### General
- TypeScript strict mode ovunque — no `any` impliciti
- Variabili d'ambiente → sempre in `.env`, mai hardcoded nel codice
- Ogni secret/config va documentato in `.env.example`
- Nessuna logica business nel layer route → usare services/
- Error handling centralizzato — non try/catch sparsi

### Backend (Express)
- Ogni nuovo endpoint deve:
  1. Validare input con **zod**
  2. Applicare middleware auth con ruolo minimo richiesto
  3. Usare il service layer per la logica
  4. Restituire risposte strutturate `{ success, data, error }`
  5. Aggiornare `backend/src/types/api.ts`
- Mai modificare `middleware/auth.ts` senza conferma esplicita
- Query MariaDB → sempre parametrizzate, mai interpolazione stringa

### Frontend (React)
- Componenti Shadcn/ui come base — non reinventare UI primitives
- Stato globale minimo — preferire React Query per server state
- Tipi condivisi frontend/backend in `types/` sincronizzati
- Nessuna chiamata API diretta nei componenti → usare hooks in `hooks/`

### Agent (VPS)
- Codice minimale e autonomo — l'agente non ha dipendenze dal db centrale
- Ogni operazione esposta (nginx reload, fail2ban ban/unban, etc.) deve loggare localmente
- Validare sempre `X-API-Key` prima di qualsiasi operazione

## Bulk Operations
- Le bulk ops su più VPS devono essere eseguite con **concorrenza limitata** (max 5 parallele)
- Ogni operazione bulk deve restituire un report per VPS: `{ vpsId, success, error }`
- Timeout per singolo agente: **10 secondi**

## Security Rules
- Input sanitization obbligatoria su tutti gli endpoint pubblici
- Rate limiting su login e endpoint agente
- Headers di sicurezza (helmet.js) sul server principale
- Nessun log di secrets, API key o password
- Fail2ban actions via agente → whitelist IP NetBird obbligatoria prima del ban

## Git Workflow
- Branch: `main` (produzione), `dev` (sviluppo)
- Commit message format: `[area] descrizione breve` — es. `[agent] add nginx status endpoint`
- File delivery: Claude genera file con path relativi → Giovanni copia in `ProxyGuardian/` → commit e push

## Common Tasks — Reference

### Aggiungere un endpoint al backend
1. Creare route in `backend/src/routes/`
2. Creare/aggiornare service in `backend/src/services/`
3. Aggiungere schema zod per validazione
4. Aggiornare `backend/src/types/api.ts`
5. Registrare la route in `app.ts`

### Aggiungere un endpoint all'agente
1. Creare route in `agent/src/routes/`
2. Assicurarsi che passi per middleware `X-API-Key`
3. Testare localmente prima del deploy sui VPS

### Deploy agente su nuovo VPS
1. Copiare cartella `agent/` sul VPS
2. Configurare `.env` con API key e NetBird IP
3. Avviare con PM2 o systemd su porta 3001
4. Registrare il VPS nel db orchestrator

## Do NOT
- Non riscrivere `middleware/auth.ts` senza conferma
- Non usare `any` in TypeScript
- Non committare `.env` o file con secrets
- Non esporre endpoint agente su IP pubblici (solo NetBird)
- Non fare query SQL con interpolazione di stringhe
- Non aggiungere dipendenze npm senza valutare alternative già presenti
