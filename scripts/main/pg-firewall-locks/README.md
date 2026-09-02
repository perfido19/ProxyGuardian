# pg-firewall-locks (solo main, 80.244.4.35)

Auto-heal delle regole INPUT di allowlist per le porte sensibili di main dopo
un `iptables -F` / rebuild (come il 2026-07-04 che le cancello' e non furono
ripristinate — vedi memoria project_main_8880_lockdown_2026-09-02).

Protegge:
- `keep` (PRIMA di `CROWDSEC_CHAIN`): `udp/51820` (handshake NetBird) + `wt0 RELATED,ESTABLISHED`
- `:8880` streaming XtreamCodes -> solo lo + wt0 (NetBird flotta) + range Cloudflare (Worker `dynprocloud.net`), poi DROP
- `:7999` MariaDB XtreamCodes -> solo 127.0.0.1 + IP nodi streaming/LB, poi REJECT tcp-reset

`keep` sta prima di CROWDSEC_CHAIN (un ban CrowdSec sbagliato non deve poter
rompere il mesh). I blocchi porta stanno dopo (i ban devono vincere l'allowlist).

## Install su main (SSH diretto, main non ha pipeline dal repo)
```
scp pg-firewall-locks.* README.md root@<main>:/tmp/
install -d -m755 /etc/pg-firewall
install -m644 /tmp/pg-firewall-locks.conf    /etc/pg-firewall/locks.conf
install -m755 /tmp/pg-firewall-locks.sh      /usr/local/sbin/pg-firewall-locks.sh
install -m644 /tmp/pg-firewall-locks.service /etc/systemd/system/
install -m644 /tmp/pg-firewall-locks.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pg-firewall-locks.timer
systemctl enable pg-firewall-locks.service
```

## Aggiungere un nodo
Edita `/etc/pg-firewall/locks.conf` (riga `7999 src X.X.X.X/32`, e/o `8880 src ...`
se e' anche un proxy), poi:
```
/usr/local/sbin/pg-firewall-locks.sh      # oppure aspetta <=5min il timer
```

## Come funziona
- `pg-firewall-locks.service` (`Type=oneshot`, **NO `RemainAfterExit`** — altrimenti
  resta `active (exited)` e il timer non riesce a ri-triggerare), `After=netfilter-persistent`
- `pg-firewall-locks.timer` `OnCalendar=*-*-* *:00/5:00` (ogni 5 min) + `OnBootSec=90s`
- Idempotente: se `keep` + blocco di una porta sono gia' corretti (tutti gli ACCEPT +
  terminator dopo l'ultimo ACCEPT) non tocca nulla e non ri-salva. Altrimenti
  ricostruisce e ri-persiste (`netfilter-persistent save`).

## Debug
```
systemctl list-timers pg-firewall-locks.timer     # NEXT deve essere valorizzato
journalctl -u pg-firewall-locks.service -n 20
```
Se `NEXT n/a` / `SubState=running` sul timer: il service e' rimasto `active (exited)`
(residuo di RemainAfterExit). Fix: `systemctl stop pg-firewall-locks.service` + `daemon-reload` + restart timer.
