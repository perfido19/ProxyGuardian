# NetBird dual-daemon failover — design

## Contesto

2026-09-15: NetBird Cloud ha avuto un'interruzione reale (management API `api.netbird.io`
in 503 per ~40 minuti). I tunnel WireGuard già stabiliti hanno retto (nessun down
visibile ai clienti), ma il control-plane (nuove connessioni/riconnessioni, dashboard
peer status) è rimasto inutilizzabile per tutta la durata. Obiettivo: eliminare la
dipendenza singola da NetBird Cloud per il path critico fleet→main, senza sostituirlo
(NetBird Cloud resta primario).

Nota: l'incidente di stamattina (crash-loop 09:44-11:26) era causato da un bug nostro
(`fix-iptables-post-netbird.sh` che riavviava fail2ban ad ogni riavvio netbird), non da
NetBird Cloud — già fixato separatamente. Questo progetto è comunque valido come difesa
in profondità contro un vero outage esterno come quello di oggi.

## Obiettivo

Ogni host che oggi dipende da NetBird Cloud (`wt0`) per raggiungere `main` guadagna un
secondo demone NetBird (`wt1`) connesso a un management server **self-hosted**, usato
**solo come backup passivo**: nginx prova sempre prima il path NetBird Cloud, passa al
path self-hosted solo se quello primario fallisce (direttiva `backup` upstream nginx).
I due demoni restano sempre connessi in parallelo (non si può "accendere on-demand" un
demone e avere failover istantaneo) — il failover è a livello di **scelta del path da
parte di nginx**, non di attivazione del demone.

## Componenti

### 1. Server NetBird self-hosted (nuovo, dedicato)
- Host: `94.249.153.69` (VPS Ubuntu 24.04, 8GB RAM, 2 CPU, pulito)
- Dominio: `dynbird.duckdns.org` (DuckDNS, verificato puntare a `94.249.153.69`)
- Installer ufficiale NetBird self-hosted (management + signal + relay/coturn +
  dashboard, stack docker-compose)
- CIDR di rete dedicato per questa mesh (da scegliere in fase di installazione, non
  sovrapposto al range `100.116.0.0/16` di NetBird Cloud per evitare ambiguità di
  routing)
- **ACL/gruppi mirror di NetBird Cloud**: gruppo Proxy (fleet) ↔ gruppo Main
  (main+dynapannel), bidirezionale, porte 8880/2096 — non "tutti con tutti". Stessa
  filosofia della policy NetBird Cloud esistente.

### 2. Protezioni sul nuovo server
- **fail2ban su SSH** (jail standard, stesso schema base usato ovunque nella fleet)
- **Allowlist IP stretta** su dashboard/API management (porta 443): solo gli IP
  pubblici degli host che parteciperanno alla mesh self-hosted (main, dynapannel, VPS
  pilota, poi resto flotta man mano che si aggiungono) — non ASN/geo-block (questo
  server non serve traffico pubblico generico, solo i nostri host noti)
- STUN/TURN/relay (porte UDP del signal/coturn) restano aperte quanto necessario al
  protocollo NetBird per funzionare (non filtrabili per IP, sono usate anche per NAT
  traversal da IP che cambiano)

### 3. Configurazione dual-daemon per host (main, dynapannel, ogni VPS pilota/fleet)
Basata sul prompt fornito, con adattamenti:
- Primario: `/etc/netbird`, interfaccia `wt0`, socket default — **non toccato**
- Backup: `/etc/netbird-backup`, log in `/var/log/netbird-backup`
  - Interfaccia `wt1`
  - Socket: `/var/run/netbird-backup.sock`
  - Management URL: `https://dynbird.duckdns.org`
  - Setup-key: generata per-host dal nuovo management server (una per ogni host che si
    unisce, non condivisa)
  - Porta WireGuard UDP dedicata per `wt1` (default netbird 51820 è già preso da
    `wt0` — va specificata una porta diversa, es. `51821`, nella config del backup)
- systemd unit `/etc/systemd/system/netbird-backup.service`:
  - `Restart=always`, `RestartSec=5`, `LimitNOFILE=65536`
  - `ExecStart=... --config /etc/netbird-backup/config.json --log-file
    /var/log/netbird-backup/client.log --daemon-addr unix:///var/run/netbird-backup.sock`

### 4. Firewall — apertura porta wt1
Su ogni host che riceve il secondo demone: regola ACCEPT esplicita per la porta UDP di
`wt1` (es. 51821), analoga a quella già esistente per `wt0`/51820 (vedi
`project_netbird_p2p_fleet` — senza questa regola l'handshake P2P cade su relay, alta
latenza). Su `main` va aggiunta anche a `/etc/pg-firewall/locks.conf` (sezione `keep`)
così sopravvive ai reset/timer di `pg-firewall-locks.sh`.

### 5. nginx — failover passivo
Su ogni VPS fleet con `wt1` attivo, modifica a `server/nginx-template.conf`:
```
upstream backend {
    server main.netbird.cloud:8880;        # wt0, primario
    server <main-wt1-mesh-ip>:8880 backup; # wt1, solo se il primario fallisce
}
```
`proxy_next_upstream` già presente gestisce il passaggio automatico al backup in caso
di errore/timeout sul primario. L'IP mesh di main su `wt1` sarà noto solo dopo
l'iscrizione di main al nuovo management server (assegnato dal self-hosted, non
prevedibile a priori).

## Rollout a fasi

**Fase 0 — Server self-hosted**
Installazione NetBird self-hosted su `94.249.153.69`, hardening (fail2ban + allowlist),
verifica dashboard/API raggiungibile solo dagli IP previsti.

**Fase 1 — Pilota (main + dynapannel + 3 VPS fleet)**
- main, dynapannel, Smarters, Lupo, gruppo3 salerno
- Installazione dual-daemon su questi 5 host
- Verifica: `ip link` mostra `wt0`+`wt1` su ognuno, `netbird status --daemon-addr
  unix:///var/run/netbird-backup.sock` = Connected, P2P diretto tra i pilota (non
  relay) via `wt1`
- Test di failover reale: fermare temporaneamente (non disinstallare) `wt0` su un VPS
  pilota, verificare che nginx passi automaticamente al backup e lo streaming continui,
  poi riavviare `wt0` e verificare il ritorno al path primario

**Fase 2 — Resto della flotta (51 VPS rimanenti)**
Solo dopo che la Fase 1 è validata stabile per un periodo di osservazione. Stesso
processo, a scaglioni (non tutti insieme) per poter individuare rapidamente eventuali
problemi senza impattare tutta la flotta in un colpo.

## Rischi e mitigazioni

- **Superficie nuova**: il server self-hosted stesso è un target nuovo — mitigato da
  allowlist IP stretta + fail2ban + ACL mirror (vedi sopra). Se compromesso, un peer
  rogue registrato lì avrebbe comunque raggiungibilità di rete verso main/dynapannel/
  pilota via `wt1`, indipendentemente da quale upstream sta usando nginx in quel
  momento (la raggiungibilità mesh non è gated dalla scelta applicativa di nginx).
- **Doppio componente NetBird = doppia manutenzione**: aggiornamenti, monitoraggio,
  certificati (Let's Encrypt su `dynbird.duckdns.org`, rinnovo automatico da
  verificare in fase di installazione).
- **Errore da evitare (lezione di oggi)**: nessuno script di gestione di `wt1` deve
  riavviare altri servizi (fail2ban, nginx, ecc.) come effetto collaterale — solo
  operazioni dirette e idempotenti sul demone/interfaccia in questione.

## Non in scope
- Sostituzione di NetBird Cloud (resta primario per tutto tranne il path di emergenza)
- Fallback IP pubblico diretto (opzione B della sessione precedente) — sostituito da
  questo piano
- Migrazione di sudoers/agent ProxyGuardian a un secondo canale — resta solo su `wt0`
