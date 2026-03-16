# Proxy Dashboard - Gestione VPS

## Panoramica
Dashboard web professionale per la gestione completa di nginx reverse proxy con fail2ban, ModSecurity e GeoIP2 su VPS Ubuntu. Installabile autonomamente su ogni VPS per il monitoraggio e controllo locale.

## Scopo del Progetto
Fornire un'interfaccia web intuitiva in italiano per amministrare il sistema proxy creato dallo script di installazione, permettendo di:
- Monitorare lo stato dei servizi (nginx, fail2ban, mariadb)
- Visualizzare e gestire IP bannati
- Configurare whitelist/blacklist (paesi, ASN, ISP, User-Agent, IP)
- Visualizzare log in tempo reale
- Gestire file di configurazione

## Stack Tecnologico

### Frontend
- React con TypeScript
- Wouter per routing
- TanStack Query per data fetching e polling
- Shadcn UI + Tailwind CSS per l'interfaccia
- Recharts per grafici statistiche
- Design system professionale per dashboard tecniche

### Backend
- Express.js server
- Node.js child_process per comandi di sistema
- Esecuzione systemctl, fail2ban-client
- Lettura/scrittura file di configurazione e log

## Architettura

### Data Model (shared/schema.ts)
- **Service**: Stato servizi sistema (status, uptime, pid)
- **BannedIp**: IP bannati da fail2ban con jail, tempo, motivo
- **Stats**: Statistiche aggregate (ban 24h, connessioni, paesi bloccati, richieste)
- **LogEntry**: Voci log con timestamp, livello, messaggio
- **ConfigFile**: File configurazione con path e contenuto
- **JailConfig**: Configurazione jail fail2ban (name, enabled, port, filter, logpath, maxretry, bantime, findtime, action)
- **Fail2banFilter**: Filtro fail2ban con regex (name, path, failregex, ignoreregex, description)

### Backend Routes (server/routes.ts)
- `GET /api/services` - Lista stato tutti i servizi
- `POST /api/services/action` - Esegui azione su servizio (start/stop/restart/reload)
- `GET /api/banned-ips` - Lista IP bannati da fail2ban
- `POST /api/unban` - Sblocca IP da jail specifica
- `POST /api/unban-all` - Sblocca tutti gli IP da tutte le jail
- `GET /api/stats` - Statistiche sistema e ban
- `GET /api/logs/:logType` - Leggi log (nginx-access, nginx-error, fail2ban, modsec)
- `GET /api/config/:filename` - Leggi file configurazione
- `POST /api/config/update` - Aggiorna file configurazione
- `GET /api/fail2ban/jails` - Lista tutte le jail configurate
- `POST /api/fail2ban/jails/:name` - Aggiorna configurazione jail specifica
- `GET /api/fail2ban/filters` - Lista tutti i filtri disponibili
- `GET /api/fail2ban/filters/:name` - Ottieni singolo filtro
- `POST /api/fail2ban/filters/:name` - Aggiorna failregex e ignoreregex di un filtro
- `GET /api/fail2ban/config/:type` - Leggi jail.local o fail2ban.local
- `POST /api/fail2ban/config/:type` - Aggiorna jail.local o fail2ban.local

### Storage Layer (server/storage.ts)
Implementazione comandi sistema per:
- `systemctl status/start/stop/restart/reload` per gestione servizi
- `fail2ban-client status/unbanip` per gestione ban
- Lettura file log da `/var/log/nginx/`, `/var/log/fail2ban.log`, `/opt/log/modsec_audit.log`
- Lettura/scrittura file configurazione in `/etc/nginx/`
- **Creazione automatica file configurazione** se non esistono (con template di default)
- Parsing e modifica `/etc/fail2ban/jail.local` per gestione jail
- Lettura/scrittura filtri in `/etc/fail2ban/filter.d/` con modifica regex
- Gestione file configurazione fail2ban (jail.local, fail2ban.local)
- Runtime capability detection con fallback graceful (SystemCapabilities)

### Frontend Pages
1. **Dashboard** (`/`) - Panoramica generale con card statistiche, stato servizi, grafici, IP bannati recenti, pulsante "Sblocca Tutti" con conferma
2. **Servizi** (`/servizi`) - Controllo dettagliato servizi con info e azioni
3. **Firewall** (`/firewall`) - Gestione regole whitelist/blacklist tramite tabs
4. **Fail2ban** (`/fail2ban`) - Gestione completa fail2ban con 3 tabs:
   - **Jail**: Lista jail con toggle enable/disable, editor parametri (maxretry, bantime, findtime)
   - **Filtri**: Visualizzazione e modifica filtri con editor regex (failregex/ignoreregex), aggiunta/rimozione regex
   - **Configurazioni**: Editor diretto per jail.local e fail2ban.local
5. **Log** (`/log`) - Visualizzatore log in tempo reale con filtri e download
6. **Configurazioni** (`/configurazioni`) - Editor file configurazione con salvataggio

## Componenti Chiave

### ServiceStatusCard
Card per visualizzare stato servizio con badge, uptime, PID e pulsanti azione (Start/Stop/Restart/Reload)

### BannedIpsTable
Tabella IP bannati con ricerca, colonne (IP, jail, data, tempo rimasto, motivo) e azione unban con conferma

### LogViewer
Visualizzatore log con auto-scroll, ricerca, pause/play, download, evidenziazione livelli (ERROR/WARN/INFO)

### StatCard
Card statistica con icona, valore grande, titolo e descrizione

## File di Configurazione Gestiti
- `country_whitelist.conf` - Whitelist paesi (ISO 3166-1 alpha-2)
- `block_asn.conf` - Blacklist ASN
- `block_isp.conf` - Blacklist ISP
- `useragent.rules` - Blocco User-Agent
- `ip_whitelist.conf` - IP esclusi da rate limiting
- `exclusion_ip.conf` - IP/range esclusi da blocco geografico

## Real-time Features
- Polling servizi ogni 5 secondi
- Polling IP bannati ogni 5 secondi
- Polling statistiche ogni 10 secondi
- Polling log ogni 3 secondi
- Toast notifications per azioni e errori

## Design Guidelines
Seguire rigorosamente `design_guidelines.md`:
- Palette colori per dashboard tecnica
- Tipografia con Inter (UI) e JetBrains Mono (monospace)
- Spacing consistente (2, 4, 6, 8)
- Componenti Shadcn UI nativi
- Responsive mobile-first
- Stati loading/error/empty curati

## Installazione su VPS
1. Clonare repository sul VPS
2. Installare Node.js 20
3. `npm install`
4. `npm run dev` per avvio (produzione: porta 5000)
5. Accedere via browser a `http://IP_VPS:5000`

## Note Importanti
- Dashboard richiede permessi sudo per comandi systemctl e fail2ban-client
- File log e configurazioni devono essere leggibili dall'utente che esegue l'app
- Dopo modifiche configurazioni, ricaricare nginx per applicare cambiamenti
- Interfaccia completamente in italiano

## Stato Attuale
✅ MVP completo con tutte le funzionalità core
✅ Frontend professionale e responsive
✅ Backend integrato con comandi di sistema
✅ Real-time polling e toast notifications
✅ Gestione errori completa
✅ Gestione completa fail2ban (jail, filtri, configurazioni)
✅ SystemCapabilities con runtime detection per fallback graceful
✅ Parsing intelligente file configurazione nginx e fail2ban
✅ Creazione automatica file configurazione mancanti con template di default
✅ Pulsante "Sblocca Tutti" con conferma di sicurezza
✅ Rilevamento dinamico jail fail2ban attive

## Prossimi Passi (Future)
- Autenticazione utente per proteggere accesso
- Editor syntax highlighting per configurazioni
- Notifiche email/telegram per alert
- Backup/restore automatico configurazioni
- Gestione granulare regole ModSecurity
