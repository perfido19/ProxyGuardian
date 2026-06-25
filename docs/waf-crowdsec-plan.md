# Analisi WAF per ProxyGuardian Fleet

## Stack di sicurezza ESISTENTE (già deployato su ogni VPS)

| Layer | Strumento | Cosa copre |
|---|---|---|
| L7 WAF | **ModSecurity** (ngx_http_modsecurity_module) | SQLi, XSS, path traversal, RCE, injection, malformed requests |
| L7 | **nginx rate limiting** | 3 zone: auth 1r/s, api 3r/s, stream 30r/s + 10 conn concurrent |
| L7 | **User-Agent filtering** | Bots, scanner, crawler, bruteforcer → 444 |
| L7 | **GeoIP2** | Country whitelist (255 paesi), ASN block (1294 ASN), ISP block (5) |
| L4 | **fail2ban** (6 jail) | sshd, xtream, xtream-api, nginx-abuse, block22, 404-0 |
| L3 | **ipset `blocked_asn`** | ASN cloud/telecom/proxy blocklist aggiornata periodicamente |
| L3 | **ipset `iptv_ban`** | Anti-IPTV: IP che usano >2 username → ban 7gg |
| Deploy | Script automatizzato | Tutto quanto sopra installato via ProxyGuardian deploy |

ModSecurity ha già regole custom IPTV (ID 500100-500130): oversized credentials,
duplicate params, OGNL injection, SQL detection. Paranoia level 1 per minimizzare
falsi positivi sulle API stream.

---

## Valutazione SafeLine

**SafeLine NON è consigliato** per questa infrastruttura.

Motivi:

1. **Ridondante** — SafeLine è un altro WAF L7. ModSecurity già copre SQLi/XSS/RCE
   che sono esattamente le categorie di SafeLine. Doppio WAF = doppia complessità,
   nessun beneficio netto.

2. **Architettura incompatibile** — SafeLine funziona come **reverse proxy Docker**
   davanti a nginx. Su questi VPS significherebbe:
   `client → SafeLine (Docker) → nginx → xtream codes`
   Aggiunge un hop, latenza, overhead di container, riscrittura delle config nginx.

3. **Non progettato per fleet** — SafeLine gestisce un'istanza alla volta.
   Non ha concetto di fleet-management per 53 VPS. Nessuna UI centralizzata
   né API per sincronizzare regole cross-VPS.

4. **Attack surface sbagliata** — SafeLine eccelle su web app con form, sessioni,
   autenticazioni complesse. Gli attacchi reali su questa fleet sono:
   - Credential stuffing (account multipli da stesso IP)
   - ASN cloud/proxy abuse
   - SSH brute force

---

## Raccomandazione: CrowdSec

**CrowdSec** è la scelta più adatta a questa specifica infrastruttura.

### Perché

- Progettato esattamente per **credential stuffing, brute force, account enumeration**
- **Community intelligence**: blocklist IPTV/proxy/VPN condivise (50M+ IP classificati)
- **Fleet-native**: LAPI centrale → un IP bannato su un VPS bloccato automaticamente sugli altri 52
- **Lightweight**: binario Go, nessun reverse proxy, overhead minimo
- **Integrazione nginx nativa**: nginx bouncer blocca a livello request prima del processing

### Gap che copre

| Gap attuale | CrowdSec |
|---|---|
| Ban fleet non coordinato (ogni VPS decide da solo) | LAPI centrale: decisione condivisa automaticamente |
| fail2ban reagisce solo ai log locali | CrowdSec vede pattern cross-fleet |
| Nessuna intelligence esterna sugli IP | Community blocklist aggiornata in tempo reale |
| BanSync manuale ogni 60s | CrowdSec propagazione in tempo reale |

### Architettura risultante (nessun cambiamento nginx esistente)

```
client → nginx (ModSecurity + rate limit + GeoIP) → xtream codes
              ↑
         crowdsec-nginx-bouncer (blocca IP con decisione attiva)
              ↑
         crowdsec agent (analizza log nginx/fail2ban, applica scenari)
              ↑
         LAPI (locale per ora, opzionale centrale)
```

---

## Piano implementativo

### Fase 1 — Deploy script (`server/routes.ts`)
Aggiungere blocco CrowdSec al `generateDeployScript()`:
- `apt install crowdsec crowdsec-nginx-bouncer`
- Configura scenario `crowdsecurity/nginx-req-limit-exceeded` + custom `xtream-credential-stuffing`
- Configura nginx bouncer in `nginx.conf` http block

### Fase 2 — Agent endpoints (`agent/index.ts`)
3 endpoint: decisions, alerts, unban via `cscli decisions` e `cscli alerts`
Sudoers: `cscli *`

### Fase 3 — Dashboard (`vps-detail.tsx` + `server/routes.ts`)
Tab CrowdSec in vps-detail (come fail2ban jail ma per CrowdSec decisions)
Route fleet `GET /api/fleet/crowdsec/summary`

### Fase 4 — Rebuild e deploy agent
`cd agent && npm run build` + push bundle + aggiornamento fleet

---

## Piano Produzione

### Strategia: Pilota Secucam → Fleet

**VPS pilota**: `Secucam` (100.116.1.46) — traffico reale ma non critico per il business.
Osservazione minima: **48h** prima di procedere fleet.

---

### Step 1 — SSH su Secucam, installa manualmente

```bash
ssh root@100.116.1.46

# Installa CrowdSec + nginx bouncer
apt install -y crowdsec crowdsec-nginx-bouncer

# Installa scenari IPTV/proxy
cscli collections install crowdsecurity/nginx
cscli scenarios install crowdsecurity/nginx-req-limit-exceeded
cscli scenarios install crowdsecurity/http-probing

# Verifica servizio
systemctl status crowdsec
cscli decisions list
cscli alerts list
```

### Step 2 — Configura nginx bouncer su Secucam

```bash
# /etc/crowdsec/bouncers/crowdsec-nginx-bouncer.conf
# Verificare che API_KEY sia generata: cscli bouncers add nginx-bouncer
nano /etc/crowdsec/bouncers/crowdsec-nginx-bouncer.conf

# Aggiunge a nginx.conf nel blocco http {}:
# lua_package_path "/usr/lib/x86_64-linux-gnu/lua/5.1/?.so;/usr/share/lua/5.1/?.lua;;";
# include /etc/crowdsec/bouncers/crowdsec-nginx-bouncer.conf;
nginx -t && systemctl reload nginx
```

### Step 3 — Sudoers per agent ProxyGuardian

```bash
# Aggiunge al file sudoers agent (pgagent):
echo "pgagent ALL=(ALL) NOPASSWD: /usr/bin/cscli *" >> /etc/sudoers.d/pgagent
visudo -c  # verifica sintassi
```

### Step 4 — Osservazione 48h su Secucam

Metriche da monitorare via dashboard:
- `cscli decisions list` — IP bannati da CrowdSec
- `cscli alerts list` — alert con scenario scatenante
- Log nginx: nessun falso positivo sulle API IPTV (get.php, player_api.php)
- Fail2ban: continua a funzionare in parallelo (non rimuovere)

**Criteri per procedere fleet:**
- Nessun falso positivo su utenti legittimi
- Almeno 1 ban CrowdSec reale rilevato
- nginx stabile, nessun errore Lua nel log

### Step 5 — Deploy automatico fleet (dopo validazione pilota)

Attivare checkbox `installCrowdSec` nel deploy script (Fase 1 del piano implementativo).
Eseguire update agent su tutti i VPS per aggiungere endpoint CrowdSec (Fase 2).
Roll-out via ProxyGuardian fleet deploy — escludere DynamoXc (come per Anti-IPTV).

---

### Rollback Secucam (se problemi)

```bash
# Rimuove bouncer da nginx (unico impatto operativo)
# Commenta le righe lua in nginx.conf
nginx -t && systemctl reload nginx

# Stop CrowdSec (non impatta fail2ban che continua)
systemctl stop crowdsec
apt remove crowdsec crowdsec-nginx-bouncer
```

Fail2ban e ipset rimangono attivi durante e dopo rollback — zero downtime protezione.

---

## Alternativa minima (senza CrowdSec)

1. **ModSecurity Paranoia Level 2** per le sole API
2. **Ban cross-VPS automatico**: IP bannato su >3 VPS in <1h → ban fleet (estende BanSync)
3. **Anomaly score da ModSecurity** nel log format nginx → feed a fail2ban
