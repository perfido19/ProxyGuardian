# Tor Exit Block Centralizzato — Design

**Data:** 2026-08-04
**Stato:** approvato
**Sostituisce:** `docs/superpowers/plans/2026-07-31-tor-exit-block.md` (mai deployato — vedi "Perché si cambia")

## Obiettivo

Bloccare il traffico dai nodi Tor exit-node su tutta la fleet, spostando **fetch, validazione, filtro e scheduling** dalla singola VPS alla dashboard. Sui VPS resta solo l'enforcement (ipset + iptables).

## Perché si cambia

Il design del 2026-07-31 fa girare su **ogni** VPS, ogni ora: download da `check.torproject.org`, parsing Python, filtro whitelist, rigenerazione ipset, riscrittura regole iptables. Su 54 VPS da 1 vCPU sono 54 esecuzioni identiche che producono lo stesso identico risultato — 1296 download/giorno da 54 IP diversi verso lo stesso endpoint.

Il codice esiste in repo (`scripts/tor-to-ipset.py`, `scripts/update-tor-block.sh`, sezione deploy in `server/routes.ts`, endpoint `/api/tor-block/install` non committato in `agent/index.ts`) ma **non è installato su nessun VPS** — verificato il 2026-08-04. Si cambia prima del rollout, non dopo.

### Bug bloccante nel design precedente

Sia `scripts/update-tor-block.sh` sia lo script di deploy in `server/routes.ts` inseriscono le regole con `iptables -A INPUT` (append). Il piano del 2026-07-31 lo giustifica così:

> "verificato che il chain INPUT del deploy script fresco non ha una policy DROP finale né un catch-all — quindi append è sicuro"

Vero per una VPS **appena deployata**. Falso per la fleet esistente. Rilevazione live su 5 VPS:

| VPS | regole INPUT | ultima regola | ultimo ESTABLISHED | ACCEPT dpt:8880 | blocked_asn |
|---|---|---|---|---|---|
| dragon (100.116.113.227) | 19 | `DROP all` | 15 | 18 | 16 |
| Smarters (100.116.14.174) | 12 | `ACCEPT dpt:8880` | 6 | 12 (ultima) | 10 |
| gruppo3 (100.116.206.239) | 12 | `DROP all` | 7 | 11 | 9 |
| Secucam (100.116.239.176) | 18 | `DROP all` | 13 | — | 14 |
| project.net (100.116.212.143) | 9 | `DROP all` | 7 | — | — |

`-A` fallisce su tutti e 5, per due cause distinte:

1. **4 su 5 hanno un `DROP all` finale** — la regola appesa finisce dopo, non viene mai valutata.
2. **Smarters finisce con `ACCEPT dpt:8880`** — il traffico Tor verso la porta proxy viene accettato prima che la regola Tor sia raggiunta.

In entrambi i casi: ipset popolato, dashboard verde, zero pacchetti bloccati. Stesso identico errore già documentato per la regola UDP 51820 (2026-06-28).

## Architettura

```
DASHBOARD (poller orario)
  fetch torbulkexitlist        1 download, ~1400 IP / 20KB
  valida (min 50 IP; scarta se < 50% del conteggio precedente)
  filtra whitelist + guard anti-autoblocco
  persiste data/tor-exit-list.json
  push parallelo -> N agent (vps-manager.ts)
         |
         v
AGENT  POST /api/tor-block/apply { ips: [...] }
  ipset restore in tor_exit_new -> swap -> destroy   (atomico)
  verifica/ripara posizionamento regole iptables
  ipset save > /etc/ipset.conf
```

Il **blocco resta sul VPS**: il traffico Tor arriva direttamente sui proxy, non transita dalla dashboard. Si centralizza solo la costruzione della lista.

Il pattern push è già in uso nel progetto (BanSync verso l'ipset `iptv_ban`, poller a 60s in `server/routes.ts`) — non è un meccanismo nuovo da inventare.

## Componenti

### 1. Dashboard — `server/tor-block.ts` (nuovo modulo)

Responsabilità: possedere la lista. Unica interfaccia verso il resto del server.

- `refreshList()` — fetch, valida, filtra, persiste. Ritorna `{ ips, count, fetchedAt }` o errore.
- `getList()` — ultima lista buona dalla cache in memoria o da `data/tor-exit-list.json`.
- `pushToFleet()` — push parallelo agli agent via `vps-manager.ts`, ritorna esito per-VPS.
- Poller orario che incatena i tre.

Validazione (logica trasferita da `scripts/tor-to-ipset.py`, che viene eliminato):
- minimo 50 IPv4 validi, altrimenti scarta
- se il conteggio nuovo è < 50% del precedente, scarta (protezione contro risposte troncate/errore)
- su scarto: mantiene l'ultima lista buona, **non pusha**, logga

Persistenza in `data/tor-exit-list.json` (stesso pattern di `data/vps.json`, non committato): un riavvio della dashboard non perde l'ultima lista buona né forza un re-fetch immediato.

**Route HTTP** (`server/routes.ts`):

- `GET /api/fleet/tor-block/status` — età lista, conteggio IP, esito ultimo push per-VPS
- `POST /api/fleet/tor-block/refresh` — forza fetch + push (admin/operator)

Il piano del 2026-07-31 osservava che la UI ASN Block usa gli endpoint generici `POST /api/vps/bulk/get` e `/bulk/post` invece di route fleet dedicate. Quella convenzione qui **non è applicabile**: nel modello centralizzato lo stato principale (età della lista, conteggio, esito dell'ultimo ciclo di push) vive sulla dashboard, non sugli agent, quindi non è interrogabile via bulk. Le due route sopra sono il minimo necessario, non route di comodo.

### 2. Guard anti-autoblocco

Applicato **centralmente prima di ogni push**. Rimuove dalla lista, sempre, a prescindere da cosa dice l'upstream:

- `100.64.0.0/10` — intera mesh NetBird (dashboard, tutti i VPS, main backend)
- `185.229.236.50` — dashboard pubblico
- `80.244.4.35` — main backend
- whitelist fleet da `asn-block/`

Un exit node Tor non dovrebbe *mai* essere uno di questi IP. Ma il 2026-07-08 l'IP della dashboard è finito nell'ipset `iptv_ban` su 52 VPS su 54 e ha causato mesi di instabilità NetBird attribuita ad altro (vedi `project_netbird_selfban_iptv_ban_2026-07-08`). Il filtro va messo comunque.

Funzione pura, testabile in isolamento, con test dedicato.

### 3. Agent — `POST /api/tor-block/apply`

Sostituisce `/api/tor-block/install` (non committato) e `/api/tor-block/refresh`. Body: `{ ips: string[] }`.

Sequenza:
1. `ipset create tor_exit hash:ip family inet maxelem 65536 -exist` (idempotente; **prima** delle regole — una regola `--match-set` verso un set inesistente fallisce)
2. carica gli IP in `tor_exit_new` via `ipset restore`, poi `swap` con `tor_exit`, poi `destroy` del temporaneo — atomico: se fallisce a metà resta attivo il set precedente, non si resta mai scoperti
3. verifica/ripara le regole iptables (algoritmo sotto)
4. `ipset save > /etc/ipset.conf`
5. `iptables-save > /etc/iptables/rules.v4` **solo se le regole sono state modificate** (evita churn orario su 54 VPS e evita di persistere lo stato istantaneo delle chain fail2ban, che gestisce la propria persistenza)

Resta `GET /api/tor-block/status` (conteggio, ultimo apply, presenza e posizione delle regole).

Vincolo: `agent/index.ts` compila con `--target=node12` → niente `??` né `?.`. Rebuild `agent/agent-bundle.js` e commit del bundle, altrimenti i nuovi deploy scaricano un agent vecchio.

### 4. Posizionamento iptables

Le posizioni assolute sono inutilizzabili: le chain vanno da 9 a 19 regole e fail2ban inserisce in cima di continuo, spostando tutto.

**Ancora: la posizione dell'*ultima* regola `ACCEPT` con `state`/`ctstate ... RELATED,ESTABLISHED` nella chain INPUT. Le regole Tor si inseriscono subito dopo.**

"Ultima" e non "prima" perché alcune VPS ne hanno due (dragon: posizioni 9 e 15); inserire dopo l'ultima garantisce di stare sotto tutte.

L'ancora soddisfa simultaneamente tutti i vincoli:

| Vincolo | Perché |
|---|---|
| sotto `NETBIRD-ACL-INPUT` | la ACL della mesh va valutata per prima — difesa in profondità sul guard |
| sotto ogni `ACCEPT RELATED,ESTABLISHED` | non tronca sessioni già stabilite e non blocca il traffico di ritorno delle connessioni in uscita (è esattamente il bug fleet-wide del 2026-07-08) |
| sopra `blocked_asn` | stessa finestra protettiva già collaudata in produzione |
| sopra `ACCEPT tcp dpt:8880` | critico: altrimenti il traffico Tor verso la porta proxy è già accettato |
| sopra il `DROP all` finale | altrimenti la regola non viene mai raggiunta (il bug di `-A`) |

Verifica dell'ancora sui 5 VPS rilevati — inserimento corretto su tutti:

| VPS | ancora | inserimento | risultato |
|---|---|---|---|
| dragon | 15 | 16 | prima di asn(16), 8880(18), DROP(19) |
| Smarters | 6 | 7 | prima di asn(10), 8880(12) |
| gruppo3 | 7 | 8 | prima di asn(9), 8880(11), DROP(12) |
| Secucam | 13 | 14 | prima di asn(14), DROP(18) |
| project.net | 7 | 8 | prima di DROP(9) |

**Condizioni di rifiuto (preflight).** Se una di queste è vera, l'agent **non tocca iptables**, ritorna errore, la UI lo mostra:

- nessuna regola `ACCEPT ... RELATED,ESTABLISHED` in INPUT → l'ancora non esiste. Rifiuta. Segnala anche un'eventuale regressione del fix del 2026-07-08.
- esiste un `ACCEPT tcp dpt:8880` in posizione **sopra** l'ancora calcolata → inserire sotto lo renderebbe inefficace. Rifiuta invece di installare una regola decorativa.

Meglio nessuna regola e un errore visibile che una regola che sembra funzionare e non blocca niente.

**Ordine di inserimento** (una alla volta, con verifica `-C` fra un passo e l'altro, come da `feedback_iptables_syn_flood_incident`):

1. inserisci `DROP` in posizione `ancora+1`, verifica
2. inserisci `LOG` in posizione `ancora+1` (spinge il DROP a `ancora+2`), verifica
3. stato finale: `LOG` in `ancora+1`, `DROP` in `ancora+2`

Regole:
```
-m set --match-set tor_exit src -m limit --limit 10/min --limit-burst 20 -j LOG --log-prefix "[TOR-BLOCK] " --log-level 4
-m set --match-set tor_exit src -j DROP
```

Il `LOG` è rate-limited a 10/min, non può inondare `kern.log`. Serve a verificare che il blocco stia effettivamente agendo. Stesso schema di `blocked_asn`.

**Idempotenza e auto-riparazione** (ad ogni apply orario):

`-C` dice se la regola esiste, non *dove*. Quindi l'agent legge `iptables -nL INPUT --line-numbers` e:

- regole presenti e nella finestra corretta → non fa nulla
- regole presenti ma in posizione sbagliata (residuo del vecchio `-A`, oppure spostate) → `-D` con match esatto, poi reinserimento corretto
- regole assenti → inserimento

**Mai inserimento cieco.** Dragon mostra regole duplicate (chain f2b, `ANTI_IPTV` ed `ESTABLISHED` compaiono due volte): qualcosa in questa fleet reinserisce senza controllare. Un apply orario su 54 VPS che non verifica accumulerebbe duplicati per sempre.

Questo sostituisce l'auto-riparazione che oggi fa lo script bash ogni ora dopo un eventuale `iptables -F`.

**Vincoli assoluti:** mai `iptables -F`; mai una chain con `DROP`/`REJECT` non condizionato; ogni regola Tor è sempre scoped a `--match-set tor_exit src`. Con l'ipset vuoto le regole sono pass-through innocuo — la stessa proprietà che ha reso inoffensiva la chain `ANTI_IPTV` sul main backend.

Il `DROP` non è ristretto per porta, coerente con `blocked_asn`: l'ipset **è** lo scope. Conseguenza accettata: un admin che si collegasse da un IP exit-node Tor resterebbe fuori anche da SSH.

### 5. Impronta sul VPS dopo la modifica

ipset `tor_exit` + 2 regole iptables + `ipset-restore.service` (già presente per ASN Block, gestisce già l'ordine al boot: l'ipset deve esistere prima che le regole vengano caricate).

Niente Python, niente bash, niente timer systemd, nessuna connessione in uscita. Costo per VPS: ~50ms di CPU all'ora, solo `ipset restore` (codice C).

### 6. UI — tab "Tor Exit" in `client/src/pages/asn-block.tsx`

Da stato dei timer per-VPS a stato centrale: età della lista, numero di IP, sincronizzazione per-VPS (✓/✗/rifiutato-con-motivo), bottone force-refresh. Il motivo del rifiuto va mostrato: è il canale con cui emerge una VPS con la chain malformata.

## Cosa si elimina

- `scripts/tor-to-ipset.py`, `scripts/update-tor-block.sh`
- `DEPLOY_TOR_BLOCK_SERVICE`, `DEPLOY_TOR_BLOCK_TIMER` in `server/routes.ts`
- la sezione Tor dello script di deploy si riduce a: crea ipset + inserisci le 2 regole con lo stesso algoritmo di ancoraggio
- endpoint agent `/api/tor-block/install` e `/api/tor-block/refresh`
- voci sudoers per gli script e i timer Tor (`agent/index.ts`, `SUDOERS_CONTENT`, e `server/routes.ts`)

## Gestione errori

| Cosa fallisce | Comportamento |
|---|---|
| fetch da torproject.org | mantiene ultima lista buona, non pusha, ipset sui VPS intoccati |
| validazione (lista corta o crollata) | idem — meglio una lista vecchia che una lista rotta |
| guard rimuove IP | logga quali e quanti; se rimuovesse > 10 IP, allarme in UI (indica upstream compromesso o whitelist sbagliata) |
| VPS offline durante il push | loggato, mostrato in UI, riprovato al ciclo successivo |
| preflight iptables rifiuta | nessuna modifica al firewall, errore per-VPS visibile in UI |
| `ipset restore`/`swap` fallisce | swap atomico: resta attivo il set precedente |

## Parametri

- refresh **orario** (la lista Tor cambia lentamente)
- rollout su **tutti i VPS abilitati, DynamoXc incluso** (a differenza di anti-iptv e ASN Block, qui non serve una lista dedicata)
- VPS offline: nessun retry immediato, si recupera al ciclo successivo

## Validazione

Nel repo non esiste framework di test (vedi piano 2026-07-31). Quindi:

- **test unitario dedicato** per il guard anti-autoblocco e per la validazione della lista — sono funzioni pure lato dashboard, vanno testate anche se significa introdurre il primo test del progetto. È la logica che, sbagliata, ripete l'incidente del 2026-07-08 su 54 VPS.
- syntax check: `tsc --noEmit`
- **VPS canary** prima del rollout fleet-wide, stesso schema del fix X-Forwarded-For del 2026-07-30. Sul canary verificare esplicitamente:
  - posizione delle regole con `iptables -nL INPUT --line-numbers`
  - contatore pacchetti della regola DROP che sale (`iptables -nvL INPUT`) — è la prova che il blocco agisce davvero, quella che il design precedente non avrebbe mai potuto dare
  - un secondo apply non duplica le regole
  - NetBird resta connesso (`netbird status`)
- rollout progressivo, non simultaneo sui 54.
