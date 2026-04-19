# ProxyGuardian — Development Context

## Project
Dashboard di sicurezza centralizzata per gestione flotte VPS con Nginx, Fail2ban, MariaDB su rete NetBird (WireGuard mesh).

## Stack
| Layer | Tech |
|-------|------|
| Frontend | React 18, TypeScript, Vite, TailwindCSS, shadcn/ui, TanStack Query, Wouter |
| Backend | Express.js, TypeScript (porta 5000) |
| Persistenza | JSON file (`data/vps.json`) — no database |
| Agent | Node.js + Express standalone (porta 3001, su ogni VPS proxy) |
| Rete | NetBird mesh (IP 100.x.x.x) |
| Auth | Cookie session + RBAC (admin/operator/viewer) |

## Structure
```
client/src/           ← React frontend
  pages/              ← dashboard, services, firewall, logs, vps-detail, fleet-*
  components/         ← shadcn/ui + custom
  hooks/              ← use-auth, use-vps, use-toast
  lib/                ← queryClient, apiRequest
server/               ← Express API
  routes.ts           ← tutti gli endpoint REST
  vps-manager.ts      ← proxy calls agli agent, bulk ops
  auth.ts             ← sessioni, RBAC
  storage.ts          ← lettura/scrittura data/vps.json
  nginx-template.conf ← config nginx ottimizzata
agent/                ← Agent standalone per VPS remoti
  index.ts            ← sorgente TypeScript
  agent-bundle.js     ← bundle ESBuild (committato)
  install.sh          ← script installazione curl|bash
```

## Key Commands
```bash
npm run dev           # Dev server (porta 5000)
npm run build         # Build production
cd agent && npm run build  # Rebuild agent bundle
```

## Deployment
- Dashboard: SSH su `185.229.236.50` → `/root/proxy-dashboard/`
- Deploy: `git pull && npm run build && pm2 restart proxy-dashboard`
- Agent: `curl -fsSL https://raw.githubusercontent.com/perfido19/ProxyGuardian/main/agent/install.sh | sudo bash`
- Hot deploy manuale dashboard: `scp` dei file modificati su `/root/proxy-dashboard/`, poi `npm run build && pm2 restart proxy-dashboard`

## Recent Notes
- `Deploy VPS` ha due checkbox opzionali:
  - `Installa ASN Block` → default `true`
  - `Installa Anti-IPTV` → default `false`
- Il testo UI sotto `Installa Anti-IPTV` e`: `Selezione per installare lo script anti-IPTV.`
- Il deploy VPS non mostra nomi di VPS sorgente per ASN Block / Anti-IPTV.
- Se `Installa ASN Block` e` attivo, il deploy installa anche gli asset AsnBlock (`asn-to-ipset.py`, `update-asn-block.sh`, `update-lists.sh`, `whitelist-watcher.sh`, service systemd, file ASN whitelist/blocklist e `asn-log-stats.py`).
- Se `Installa Anti-IPTV` e` attivo, il deploy installa `anti-iptv.py`, `anti-iptv.sh`, `anti-iptv.service` e i log in `/var/log/anti-iptv`.
- `dynadoctor` aveva una versione vecchia di `/usr/local/bin/asn-log-stats.py` che non supportava `--source nginx`; fix applicato live insieme a `PATH` corretto per `update-asn-block.sh`.

## VPS List
| Name | IP (NetBird) | Disk |
|------|--------------|------|
| Prova Neutrale | 100.116.229.127 | 9.6G |
| Secucam | 100.116.223.38 | 29G |
| PROJECT.GA | 100.116.97.84 | 29G |
| DynamoXc | 100.116.80.18 | 58G |
| Smarters | 100.116.14.174 | 9.6G |

## Conventions
- TypeScript ovunque, minimizzare `any`
- Variabili d'ambiente in `.env`, mai hardcoded
- Frontend: shadcn/ui + TanStack Query + Wouter
- Backend: tutta logica in `routes.ts` e `vps-manager.ts`
- Agent: runtime Node.js 12+ (no `??` o `?.` nel sorgente)
- Commit: `feat:`, `fix:`, `chore:` + descrizione breve

## Do NOT
- Non committare `.env` o `data/vps.json`
- Non esporre agent su IP pubblici
- Non dimenticare rebuild `agent-bundle.js` dopo modifiche agent
