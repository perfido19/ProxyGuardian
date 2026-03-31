#!/bin/bash
# proxy_upgrade.sh
# Upgrade: Nginx 1.20.1 → 1.26.2 + ModSecurity v2 → v3 + OWASP CRS v3 → v4
#
# NON tocca: nginx.conf (backend/porta), jail.local, filtri fail2ban custom,
#            country_whitelist, block_asn, block_isp, useragent.rules
#
# Uso: bash /tmp/proxy_upgrade.sh
# Richiede: root, connessione internet

set -e

# ─────────────────────────────────────────────────────────────
# VERSIONI
# ─────────────────────────────────────────────────────────────
NGINX_VERSION="1.26.2"
MODSEC_TAG="v3.0.12"
GEOIP2_MODULE_VERSION="3.4"
numcpu=$(nproc)
BACKUP_DIR="/root/pg-backup-$(date +%Y%m%d-%H%M)"

# --- SWAP TEMPORANEO (per VPS con poca RAM durante compilazione) ---
SWAP_FILE="/tmp/pg_swap"
SWAP_CREATED=0

create_swap() {
    local avail_ram_mb disk_free_mb max_swap_mb swap_mb
    avail_ram_mb=$(grep MemAvailable /proc/meminfo | awk "{print int(\$2/1024)}")
    disk_free_mb=$(df -m / --output=avail | tail -1 | xargs)
    max_swap_mb=$(( disk_free_mb - 1200 ))
    if [ "$max_swap_mb" -le 0 ]; then max_swap_mb=0; fi
    if [ "$max_swap_mb" -gt 1024 ]; then max_swap_mb=1024; fi
    if [ "$avail_ram_mb" -lt 700 ] && [ "$max_swap_mb" -ge 200 ]; then
        swap_mb=$max_swap_mb
        warn "RAM: ${avail_ram_mb}MB. Creo swap ${swap_mb}MB (disco rimasto: $(( disk_free_mb - swap_mb ))MB)"
        dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$swap_mb" status=none
        chmod 600 "$SWAP_FILE"
        mkswap "$SWAP_FILE" > /dev/null
        swapon "$SWAP_FILE"
        SWAP_CREATED=1
        log "Swap ${swap_mb}MB attivato"
    else
        log "RAM ${avail_ram_mb}MB OK o disco ${disk_free_mb}MB insufficiente, skip swap"
    fi
}


remove_swap() {
    if [ "$SWAP_CREATED" -eq 1 ] && [ -f "$SWAP_FILE" ]; then
        swapoff "$SWAP_FILE" 2>/dev/null || true
        rm -f "$SWAP_FILE"
        SWAP_CREATED=0
        log "Swap temporaneo rimosso"
    fi
}
free_disk_space() {
    log "Pulizia spazio disco prima della compilazione..."
    # Rimuovi swap file parziale da run precedenti
    swapoff /tmp/pg_swap 2>/dev/null || true
    rm -f /tmp/pg_swap
    # Rimuovi vecchi pg-backup (tieni solo il piu recente)
    ls -dt /root/pg-backup-* 2>/dev/null | tail -n +2 | xargs rm -rf 2>/dev/null || true
    # Rimuovi vecchie build ModSecurity (verranno ri-clonate)
    rm -rf /usr/local/src/ModSecurity-v3 2>/dev/null || true
    rm -rf /usr/local/src/ModSecurity-v2-backup 2>/dev/null || true
    # Rimuovi vecchi build nginx
    rm -rf /usr/local/src/nginx-1.20.1 2>/dev/null || true
    rm -f /usr/local/src/nginx-1.20.1.tar.gz* /usr/local/src/master.tar.gz* 2>/dev/null || true
    # Vacuum journal
    journalctl --vacuum-size=100M 2>/dev/null || true
    local avail_mb
    avail_mb=$(df -m / --output=avail | tail -1 | xargs)
    log "Spazio disponibile dopo pulizia: ${avail_mb}MB"
    if [ "${avail_mb}" -lt 2000 ]; then
        warn "Meno di 2GB liberi. Upgrade potrebbe fallire per spazio disco."
    fi
}



# ─────────────────────────────────────────────────────────────
# COLORI E LOG
# ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*"; }

# ─────────────────────────────────────────────────────────────
# CONTROLLO ROOT
# ─────────────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    err "Eseguire come root"
    exit 1
fi

log "=== Proxy Upgrade Script ==="
log "Nginx: $NGINX_VERSION | ModSecurity: $MODSEC_TAG | CRS: v4"
log "CPU: $numcpu core | Backup: $BACKUP_DIR"
echo ""

# ─────────────────────────────────────────────────────────────
# STEP 1: BACKUP
# ─────────────────────────────────────────────────────────────
log "STEP 1: Backup configurazioni..."
mkdir -p "$BACKUP_DIR/etc-nginx"
mkdir -p "$BACKUP_DIR/fail2ban"

cp -a /etc/nginx/. "$BACKUP_DIR/etc-nginx/"
cp /etc/fail2ban/jail.local "$BACKUP_DIR/fail2ban/" 2>/dev/null || true
cp -a /etc/fail2ban/filter.d/. "$BACKUP_DIR/fail2ban/filter.d/" 2>/dev/null || true

# Salva il vecchio nginx binary
cp /usr/sbin/nginx "$BACKUP_DIR/nginx.old" 2>/dev/null || \
  cp /usr/share/nginx/sbin/nginx "$BACKUP_DIR/nginx.old"

log "Backup completato in $BACKUP_DIR"

# ─────────────────────────────────────────────────────────────
# FUNZIONE ROLLBACK
# ─────────────────────────────────────────────────────────────
rollback() {
    trap - ERR  # disabilita il trap ricorsivo durante il rollback
    err "Rollback in corso..."
    remove_swap 2>/dev/null || true
    cp "$BACKUP_DIR/nginx.old" /usr/share/nginx/sbin/nginx
    ln -sf /usr/share/nginx/sbin/nginx /usr/sbin/nginx
    cp -a "$BACKUP_DIR/etc-nginx/." /etc/nginx/
    nginx -t && systemctl restart nginx && log "Rollback completato, vecchio nginx ripristinato."
    exit 1
}

# Rollback automatico su qualsiasi errore imprevisto (set -e + trap)
trap 'err "Errore imprevisto alla riga $LINENO. Avvio rollback automatico..."; rollback' ERR

# ─────────────────────────────────────────────────────────────
# STEP 2: DIPENDENZE
# ─────────────────────────────────────────────────────────────
log "STEP 2: Installazione dipendenze..."
apt-get update -qq
apt-get install -y -qq \
    build-essential \
    libpcre3 libpcre3-dev \
    zlib1g-dev libssl-dev \
    libxslt1-dev \
    libxml2-dev libcurl4-openssl-dev \
    libyajl-dev liblua5.1-0-dev \
    git libtool autoconf automake pkgconf \
    wget

# ─────────────────────────────────────────────────────────────
# STEP 3: LIBMODSECURITY v3
# ─────────────────────────────────────────────────────────────
free_disk_space
create_swap
log "STEP 3: Compilazione libmodsecurity3 ($MODSEC_TAG)..."
cd /usr/local/src

# Rinomina il vecchio ModSecurity per non confondersi
if [ -d "ModSecurity" ]; then
    mv ModSecurity ModSecurity-v2-backup
fi

# Rimuovi directory esistente per evitare errore git clone (exit 128)
rm -rf ModSecurity-v3

git clone --depth 1 -b "$MODSEC_TAG" \
    https://github.com/SpiderLabs/ModSecurity ModSecurity-v3
cd ModSecurity-v3
git submodule init
git submodule update
./build.sh
./configure
make -j 1 CXXFLAGS="-O0 -g0"
make install
log "libmodsecurity3 installata."
remove_swap

# ─────────────────────────────────────────────────────────────
# STEP 4: MODSECURITY-NGINX CONNECTOR
# ─────────────────────────────────────────────────────────────
log "STEP 4: ModSecurity-nginx connector..."
cd /usr/local/src
rm -rf ModSecurity-nginx
git clone --depth 1 \
    https://github.com/SpiderLabs/ModSecurity-nginx ModSecurity-nginx

# ─────────────────────────────────────────────────────────────
# STEP 5: GEOIP2 MODULE
# ─────────────────────────────────────────────────────────────
log "STEP 5: ngx_http_geoip2_module v$GEOIP2_MODULE_VERSION..."
cd /usr/local/src
rm -rf ngx_http_geoip2_module-"$GEOIP2_MODULE_VERSION" geoip2.tar.gz
wget -q "https://github.com/leev/ngx_http_geoip2_module/archive/refs/tags/${GEOIP2_MODULE_VERSION}.tar.gz" \
    -O geoip2.tar.gz
tar zxf geoip2.tar.gz
GEOIP2_DIR="/usr/local/src/ngx_http_geoip2_module-${GEOIP2_MODULE_VERSION}"

# ─────────────────────────────────────────────────────────────
# STEP 3c: REGISTRA LIBMODSECURITY NEL LINKER
# ─────────────────────────────────────────────────────────────
log "STEP 3c: Registrazione libmodsecurity in ldconfig..."
echo "/usr/local/modsecurity/lib" > /etc/ld.so.conf.d/modsecurity.conf
ldconfig
ldconfig -p | grep -q modsecurity && log "  → libmodsecurity.so.3 OK" || warn "  → libmodsecurity non trovata in ldconfig"

# ─────────────────────────────────────────────────────────────
# STEP 6: COMPILA NGINX 1.26.2
# Nota: nginx.org può essere irraggiungibile da alcuni VPS.
# Se il download fallisce, copia manualmente nginx-1.26.2.tar.gz
# in /usr/local/src/ prima di eseguire questo script.
# ─────────────────────────────────────────────────────────────
log "STEP 6: Compilazione Nginx $NGINX_VERSION (può richiedere 10-15 min)..."
cd /usr/local/src
rm -rf "nginx-${NGINX_VERSION}"

# Scarica solo se il tar.gz non è già presente (es. copiato via SCP)
if [ ! -f "nginx-${NGINX_VERSION}.tar.gz" ]; then
    log "  → Download nginx da nginx.org..."
    wget -q --timeout=60 "http://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz" || {
        err "Download nginx fallito. Copia manualmente nginx-${NGINX_VERSION}.tar.gz in /usr/local/src/ e rilancia."
        exit 1
    }
fi
tar xzf "nginx-${NGINX_VERSION}.tar.gz"
cd "nginx-${NGINX_VERSION}"

PKG_CONFIG_PATH=/usr/local/modsecurity/lib/pkgconfig \
./configure \
    --with-cc-opt='-g -O2 -fPIE -fstack-protector-strong -Wformat -Werror=format-security -fPIC -Wdate-time -D_FORTIFY_SOURCE=2' \
    --with-ld-opt='-Wl,-Bsymbolic-functions -fPIE -pie -Wl,-z,relro -Wl,-z,now -fPIC' \
    --prefix=/usr/share/nginx \
    --conf-path=/etc/nginx/nginx.conf \
    --http-log-path=/var/log/nginx/access.log \
    --error-log-path=/var/log/nginx/error.log \
    --lock-path=/var/lock/nginx.lock \
    --pid-path=/run/nginx.pid \
    --modules-path=/usr/lib/nginx/modules \
    --http-client-body-temp-path=/var/lib/nginx/body \
    --http-fastcgi-temp-path=/var/lib/nginx/fastcgi \
    --http-proxy-temp-path=/var/lib/nginx/proxy \
    --http-scgi-temp-path=/var/lib/nginx/scgi \
    --http-uwsgi-temp-path=/var/lib/nginx/uwsgi \
    --with-pcre-jit \
    --with-http_ssl_module \
    --with-http_stub_status_module \
    --with-http_realip_module \
    --with-http_auth_request_module \
    --with-http_v2_module \
    --with-http_dav_module \
    --with-http_slice_module \
    --with-threads \
    --with-http_addition_module \
    --with-http_gunzip_module \
    --with-http_gzip_static_module \
    --with-http_sub_module \
    --with-http_xslt_module=dynamic \
    --with-stream=dynamic \
    --with-stream_ssl_module \
    --with-stream_ssl_preread_module \
    --with-mail=dynamic \
    --with-mail_ssl_module \
    --add-dynamic-module=/usr/local/src/ModSecurity-nginx \
    --add-dynamic-module="$GEOIP2_DIR"

make -j "$numcpu"

# Rimuovi i vecchi moduli .so PRIMA di make install per evitare che moduli
# compilati per la versione precedente (1.20) restino affianco ai nuovi (1.26).
# Un mix di ABI diverse causa il crash di nginx al caricamento dei moduli.
log "  → Pulizia moduli nginx precedenti..."
rm -f /usr/lib/nginx/modules/*.so 2>/dev/null || true

make install

# Ripristina nginx.conf personalizzato: make install sovrascrive con quello
# di default, ma il backup in STEP 1 contiene la configurazione reale.
if [ -f "$BACKUP_DIR/etc-nginx/nginx.conf" ]; then
    cp "$BACKUP_DIR/etc-nginx/nginx.conf" /etc/nginx/nginx.conf
    log "  → nginx.conf personalizzato ripristinato (make install lo aveva sovrascritto)"
fi

# ─────────────────────────────────────────────────────────────
# STEP 7: SYMLINK BINARIO E MODULI
# ─────────────────────────────────────────────────────────────
log "STEP 7: Aggiornamento symlink e directory cache..."
ln -sf /usr/share/nginx/sbin/nginx /usr/sbin/nginx
ln -sf /usr/lib/nginx/modules /usr/share/nginx/modules
mkdir -p /var/lib/nginx/body

# Ricrea le directory di cache nginx referenziate in nginx.conf.
# Se mancano, nginx fallisce all'avvio anche con configurazione corretta.
mkdir -p /var/cache/nginx/epg /var/cache/nginx/streaming
chown -R www-data:www-data /var/cache/nginx 2>/dev/null || \
    chown -R www-data /var/cache/nginx 2>/dev/null || true
log "  → Directory cache /var/cache/nginx/{epg,streaming} verificate"

# ─────────────────────────────────────────────────────────────
# STEP 8: PATCH nginx.conf — solo le righe ModSecurity
# ─────────────────────────────────────────────────────────────
log "STEP 8: Patch nginx.conf (load_module + direttive ModSec v3)..."

NGINX_CONF="/etc/nginx/nginx.conf"

# 8a. Aggiunge load_module modsecurity PRIMA della riga geoip2
#     (solo se non già presente)
if ! grep -q "ngx_http_modsecurity_module" "$NGINX_CONF"; then
    sed -i '/load_module.*ngx_http_geoip2_module/i load_module modules\/ngx_http_modsecurity_module.so;' \
        "$NGINX_CONF"
    log "  → Aggiunto load_module modsecurity"
else
    warn "  → load_module modsecurity già presente, skip"
fi

# 8b. ModSecurity v2 → v3: cambia le direttive (camelCase → snake_case)
#     ModSecurityEnabled on  →  modsecurity on
sed -i 's/ModSecurityEnabled\s\+on/modsecurity on/g' "$NGINX_CONF"
#     ModSecurityEnabled off →  modsecurity off
sed -i 's/ModSecurityEnabled\s\+off/modsecurity off/g' "$NGINX_CONF"
#     ModSecurityConfig <path>  →  modsecurity_rules_file <path>
sed -i 's/ModSecurityConfig /modsecurity_rules_file /g' "$NGINX_CONF"

log "  → Direttive ModSec v2 → v3 aggiornate"

# ─────────────────────────────────────────────────────────────
# STEP 9: MODSECURITY v3 CONFIG + OWASP CRS v4
# ─────────────────────────────────────────────────────────────
log "STEP 9: Configurazione ModSecurity v3 + OWASP CRS v4..."

mkdir -p /etc/nginx/modsec /etc/nginx/rules /opt/log

# modsecurity.conf base (da sorgente v3)
cp /usr/local/src/ModSecurity-v3/modsecurity.conf-recommended \
    /etc/nginx/modsec/modsecurity.conf
cp /usr/local/src/ModSecurity-v3/unicode.mapping \
    /etc/nginx/modsec/

# Enforcement mode on
sed -i 's/SecRuleEngine DetectionOnly/SecRuleEngine On/' \
    /etc/nginx/modsec/modsecurity.conf
# Audit log concurrent + path
sed -i 's/SecAuditLogType Serial/SecAuditLogType Concurrent/' \
    /etc/nginx/modsec/modsecurity.conf
sed -i 's|SecAuditLog /var/log/modsec_audit.log|SecAuditLog /opt/log/modsec_audit.log|' \
    /etc/nginx/modsec/modsecurity.conf

chmod -R 755 /opt/log
chown -R www-data:www-data /opt/log 2>/dev/null || \
    chown -R www-data /opt/log 2>/dev/null || true

# OWASP CRS v4 (nuovo repo)
log "  → Download OWASP CRS v4..."
rm -rf /etc/nginx/modsec/coreruleset
git clone --depth 1 \
    https://github.com/coreruleset/coreruleset.git \
    /etc/nginx/modsec/coreruleset
cd /etc/nginx/modsec/coreruleset
cp crs-setup.conf.example crs-setup.conf

# Pulisce regole CRS v3 residue, poi copia solo CRS v4
rm -f /etc/nginx/rules/*.conf /etc/nginx/rules/*.data
cp rules/*.conf /etc/nginx/rules/ 2>/dev/null || true
cp rules/*.data /etc/nginx/rules/ 2>/dev/null || true

log "  → OWASP CRS v4 installato"

# ─────────────────────────────────────────────────────────────
# STEP 10: AGGIORNA modsec_includes.conf
# ─────────────────────────────────────────────────────────────
log "STEP 10: Aggiornamento modsec_includes.conf..."

cat > /etc/nginx/modsec_includes.conf << 'EOF'
Include /etc/nginx/modsec/modsecurity.conf
Include /etc/nginx/modsec/coreruleset/crs-setup.conf
Include /etc/nginx/rules/*.conf
EOF

log "  → modsec_includes.conf aggiornato (path v3)"

# ─────────────────────────────────────────────────────────────
# STEP 11: TEST NGINX E RIAVVIO
# ─────────────────────────────────────────────────────────────
log "STEP 11: Test configurazione nginx..."

if nginx -t 2>&1; then
    log "nginx -t: OK"
    systemctl restart nginx
    sleep 2
    if systemctl is-active --quiet nginx; then
        log "nginx riavviato con successo."
    else
        err "nginx non si è avviato dopo il restart."
        rollback
    fi
else
    err "nginx -t fallito. Rollback in corso..."
    rollback
fi

# ─────────────────────────────────────────────────────────────
# STEP 12: REPORT FINALE
# ─────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════"
log "UPGRADE COMPLETATO CON SUCCESSO"
echo "════════════════════════════════════════════════"
echo ""
echo "  Nginx:       $(nginx -v 2>&1)"
echo "  ModSecurity: v3 (libmodsecurity $(find /usr/local/lib -name 'libmodsecurity.so*' 2>/dev/null | head -1 | xargs basename 2>/dev/null || echo 'installata'))"
echo "  OWASP CRS:   v4 ($(ls /etc/nginx/modsec/coreruleset/rules/*.conf 2>/dev/null | wc -l) regole)"
echo ""
echo "  Servizi:"
echo "    nginx:    $(systemctl is-active nginx)"
echo "    fail2ban: $(systemctl is-active fail2ban)"
echo "    mariadb:  $(systemctl is-active mariadb 2>/dev/null || echo 'n/a')"
echo ""
echo "  Backup in: $BACKUP_DIR"
echo ""
echo "  Log ModSec: /opt/log/modsec_audit.log"
echo ""
echo "  Per rollback manuale:"
echo "    cp $BACKUP_DIR/nginx.old /usr/share/nginx/sbin/nginx"
echo "    ln -sf /usr/share/nginx/sbin/nginx /usr/sbin/nginx"
echo "    cp -a $BACKUP_DIR/etc-nginx/. /etc/nginx/"
echo "    nginx -t && systemctl restart nginx"
echo ""
