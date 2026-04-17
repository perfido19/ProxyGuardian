# Dashboard Cutover Checklist

Checklist operativa per spostare il VPS dashboard ProxyGuardian su una nuova macchina mantenendo lo stato attuale.

## Snapshot attuale

- VPS dashboard attuale: `185.229.236.50`
- Dominio: `secucam.net`
- App path: `/root/proxy-dashboard`
- Processo PM2: `proxy-dashboard`
- Porta app locale: `127.0.0.1:5000`
- Reverse proxy: nginx su `80/443`
- Overlay rete: NetBird richiesto per raggiungere gli agent `100.x.x.x`
- Backup consigliato: `/root/proxyguardian-dashboard-backup-current.tar.gz`

## Obiettivo

Portare sul nuovo VPS:

- codice dashboard allineato al repo GitHub
- `.env`, `data/`, `.session-secret`
- configurazione nginx + certificati TLS
- chiave SSH dashboard usata per fleet/agent
- GeoIP (`GeoIP.conf`, DB MaxMind, cron)
- PM2 e avvio app in produzione

## Prerequisiti

- nuovo VPS con Ubuntu e accesso `root`
- DNS del dominio modificabile
- accesso SSH sia al vecchio sia al nuovo VPS
- repository GitHub raggiungibile dal nuovo VPS
- backup creato dal vecchio VPS con `scripts/dashboard-backup.sh`

## Fase 1: Pre-cutover sul VPS attuale

1. Verifica stato applicazione:

```bash
pm2 describe proxy-dashboard
curl -sS -o /tmp/pg-precheck.json -w '%{http_code}\n' http://127.0.0.1:5000/api/nonexistent
netbird status
nginx -t
```

2. Genera un backup fresco:

```bash
cd /root/proxy-dashboard
bash scripts/dashboard-backup.sh /root/proxyguardian-dashboard-backup-current.tar.gz
```

3. Valida l'archivio sul VPS attuale:

```bash
bash scripts/dashboard-restore.sh --dry-run /root/proxyguardian-dashboard-backup-current.tar.gz
```

4. Copia il backup sul nuovo VPS:

```bash
scp /root/proxyguardian-dashboard-backup-current.tar.gz root@NUOVO_VPS:/root/
```

5. Abbassa il TTL DNS di `secucam.net` prima della finestra di cutover.

## Fase 2: Preparazione nuovo VPS

1. Clona il repo:

```bash
git clone https://github.com/perfido19/ProxyGuardian.git /root/proxy-dashboard
cd /root/proxy-dashboard
```

2. Collega il nuovo VPS a NetBird.

Verifica minima:

```bash
netbird status
```

Il cutover non va fatto se NetBird non e` connesso.

3. Esegui un dry-run del restore:

```bash
cd /root/proxy-dashboard
bash scripts/dashboard-restore.sh --dry-run /root/proxyguardian-dashboard-backup-current.tar.gz
```

4. Esegui il restore vero:

```bash
cd /root/proxy-dashboard
bash scripts/dashboard-restore.sh /root/proxyguardian-dashboard-backup-current.tar.gz
```

## Fase 3: Smoke test sul nuovo VPS prima del DNS cutover

Esegui tutti questi controlli sul nuovo VPS.

1. Processo app online:

```bash
pm2 describe proxy-dashboard
```

2. API locale risponde:

```bash
curl -sS -o /tmp/pg-smoke.json -w '%{http_code}\n' http://127.0.0.1:5000/api/nonexistent
cat /tmp/pg-smoke.json
```

3. nginx valido e attivo:

```bash
nginx -t
systemctl status nginx --no-pager
```

4. GeoIP presente:

```bash
ls -l /var/lib/GeoIP/GeoLite2-ASN.mmdb /var/lib/GeoIP/GeoLite2-Country.mmdb
cat /etc/GeoIP.conf
```

5. SSH key dashboard presente:

```bash
ls -l /root/.ssh/id_ed25519 /root/.ssh/id_ed25519.pub
```

6. NetBird attivo:

```bash
netbird status
```

7. Test dashboard lato browser:

- login riuscito
- lista VPS caricata
- almeno una VPS raggiungibile
- una chiamata `/api/ip-info/batch` rapida
- una route proxy verso agent riuscita

## Fase 4: Cutover DNS/IP

1. Tieni acceso il vecchio VPS.
2. Aggiorna `A`/`AAAA` di `secucam.net` verso il nuovo VPS.
3. Attendi propagazione coerente con il TTL ridotto.
4. Verifica dal browser che `https://secucam.net` risponda dal nuovo VPS.
5. Verifica login e operazioni base dalla dashboard pubblica.

## Fase 5: Verifiche post-cutover

Sul nuovo VPS:

```bash
pm2 logs proxy-dashboard --lines 100 --nostream
ss -ltnp | grep -E '(:80|:443|:5000)\>'
```

Verifiche funzionali:

- login utenti OK
- health fleet caricata
- dettaglio VPS apre correttamente
- `api/ipset` OK su una VPS
- `api/ip-info/batch` OK
- GeoIP fallback operativo
- deploy/fleet SSH non rotto

## Rollback

Se qualcosa non va:

1. lascia il vecchio VPS acceso e invariato
2. ripunta il DNS di `secucam.net` al vecchio IP `185.229.236.50`
3. verifica di nuovo accesso alla dashboard vecchia
4. continua il debug sul nuovo VPS senza interrompere l'operativita`

## Note pratiche

- Non committare mai `.env` o `data/vps.json`.
- Non saltare NetBird: senza overlay la dashboard non raggiunge gli agent.
- Se vuoi mantenere anche le sessioni web attive, genera il backup con `--include-sessions`.
- Il restore non fa il join a NetBird automaticamente: e` una scelta intenzionale.
- Il backup include anche overlay runtime del vecchio VPS, non solo il codice Git.
