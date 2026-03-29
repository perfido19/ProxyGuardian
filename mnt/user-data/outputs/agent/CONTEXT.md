# Agent — Lightweight Express (VPS Node)

## Ruolo
Processo leggero deployato su ogni VPS. Espone operazioni locali all'orchestrator via HTTP.
Nessuna dipendenza dal database centrale — completamente autonomo.

## Stack
- Express.js + TypeScript (minimal)
- Porta: **3001**
- Binding: solo su NetBird IP (non 0.0.0.0)

## Auth
- Ogni richiesta deve avere header `X-API-Key: <shared_secret>`
- Middleware `validateApiKey` obbligatorio su tutte le route — non bypassare mai
- API key letta da `.env` — mai hardcoded

## Operazioni esposte (riferimento)
| Endpoint | Metodo | Ruolo minimo | Descrizione |
|---|---|---|---|
| `/nginx/status` | GET | viewer | Stato nginx |
| `/nginx/reload` | POST | operator | Reload nginx |
| `/nginx/test` | POST | operator | Test config nginx |
| `/fail2ban/status` | GET | viewer | Stato fail2ban |
| `/fail2ban/ban` | POST | operator | Ban IP |
| `/fail2ban/unban` | POST | operator | Unban IP |
| `/system/metrics` | GET | viewer | CPU, RAM, disco |
| `/health` | GET | - | Health check |

## Regole implementazione
- Ogni operazione deve **loggare localmente** prima e dopo l'esecuzione
- Comandi shell eseguiti con `child_process.execFile` (mai `exec` con interpolazione)
- Timeout comandi: 5 secondi
- Risposta formato: `{ success: boolean, data?: any, error?: string }`

## fail2ban — sicurezza critica
- Prima di qualsiasi ban → verificare che l'IP non sia nella whitelist NetBird
- Whitelist hardcoded in `config/whitelist.ts` + da env `WHITELIST_IPS`
- Ban accidentale di un NetBird IP = perdita accesso al nodo

## Deploy su nuovo VPS
```bash
# 1. Copia agent/ sul VPS
scp -r agent/ user@vps:/opt/proxyguardian-agent

# 2. Configura .env
cp .env.example .env
# Editare: API_KEY, NETBIRD_IP, WHITELIST_IPS

# 3. Installa e avvia
npm install --production
pm2 start dist/index.js --name proxyguardian-agent
pm2 save
```

## DO NOT
- Non bindare su 0.0.0.0 — solo NetBird IP
- Non esporre porte all'esterno della rete NetBird
- Non accettare richieste senza validazione API key
- Non eseguire comandi shell con input non sanitizzato
