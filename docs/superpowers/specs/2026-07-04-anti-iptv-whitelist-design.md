# Anti-IPTV whitelist fleet-wide — design

## Obiettivo
Aggiungere una whitelist IP/CIDR per l'anti-iptv, gestibile da un'unica sezione nella dashboard (pagina Anti-IPTV), sincronizzata su tutta la fleet. Gli IP/CIDR in whitelist non vengono mai bannati da `anti-iptv.py` (l'ipset `iptv_whitelist` è già controllato dallo script esistente, ma finora non è mai popolato da nessuna UI).

## Scope
- Whitelist **unica fleet-wide** (stessa lista su tutti i VPS) — non per-VPS.
- Entry: **IP singolo o CIDR** (es. `1.2.3.4` o `1.2.3.0/24`), una per riga, commenti opzionali con `#`.
- Nessun nuovo meccanismo systemd/watcher — il salvataggio sincronizza subito via chiamata diretta all'agent (niente inotify come per ASN, inutile per un caso che cambia raramente).

## Storage
Nuovo file `scripts/iptv-whitelist.txt` nel repo (stesso pattern di `asn-block/asn-whitelist.txt`) — versionato in git, fonte di verità.

## Flusso dati

### Lettura
`GET /api/fleet/anti-iptv/whitelist` (requireAuth) → legge `scripts/iptv-whitelist.txt`, ritorna `{ content: string }`.

### Scrittura
`POST /api/fleet/anti-iptv/whitelist` (requireAuth + requireAdmin):
1. Valida il body `{ content: string }`: ogni riga non vuota/non commento deve essere un IP o CIDR valido — ogni ottetto in 0-255, prefisso CIDR (se presente) in 0-32; righe non valide → 400 con elenco righe scartate (stesso helper di validazione riusato lato agent, vedi sotto).
2. Scrive `scripts/iptv-whitelist.txt` sul filesystem del dashboard.
3. Estrae la lista pulita di IP/CIDR (senza commenti/righe vuote).
4. Per ogni VPS `enabled` nella fleet: `agentPost(vps, "/api/anti-iptv/whitelist", { entries: string[] })` in parallelo (`Promise.allSettled`, stesso pattern di `bulkPost`).
5. Risponde `{ ok: true, content, syncResults: BulkResult[] }`.

### Agent — nuovo endpoint
`POST /api/anti-iptv/whitelist` (agent, riceve `{ entries: string[] }`):
1. Valida ogni entry (IP o CIDR, ottetti 0-255, prefisso 0-32) — difesa in profondità, non fidarsi del server.
2. Assicura che l'ipset esista: `ipset create iptv_whitelist hash:net -exist`.
3. Flush + bulk-add via un singolo comando `ipset restore` (stdin con `flush iptv_whitelist` + una riga `add iptv_whitelist <entry>` per entry) — evita N invocazioni separate di `ipset add` (stesso problema di performance già risolto altrove in questa sessione per `fail2ban-client`).
4. Persiste: `ipset save > /etc/ipset.conf` (riusa `ipset-restore.service` già installato per ASN block — nessuna nuova unit systemd; se il VPS non ha ASN block/quella unit, l'ipset semplicemente non sopravvive a un reboot finché non viene installata, comportamento accettato).
5. Risponde `{ ok: true, count: entries.length }`.

## UI
In `client/src/pages/anti-iptv-management.tsx`, nuova `Card` sotto la tabella esistente:
- `Textarea` con il contenuto corrente (una entry per riga), precaricato da `GET /api/fleet/anti-iptv/whitelist`.
- Bottone "Salva whitelist" (visibile solo `isAdmin`, stesso guard delle altre mutazioni in pagina).
- Dopo il salvataggio, mostra una tabella risultati per-VPS (successo/errore), stesso stile della tabella `ParamsResult` già esistente in pagina.
- Validazione client-side leggera (righe non vuote che non matchano IP/CIDR evidenziate in rosso) prima di inviare, oltre alla validazione server-side autoritativa.

## Fuori scope
- Whitelist per-VPS personalizzata.
- Watcher automatico/inotify (sync è sincrono al salvataggio).
- Import/export da altre fonti (es. GeoIP, ASN).
- Gestione dell'ipset `iptv_ban` (già esistente, non toccata da questa feature).
