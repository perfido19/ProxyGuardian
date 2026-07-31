# Tor exit-node block fleet-wide — design

## Obiettivo
Bloccare il traffico proveniente da nodi Tor exit sui 54 VPS proxy, colmando un gap identificato nel confronto con Odin ASRP (che ha una blocklist Tor exit-node dedicata, assente nel nostro sistema — l'ASN Block esistente copre solo hosting/VPN provider per ASN, non i Tor exit-node ospitati su ISP residenziali/bridge).

## Scope
- Blocco totale (DROP), stesso enforcement pattern di ASN Block (ipset + iptables), non solo log.
- Sorgente lista: **TorProject bulk exit list** (`https://check.torproject.org/torbulkexitlist`) — solo IP che fanno da exit verso di noi, aggiornata ~ogni ora dal Tor Project stesso.
- Refresh **automatico orario** via systemd timer (non manuale come l'aggiornamento ASN, perché la lista Tor cambia troppo spesso per un bottone).
- Whitelist: riusa `/etc/asn-whitelist-nets.txt` esistente (già contiene rete NetBird/dashboard/main backend, fix del 2026-07-08 anti-self-ban) — nessun file nuovo da mantenere.
- Rollout: subito su tutti i 54 VPS esistenti (incluso DynamoXc — questo è un controllo generico, indipendente dalla sua blocklist ASN custom) + aggiunto allo script Deploy VPS per i nuovi.
- UI dashboard: nuovo tab dentro la pagina `asn-block.tsx` esistente (stessa pagina già ospita whitelist condivisa).

## Storage
Nessun file di contenuto versionato in git (a differenza di `asn-blocklist.txt`) — la lista Tor è interamente derivata a runtime dal fetch orario, non c'è nulla da editare manualmente. Solo gli script/unit vanno in `scripts/` nel repo:
- `scripts/tor-to-ipset.py`
- `scripts/update-tor-block.sh`
- `scripts/tor-block-update.timer` + `scripts/tor-block-update.service`

## Flusso dati

### Agent — script di aggiornamento
`/usr/local/bin/tor-to-ipset.py` (installato da `update-tor-block.sh`):
1. `curl -fsSL https://check.torproject.org/torbulkexitlist` con timeout (10s) e retry singolo.
2. Validazione sanità: risposta deve avere almeno 50 righe che matchano un pattern IPv4 valido, altrimenti abort senza toccare l'ipset esistente (stesso principio difensivo di `update-lists.sh`: mai sostituire un dato buono con uno sospetto).
3. Carica whitelist da `/etc/asn-whitelist-nets.txt` con la stessa logica di parsing già in `asn-to-ipset.py` (righe `IP/CIDR` dirette, righe `domain:` risolte via DNS, wildcard `domain:*.suffix`) — nessuna duplicazione concettuale, il parsing è ~15 righe python riscritte identiche (nessuna dipendenza da import cross-file tra script per restare autonomi come richiesto per gli agent).
4. Per ogni IP della lista Tor non in whitelist: accumula in un buffer, scrive via un unico processo `ipset restore -exist` su un set temporaneo `tor_exit_new` (hash:ip family inet maxelem 65536 — la lista Tor exit è nell'ordine delle ~1500-2000 entry, molto più piccola di `blocked_asn`).
5. Swap atomico: `ipset swap tor_exit_new tor_exit` poi `ipset destroy tor_exit_new` (stesso pattern zero-downtime già usato per `iptv_whitelist` in `agent/index.ts:1756`) — mai un flush-poi-refill che lascia una finestra vuota.
6. `ipset save > /etc/ipset.conf` per persistere tra reboot.
7. Log riga singola in `/var/log/update-tor-block.log`: timestamp, count entry, esito.

`/usr/local/bin/update-tor-block.sh` — wrapper bash:
- Lock file `/var/run/tor-block-update.lock` (evita run concorrenti se il timer e un trigger manuale coincidono, stesso pattern di `whitelist-watcher.sh`).
- Crea `/etc/asn-whitelist-nets.txt` vuoto se non esiste (Tor Block non dipende da ASN Block installato).
- Chiama `tor-to-ipset.py`, propaga exit code.

### Agent — systemd timer
`tor-block-update.timer`: `OnCalendar=hourly`, `Persistent=true` (recupera un run mancato se il VPS era spento). Triggera `tor-block-update.service` (`Type=oneshot`, `ExecStart=/usr/local/bin/update-tor-block.sh`).

### Agent — iptables
Regole idempotenti (stesso stile `-C ... || -I INPUT N ...` di ASN Block), inserite subito dopo le regole `blocked_asn` esistenti:
```
iptables -C INPUT -m set --match-set tor_exit src -m limit --limit 10/min --limit-burst 20 -j LOG --log-prefix "[TOR-BLOCK] " --log-level 4 2>/dev/null || \
  iptables -I INPUT <N> -m set --match-set tor_exit src -m limit --limit 10/min --limit-burst 20 -j LOG --log-prefix "[TOR-BLOCK] " --log-level 4
iptables -C INPUT -m set --match-set tor_exit src -j DROP 2>/dev/null || \
  iptables -I INPUT <N+1> -m set --match-set tor_exit src -j DROP
```
`<N>` calcolato a runtime come posizione subito dopo l'ultima regola `blocked_asn` trovata (stesso approccio di inserimento relativo già usato per non rompere l'ordine ESTABLISHED,RELATED / UDP 51820 / ASN).

### Agent — whitelist watcher esteso
`whitelist-watcher.sh` (già installato per ASN Block, monitora `/etc/asn-whitelist-nets.txt` via inotify) estende il trigger esistente per chiamare anche `update-tor-block.sh` oltre a `update-asn-block.sh`, così una modifica whitelist aggiorna entrambi i set nello stesso evento. Se il VPS non ha ASN Block installato (quindi niente watcher), la whitelist per Tor Block resta comunque effettiva ad ogni run orario del timer — solo il refresh immediato su edit whitelist non scatta.

### Agent — nuovo endpoint
`GET /api/tor-block/status` → `{ enabled: boolean, lastUpdate: string | null, count: number }`:
- `enabled`: il timer `tor-block-update.timer` è `active`.
- `lastUpdate`: mtime di `/var/log/update-tor-block.log` (o null se mai eseguito).
- `count`: `ipset list tor_exit | grep -c '^[0-9]'` (o 0 se il set non esiste).

Riuso dell'endpoint generico già esistente `GET /api/ipset/:name` per l'elenco membri (`tor_exit`), nessuna modifica lì necessaria.

### Dashboard — fleet routes (server/routes.ts)
- `GET /api/fleet/tor-block/status` (requireAuth): `bulkGet` su tutti i VPS `/api/tor-block/status`, aggrega risultati per-VPS.
- `POST /api/fleet/tor-block/refresh` (requireAuth + requireAdmin): `bulkPost` su tutti i VPS `/api/tor-block/refresh` (nuovo endpoint agent che invoca `update-tor-block.sh` on-demand, stesso schema di `/api/asn/update-lists`).

### Sudoers
Aggiunta riga (stesso file/pattern delle altre): `pgagent ALL=(ALL) NOPASSWD: /usr/local/bin/update-tor-block.sh`.

## UI
In `client/src/pages/asn-block.tsx`, nuovo `TabsTrigger value="tor"` (icona `Ban` o simile) accanto agli esistenti (Panoramica/Gestione/Whitelist/Log/Blocklist ASN):
- Tabella per-VPS: nome, stato timer (attivo/inattivo), count IP correnti in `tor_exit`, ultimo aggiornamento (relative time).
- Bottone "Aggiorna ora" (solo admin) → `POST /api/fleet/tor-block/refresh`, poi refetch status.
- Nessuna gestione contenuto manuale (a differenza del tab "Blocklist ASN") — qui non c'è nulla da editare, solo osservare stato e forzare un refresh.
- Il tab "Whitelist" esistente resta invariato (stesso file, ora impatta anche Tor Block, va solo aggiunta una riga di testo esplicativa che la whitelist protegge anche il Tor Block).

## Deploy VPS
Nuovo checkbox `installTorBlock` in `client/src/pages/deploy-vps.tsx`, default **true** (baseline di sicurezza generica, non rischiosa per clienti legittimi — a differenza di `installAntiIptv` che resta default false). Lo script di deploy generato in `server/routes.ts`:
- Se `installTorBlock`: installa `python3` (se non già in `optionalPackages` da `installAsnBlock`), scrive i 3 file (`tor-to-ipset.py`, `update-tor-block.sh`, unit systemd timer+service), abilita e avvia il timer, esegue un primo run sincrono (come già fatto per `update-asn-block.sh` al primo deploy), aggiunge le regole iptables, aggiunge la riga sudoers.
- Nessuna dipendenza rigida da `installAsnBlock` — se un domani viene deployato un VPS con Tor Block ma non ASN Block, funziona lo stesso (whitelist file creato vuoto se assente).

## Rollout fleet esistente
Script fleet-wide (stesso pattern try/rollback già usato per il fix XFF del 2026-07-30):
1. Canary su un VPS singolo (es. project.net) — verifica `ipset list tor_exit | wc -l` > 0 dopo primo run, verifica timer attivo (`systemctl list-timers | grep tor-block`), verifica NetBird/dashboard/main backend non presenti nel set (whitelist), verifica un IP noto da `torbulkexitlist` risulti droppato.
2. Se canary ok, rollout sui restanti 53 VPS (incluso DynamoXc) — per ogni host: scrive file, installa unit, abilita timer, applica iptables idempotente; se un comando fallisce su un host, skip host (nessun rollback distruttivo necessario, a differenza di ASN Block non tocca configurazione esistente) e prosegui, report finale con lista host falliti.

## Error handling
- Fetch fallito (torproject.org down/rate-limit/timeout): abort senza toccare `tor_exit` esistente, log errore, il timer successivo (tra un'ora) riprova. Nessun alert attivo per ora (fuori scope) — visibile solo guardando `lastUpdate` nella UI se resta stale.
- Risposta HTTP 200 ma corpo vuoto/corrotto (< 50 righe valide): stesso trattamento del fetch fallito, non sostituire il set esistente.
- Whitelist malformata: entry non parsabile viene ignorata silenziosamente (stesso comportamento già in `asn-to-ipset.py`, nessuna modifica di questo comportamento esistente).
- `ipset swap` su set che non esiste ancora (primo run): lo script crea esplicitamente `tor_exit` (hash:ip, non swap) se assente, poi dai run successivi usa sempre lo swap.

## Testing
- Canary manuale (vedi Rollout, punto 1) prima di qualunque rollout fleet-wide.
- Verifica idempotenza: rieseguire `update-tor-block.sh` due volte di fila non deve duplicare regole iptables né causare errori (`-C` check già gestisce questo).
- Verifica whitelist: aggiungere temporaneamente un IP di test in `asn-whitelist-nets.txt`, forzare un refresh, verificare che quell'IP (se fosse per assurdo in `torbulkexitlist`) non compaia in `tor_exit`.
- Verifica reboot: dopo un riavvio del VPS canary, `ipset list tor_exit` deve tornare popolato (persistenza via `/etc/ipset.conf` + unit di restore esistente) senza dover aspettare il prossimo tick orario.

## Fuori scope
- UI di editing manuale della lista Tor (non ha senso, è derivata automaticamente).
- Distinzione tra Tor exit-node "buoni"/"cattivi" o whitelisting selettivo di IP Tor specifici oltre alla whitelist di rete condivisa.
- Alert/notifiche se il fetch fallisce ripetutamente.
- Estensione ad altre liste pubbliche (es. dan.me.uk) — solo TorProject bulk exit list per ora.
- Rate-limiting/soft-block invece di DROP totale (già deciso: blocco totale).
