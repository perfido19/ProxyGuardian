# Guida Installazione Dashboard Proxy su VPS Ubuntu

Questa guida ti aiuterà ad installare e configurare la Dashboard di gestione Proxy nginx con fail2ban sul tuo VPS Ubuntu.

## Prerequisiti

- VPS con Ubuntu 20.04 LTS o successivo
- Accesso root o sudo
- Sistema proxy già configurato con nginx, fail2ban, ModSecurity (opzionale: se non hai il sistema proxy, la dashboard funzionerà comunque mostrando dati mock)

## 1. Installazione Node.js 20

La dashboard richiede Node.js 20. Installiamolo:

```bash
# Aggiorna i pacchetti di sistema
sudo apt update && sudo apt upgrade -y

# Installa curl se non presente
sudo apt install -y curl

# Aggiungi repository NodeSource per Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -

# Installa Node.js
sudo apt install -y nodejs

# Verifica l'installazione
node --version  # Dovrebbe mostrare v20.x.x
npm --version   # Dovrebbe mostrare 10.x.x o superiore
```

## 2. Trasferimento del Progetto sul VPS

Hai diverse opzioni per trasferire i file sul VPS:

### Opzione A: Con Repository Git

```bash
cd ~
git clone <URL_REPOSITORY> proxy-dashboard
cd proxy-dashboard
```

### Opzione B: Senza Repository (SCP/SFTP)

**Dal tuo computer locale**, crea un archivio e caricalo:

```bash
# Sul tuo computer locale, nella cartella del progetto
tar -czf proxy-dashboard.tar.gz .

# Carica sul VPS con SCP (sostituisci IP_VPS con l'IP del tuo server)
scp proxy-dashboard.tar.gz root@IP_VPS:~/

# Oppure usa un client SFTP come FileZilla, WinSCP, Cyberduck
```

**Sul VPS**, estrai l'archivio:

```bash
# Connettiti al VPS via SSH
ssh root@IP_VPS

# Crea directory e estrai
mkdir -p ~/proxy-dashboard
tar -xzf proxy-dashboard.tar.gz -C ~/proxy-dashboard
cd ~/proxy-dashboard

# Pulisci l'archivio
rm ~/proxy-dashboard.tar.gz
```

### Opzione C: Con rsync (più veloce per aggiornamenti)

```bash
# Dal tuo computer locale
rsync -avz --exclude 'node_modules' \
  /percorso/locale/proxy-dashboard/ \
  root@IP_VPS:~/proxy-dashboard/
```

## 3. Installazione Dipendenze

```bash
# Installa tutte le dipendenze del progetto
npm install
```

Questo processo richiederà alcuni minuti. L'installazione include:
- React, TypeScript per il frontend
- Express.js per il backend
- Vite per il build system
- Tutte le librerie UI (Shadcn, Tailwind CSS)

## 4. Configurazione Permessi

**IMPORTANTE**: Se usi l'utenza **root** per il login, **puoi saltare questa sezione** e passare direttamente al punto 5. Root ha già tutti i permessi necessari e non serve configurare sudo.

⚠️ **Nota sulla Sicurezza**: Eseguire applicazioni con root è funzionale ma sconsigliato in produzione. Per maggiore sicurezza, considera di creare un utente dedicato con privilegi limitati.

---

Per funzionare correttamente, la dashboard necessita di:
- Permessi di lettura sui file di log
- Permessi di esecuzione per i comandi di sistema
- Permessi di lettura/scrittura sui file di configurazione

### Opzione A: Esecuzione con sudo o root (più semplice)

```bash
# Con utente non-root
sudo npm run dev

# Con root (no sudo necessario)
npm run dev
```

### Opzione B: Configurazione permessi granulari (consigliato per produzione)

```bash
# Crea un utente dedicato per la dashboard
sudo useradd -r -m -s /bin/bash dashboard

# Aggiungi l'utente ai gruppi necessari
sudo usermod -aG adm dashboard  # Per leggere i log

# Configura sudoers per comandi specifici (ATTENZIONE: modifica con cautela)
sudo visudo

# Aggiungi queste righe (sostituisci 'dashboard' con il tuo utente):
dashboard ALL=(ALL) NOPASSWD: /bin/systemctl status nginx
dashboard ALL=(ALL) NOPASSWD: /bin/systemctl status fail2ban
dashboard ALL=(ALL) NOPASSWD: /bin/systemctl status mariadb
dashboard ALL=(ALL) NOPASSWD: /bin/systemctl start nginx
dashboard ALL=(ALL) NOPASSWD: /bin/systemctl stop nginx
dashboard ALL=(ALL) NOPASSWD: /bin/systemctl restart nginx
dashboard ALL=(ALL) NOPASSWD: /bin/systemctl reload nginx
dashboard ALL=(ALL) NOPASSWD: /bin/systemctl start fail2ban
dashboard ALL=(ALL) NOPASSWD: /bin/systemctl stop fail2ban
dashboard ALL=(ALL) NOPASSWD: /bin/systemctl restart fail2ban
dashboard ALL=(ALL) NOPASSWD: /usr/bin/fail2ban-client *

# Imposta i permessi sui file di configurazione
sudo chown -R dashboard:dashboard ~/proxy-dashboard
sudo chmod -R 755 ~/proxy-dashboard

# Permetti la lettura dei file di configurazione nginx
sudo chmod 644 /etc/nginx/*.conf
sudo chmod 644 /etc/nginx/conf.d/*.conf

# Permetti la lettura/scrittura dei file fail2ban
sudo chmod 664 /etc/fail2ban/jail.local
sudo chmod 664 /etc/fail2ban/fail2ban.local
sudo chmod 664 /etc/fail2ban/filter.d/*.conf
```

## 5. Avvio della Dashboard

### Modalità Sviluppo (per test)

```bash
# Avvia in modalità development
npm run dev
```

La dashboard sarà accessibile su `http://IP_VPS:5000`

### Modalità Produzione con PM2

Per mantenere la dashboard sempre attiva, usa PM2:

```bash
# Installa PM2 globalmente
sudo npm install -g pm2

# Compila il progetto (opzionale per produzione)
npm run build

# Avvia con PM2
pm2 start npm --name "proxy-dashboard" -- run dev

# Configura l'avvio automatico
pm2 startup
pm2 save

# Comandi utili PM2:
pm2 status              # Visualizza stato
pm2 logs proxy-dashboard # Visualizza log
pm2 restart proxy-dashboard # Riavvia
pm2 stop proxy-dashboard    # Ferma
pm2 delete proxy-dashboard  # Rimuovi
```

## 6. File di Configurazione

### Creazione Automatica

La dashboard **crea automaticamente** i file di configurazione se non esistono:

- `country_whitelist.conf` - Whitelist paesi
- `block_asn.conf` - Blacklist ASN
- `block_isp.conf` - Blacklist ISP
- `useragent.rules` - Blocco User-Agent
- `ip_whitelist.conf` - IP esclusi da rate limiting
- `exclusion_ip.conf` - IP esclusi da blocco geografico

I file vengono creati in `/etc/nginx/` con template di esempio al primo accesso dalla dashboard.

### Permessi File Configurazione

Se i file non vengono visualizzati correttamente, verifica i permessi:

```bash
# Rendi leggibili i file nginx
sudo chmod 644 /etc/nginx/country_whitelist.conf
sudo chmod 644 /etc/nginx/block_asn.conf
sudo chmod 644 /etc/nginx/block_isp.conf
sudo chmod 644 /etc/nginx/useragent.rules
sudo chmod 644 /etc/nginx/ip_whitelist.conf
sudo chmod 644 /etc/nginx/exclusion_ip.conf

# Se l'utente dashboard non può scriverli, aggiungi permessi di scrittura
sudo chmod 664 /etc/nginx/*.conf
sudo chmod 664 /etc/nginx/*.rules
```

### Verifica Configurazione Nginx

Dopo aver modificato i file di configurazione, **ricarica nginx**:

```bash
# Testa la configurazione
sudo nginx -t

# Se OK, ricarica nginx
sudo systemctl reload nginx
```

## 7. Configurazione Nginx Status (Opzionale ma Consigliato)

Per visualizzare le **connessioni attive** in tempo reale, configura nginx stub_status:

```bash
# Crea file di configurazione per nginx status
sudo nano /etc/nginx/conf.d/status.conf
```

Aggiungi questo contenuto:

```nginx
server {
    listen 127.0.0.1:80;
    server_name localhost;

    location /nginx_status {
        stub_status on;
        access_log off;
        allow 127.0.0.1;
        deny all;
    }
}
```

Salva e testa la configurazione:

```bash
# Testa configurazione
sudo nginx -t

# Ricarica nginx
sudo systemctl reload nginx

# Verifica funzionamento
curl http://localhost/nginx_status
# Output atteso:
# Active connections: 2
# server accepts handled requests
#  1234 1234 5678
```

**Nota**: Se nginx_status non è configurato, la dashboard userà automaticamente `ss` o `netstat` per contare le connessioni TCP sulla porta 8880 (meno preciso ma funzionante).

## 8. Configurazione Firewall

Apri la porta 5000 per accedere alla dashboard:

```bash
# Con UFW (Ubuntu Firewall)
sudo ufw allow 5000/tcp
sudo ufw status

# Con iptables
sudo iptables -A INPUT -p tcp --dport 5000 -j ACCEPT
sudo iptables-save > /etc/iptables/rules.v4
```

**IMPORTANTE**: Per sicurezza, considera di limitare l'accesso solo da IP specifici:

```bash
# Consenti solo dal tuo IP
sudo ufw allow from TUO_IP to any port 5000
```

## 9. Configurazione HTTPS (Opzionale ma Consigliato)

Per produzione, usa un reverse proxy nginx per HTTPS:

```bash
# Installa certbot per SSL gratuito
sudo apt install -y certbot python3-certbot-nginx

# Crea configurazione nginx per la dashboard
sudo nano /etc/nginx/sites-available/dashboard
```

Inserisci:

```nginx
server {
    listen 80;
    server_name dashboard.tuodominio.com;

    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Attiva e ottieni certificato SSL:

```bash
# Abilita il sito
sudo ln -s /etc/nginx/sites-available/dashboard /etc/nginx/sites-enabled/

# Testa configurazione
sudo nginx -t

# Ricarica nginx
sudo systemctl reload nginx

# Ottieni certificato SSL (sostituisci con il tuo dominio)
sudo certbot --nginx -d dashboard.tuodominio.com
```

## 10. Verifica Installazione

Accedi alla dashboard:

1. Apri browser e vai su `http://IP_VPS:5000` (o `https://dashboard.tuodominio.com` se hai configurato HTTPS)
2. Dovresti vedere la dashboard con:
   - Statistiche dei servizi
   - Lista IP bannati
   - Grafici in tempo reale
   - Menu di navigazione funzionante

### Risoluzione Problemi

**La dashboard non si connette ai servizi reali?**
- Verifica i permessi: `sudo chmod 644 /etc/nginx/*.conf`
- Controlla i log: `pm2 logs proxy-dashboard` o `sudo tail -f ~/proxy-dashboard/logs/app.log`
- Verifica SystemCapabilities nei log: dovrebbe rilevare fail2ban e nginx

**Errori di permessi?**
- Assicurati che l'utente abbia accesso ai comandi sudo configurati
- Verifica: `sudo -l` per vedere i comandi consentiti

**Porta 5000 già in uso?**
```bash
# Trova il processo
sudo lsof -i :5000

# Cambia porta nel file server/index.ts (cerca la riga con port 5000)
```

## 11. Backup e Manutenzione

### Backup Configurazioni

```bash
# Crea script di backup
cat > ~/backup-dashboard.sh << 'EOF'
#!/bin/bash
BACKUP_DIR=~/dashboard-backups
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

# Backup file nginx
tar -czf $BACKUP_DIR/nginx_$DATE.tar.gz /etc/nginx/*.conf

# Backup file fail2ban
tar -czf $BACKUP_DIR/fail2ban_$DATE.tar.gz /etc/fail2ban/*.local /etc/fail2ban/filter.d/*.conf

# Mantieni solo ultimi 7 backup
find $BACKUP_DIR -name "*.tar.gz" -mtime +7 -delete

echo "Backup completato: $BACKUP_DIR"
EOF

chmod +x ~/backup-dashboard.sh

# Esegui backup manuale
~/backup-dashboard.sh

# Configura backup automatico giornaliero
(crontab -l 2>/dev/null; echo "0 2 * * * ~/backup-dashboard.sh") | crontab -
```

### Aggiornamento Dashboard

```bash
cd ~/proxy-dashboard

# Ferma il servizio
pm2 stop proxy-dashboard

# Backup prima di aggiornare
cp -r ~/proxy-dashboard ~/proxy-dashboard.backup

# Aggiorna codice
git pull  # O estrai nuovo archivio

# Aggiorna dipendenze
npm install

# Riavvia
pm2 restart proxy-dashboard
```

## 12. Monitoraggio

### Log dell'Applicazione

```bash
# Log in tempo reale
pm2 logs proxy-dashboard

# Log specifici
tail -f ~/.pm2/logs/proxy-dashboard-out.log  # Output
tail -f ~/.pm2/logs/proxy-dashboard-error.log  # Errori
```

### Monitoraggio Risorse

```bash
# Uso memoria e CPU
pm2 monit

# Statistiche dettagliate
pm2 show proxy-dashboard
```

## Supporto e Troubleshooting

### Controlla SystemCapabilities

La dashboard rileva automaticamente le capabilities del sistema. Per verificare:

```bash
# Cerca nei log
pm2 logs proxy-dashboard | grep "SystemCapabilities"

# Dovresti vedere qualcosa tipo:
# [SystemCapabilities] Detected: {
#   hasSystemctl: true,
#   hasFail2ban: true,
#   hasNginxConfigs: true,
#   hasLogFiles: true
# }
```

Se alcune capabilities sono `false`, verifica i permessi o l'installazione del componente corrispondente.

### Comandi Diagnostici

```bash
# Verifica nginx
sudo systemctl status nginx

# Verifica fail2ban
sudo systemctl status fail2ban
sudo fail2ban-client status

# Verifica permessi file
ls -la /etc/nginx/*.conf
ls -la /etc/fail2ban/*.local

# Test connettività dashboard
curl http://localhost:5000/api/services
```

## Sicurezza

**Raccomandazioni importanti:**

1. **Non esporre la porta 5000 pubblicamente** - Usa sempre nginx con HTTPS
2. **Implementa autenticazione** - La dashboard attualmente non ha auth (feature futura)
3. **Limita accesso via IP** - Usa firewall per limitare chi può accedere
4. **Mantieni aggiornato** - Aggiorna regolarmente Node.js e dipendenze
5. **Monitora log** - Controlla regolarmente i log per accessi sospetti

```bash
# Esempio: limita accesso solo dalla tua rete
sudo ufw allow from 192.168.1.0/24 to any port 5000
```

## Conclusione

La dashboard è ora installata e funzionante! Puoi:
- ✅ Monitorare servizi nginx, fail2ban, MariaDB
- ✅ Gestire IP bannati
- ✅ Configurare jail e filtri fail2ban
- ✅ Modificare regex di rilevamento
- ✅ Visualizzare log in tempo reale
- ✅ Editare configurazioni nginx e fail2ban

Per supporto o domande, consulta la documentazione in `replit.md`.
