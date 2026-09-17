# NetBird failover — hardening anti-thundering-herd + recovery main

## Contesto

Incidente del 2026-09-17: blip reale (non causato da nostre azioni, verificato
via audit del codice — nessun collegamento nginx→netbird esiste) ha fatto
scattare lo swap primary→backup su tutti i 58 host (main + dynapannel + 56
VPS flotta) quasi simultaneamente. Due problemi emersi, non presenti nel
design originale ([[2026-09-15-netbird-dual-daemon-failover-design]]):

1. **Thundering herd**: 58 host che eseguono lo swap nello stesso istante
   colpiscono il demone backup di main tutti insieme, mentre quel demone
   sta già facendo il proprio ramp-up a freddo (0→N peer). Questo ha
   allungato la finestra di disservizio reale.
2. **Main non si è mai auto-ripristinato**: verificato via log (syslog,
   nessun buco di rotazione) che main non ha loggato un solo check
   "recovered" prima dell'intervento manuale, a differenza di dynapannel e
   degli altri 56 host che ci sono riusciti autonomamente. Causa esatta non
   confermata (ipotesi dirottamento DNS/rotta esclusa via audit API del
   management self-hosted — entrambi vuoti; ipotesi residua più probabile:
   timeout troppo stretto (5s) sotto il carico reale di main durante la
   transizione).

## Obiettivo

- **Anti thundering-herd**: scaglionare gli swap effettivi (non il
  rilevamento) su una finestra di 0-90s random, sia per lo swap-to-backup
  che per il rientro, per i soli host in modalità client (dynapannel + 56
  VPS flotta).
- **Recovery di main più robusto**: non deve poter restare bloccato su
  backup a tempo indefinito senza che nessuno se ne accorga.
- **Invariante da preservare esplicitamente**: main resta l'unico a
  decidere il proprio swap-to-backup, guardando solo il proprio stato
  locale (Management/Signal del demone primario) + l'API NetBird Cloud.
  **Nessun host client può, da solo, far scattare il swap di main.** Vero
  oggi, deve restare vero dopo questa modifica — non si tocca la logica
  self-mode di main oltre all'hardening del recovery.

## Non-obiettivi

- Non si cambia la soglia di detection (6 check consecutivi / 2 minuti,
  intervallo 20s) — corretta, evita falsi positivi.
- Non si introduce un orchestratore centrale (scartato: la dashboard
  diventerebbe un nuovo single point of failure in un sistema pensato per
  essere autonomo per-host — se la dashboard stessa perde NetBird durante
  l'incidente, la flotta resterebbe senza guida).
- Non si tocca `server/nginx-template.conf` o altri componenti nginx in
  questo lavoro (tracciato separatamente).

## Architettura

Un solo file toccato: `scripts/netbird-backup/netbird-swap.sh`, deployato
identico su tutti i 58 host (parametro `MAIN_IP` distingue "self" per main
da un IP letterale per gli altri — la modalità è già nel design esistente).

### Jitter (solo modalità client, MAIN_IP != "self")

Quando il contatore raggiunge la soglia (sia nel ramo swap-to-backup sia in
quello di rientro), prima di eseguire lo stop/start reale:

1. Estrarre un valore random 0-90 da `/dev/urandom` (non `$RANDOM` puro —
   seedato per processo, rischio di correlazione tra host con PID/orario
   simili).
2. Loggare il valore estratto (per debug/audit).
3. Dormire quel numero di secondi.
4. **Ri-verificare la condizione** (stesso check usato per decidere lo
   swap) prima di agire. Se nel frattempo si è risolta da sola, non fare
   nulla e loggare "condizione risolta durante attesa jitter, swap
   annullato".
5. Solo se la condizione persiste, eseguire lo stop/start come oggi.

Su main (`MAIN_IP = self`) **nessun jitter**: un host solo non ha un
gregge da scaglionare, e ritardare la reazione di main non aiuta nessuno.

### Systemd: TimeoutStartSec

Il service è `Type=oneshot`, richiamato ogni 20s da `OnUnitActiveSec=20`
(prossimo giro 20s *dopo* la fine del precedente, non ogni 20s di orologio
assoluto). Con jitter fino a 90s, una singola esecuzione può durare quel
tanto in più: serve alzare `TimeoutStartSec` a un valore che copra
90s + margine (es. 150s), altrimenti systemd potrebbe uccidere lo script a
metà sleep.

### Regola ESTABLISHED,RELATED — hardening posizione

`ensure_established_rule()` oggi controlla solo l'*esistenza* della regola
(`iptables -C`), non la *posizione*. Trovato live su main il 17/09: la
regola generica esisteva ma in posizione 4, non 1 (sotto due regole scoped
`-i wt0` che in questo caso specifico non la rendevano inefficace, ma è lo
stesso pattern del bug del 2026-08-04). Fix: verificare esplicitamente che
sia la prima regola della chain INPUT, reinserirla in testa se non lo è,
anche quando una regola "equivalente" esiste più in basso.

### Recovery di main — timeout e logging del motivo di fallimento

Indipendente dal jitter (si applica solo a main, self-mode):

- `check_netbird_cloud_recovered()`: timeout curl da 5s a 15s. Mitiga
  l'ipotesi principale (timeout troppo stretto sotto il carico reale di
  main), costo zero, nessun rischio.
- Quando il curl fallisce, loggare anche il motivo (codice di errore
  curl, non solo "unreachable") — oggi non si salva nulla sul *perché*
  fallisce, solo che fallisce. Necessario per non dover ricostruire tutto
  a log-forensics come nell'incidente di oggi, se si ripete.

### Segnalazione "bloccato su backup"

Nessun nuovo canale di allarme. Si riusa l'endpoint già corretto in questa
sessione (`lastEvent` letto anche da syslog quando journald ha rotazione
troppo aggressiva — vedi commit già fatto su `agent/index.ts` e
`server/netbird-swap-status.ts`, non ancora deployato). Aggiunta: la
dashboard calcola da quanto tempo un host è in stato `backup` (confronto
mtime di `/var/lib/netbird-swap/state` o timestamp dell'ultimo evento
"swapped to backup") e mostra un banner nella card "Failover NetBird" già
esistente in `fleet-config.tsx` se un host supera 15 minuti su backup senza
un evento di rientro successivo.

## Flusso durante un vero blackout di main

- T0: problema reale inizia (causa esterna, non nostre azioni).
- T0 → T0+~2min: main (self-mode) e i 58 client rilevano il problema in
  parallelo, ciascuno sul proprio contatore indipendente a 20s/tick.
- Main esegue il proprio swap a backup a T0+~2min (nessun jitter).
- Ogni client, raggiunta la soglia, estrae jitter 0-90s, aspetta, ri-
  verifica, poi esegue. Swap reali distribuiti tra T0+2min e T0+3min30s.
- Risultato: il demone backup di main riceve le riconnessioni della flotta
  spalmate su ~90s invece che nello stesso secondo.
- Rientro: stesso scaglionamento quando la condizione si risolve, per non
  spostare semplicemente il problema dall'andata al ritorno.
- Se main non rientra da solo entro 15 minuti, banner di avviso in
  dashboard — nessuna azione automatica, solo visibilità per intervento
  umano.

## Rischi residui / cose che questo design NON risolve

- La causa esatta per cui main non ha loggato nemmeno un "recovered" oggi
  resta **non confermata** (ipotesi timeout-sotto-carico, non provata).
  L'alzare il timeout curl a 15s (già discusso, non ancora nella spec
  precedente ma da includere nel piano di implementazione) mitiga
  l'ipotesi principale ma non garantisce la causa reale sia quella.
- Il banner "bloccato >15min" segnala, non risolve: se il deadlock si
  ripete, serve comunque intervento manuale come oggi — questo design
  riduce il danno (visibilità rapida) non lo elimina.

## Testing

1. Pilota su un solo host non critico della flotta (stesso pattern già
   usato per altri script fleet-wide).
2. Simulazione **locale al pilota**: regola iptables temporanea solo sul
   pilota stesso verso l'IP di main, per simulare "main irraggiungibile"
   senza toccare main o altri host.
3. Verificare: soglia raggiunta → jitter estratto e loggato → sleep →
   re-check → swap (caso "ancora giù") e non-swap (caso "risolto durante
   l'attesa", testato forzando la risoluzione a metà sleep).
4. Verificare che systemd non termini il service durante la sleep lunga
   (`TimeoutStartSec` sufficiente).
5. Verificare che la regola ESTABLISHED resti in posizione 1 dopo lo swap.
6. Solo dopo un pilota pulito: stesso meccanismo di distribuzione già
   usato per gli altri script fleet (file script aggiornato, nessun
   restart di netbird — il timer lo raccoglie al giro successivo).

## Stato

Design approvato in conversazione (2026-09-17). **Nessuna implementazione
né deploy fatti.** Prossimo passo: piano di implementazione via skill
`writing-plans`, solo dopo revisione di questa spec.
