import type { Express } from "express";
import { createServer, type Server } from "http";
import { totalmem, freemem, cpus } from "os";
import { execSync, execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);
import { randomBytes } from "crypto";
import { open as openMaxMind, type Reader, validate as validateIp } from "maxmind";
import { storage } from "./storage";
import { serviceActionSchema, unbanRequestSchema, updateConfigRequestSchema, updateJailRequestSchema, updateFilterRequestSchema, filterNameSchema, jailNameSchema } from "@shared/schema";
import { requireAuth, requireOperator, requireAdmin, validateCredentials, getAllUsers, getUserById, createUser, updateUser, deleteUser, getUserAllowedVps, requireVpsAccess, type UserRole } from "./auth";
import { getAllVps, getVpsById, createVps, updateVps, deleteVps, checkVpsHealth, checkAllVpsHealth, getHealthFromCache, getLastPollTime, startHealthPoller, syncIptvBanFleet, startBanSyncPoller, agentGet, agentPost, agentDelete, bulkGet, bulkPost, agentUpdate, bulkAgentUpdate, SLOW_REQUEST_TIMEOUT, SLOW_PATHS } from "./vps-manager";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import session from "express-session";
import createFileStore from "session-file-store";
import { startUpgradeJob, subscribeToJob, getJobSnapshot, getJobLogs, getActiveJob } from "./fleet-upgrade";
import { generateSshToken, attachSshWebSocket } from "./ssh-console";

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
const SESSION_SECRET_FILE = join(DATA_DIR, ".session-secret");
const SESSION_DIR = join(DATA_DIR, "sessions");
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const FileStore = createFileStore(session);
const GEOLITE2_ASN_DB_PATH = process.env.GEOLITE2_ASN_DB_PATH?.trim() || "/var/lib/GeoIP/GeoLite2-ASN.mmdb";
const GEOLITE2_COUNTRY_DB_PATH = process.env.GEOLITE2_COUNTRY_DB_PATH?.trim() || "/var/lib/GeoIP/GeoLite2-Country.mmdb";
const IP_API_TIMEOUT_MS = parseInt(process.env.IP_API_TIMEOUT_MS || "1500", 10);
const IP_API_BACKOFF_MS = parseInt(process.env.IP_API_BACKOFF_MS || "60000", 10);

type IpInfo = { asn: string; org: string; countryCode: string };
type IpInfoCacheEntry = { data: IpInfo; at: number };
type DeferredIpInfo = {
  promise: Promise<IpInfo>;
  resolve: (data: IpInfo) => void;
  reject: (error?: unknown) => void;
};

let asnReaderPromise: Promise<Reader<any> | null> | null = null;
let countryReaderPromise: Promise<Reader<any> | null> | null = null;
let ipApiBackoffUntil = 0;
const ipInfoCache = new Map<string, IpInfoCacheEntry>();
const ipInfoInFlight = new Map<string, Promise<IpInfo>>();
const IP_INFO_TTL = 48 * 60 * 60 * 1000;

// Percorsi proxy che un operator può modificare (POST)
const OPERATOR_WRITE_PATHS = [
  /^\/api\/services\/[^/]+\/action$/,
  /^\/api\/unban$/,
  /^\/api\/unban-all$/,
  /^\/api\/unban-jail$/,
];

const NETBIRD_SETUP_KEY = process.env.NETBIRD_SETUP_KEY?.trim() || "";
const DEPLOY_AGENT_GIT_REF = process.env.DEPLOY_AGENT_GIT_REF?.trim() || "main";
const DEPLOY_VPS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 .()_-]{0,79}$/;
const DEPLOY_HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const DEPLOY_NETBIRD_RESTART_NGINX_CONF = "[Service]\nExecStartPost=/bin/bash -c 'sleep 3 && systemctl restart nginx || true'\n";
const DEPLOY_NETBIRD_IPSET_CLEANUP_SH = [
  "#!/bin/bash",
  "declare -A CHAIN_TABLE=(",
  "    [NETBIRD-ACL-INPUT]=filter",
  "    [NETBIRD-RT-FWD-IN]=filter",
  "    [NETBIRD-RT-FWD-OUT]=filter",
  "    [NETBIRD-RT-NAT]=nat",
  "    [NETBIRD-RT-RDR]=nat",
  "    [NETBIRD-RT-PRE]=mangle",
  "    [NETBIRD-RT-MSSCLAMP]=mangle",
  ")",
  'for chain in "${!CHAIN_TABLE[@]}"; do',
  '    table="${CHAIN_TABLE[$chain]}"',
  '    iptables -t "$table" -S | grep "$chain" | grep "^-A" | while read -r rule; do',
  '        iptables -t "$table" ${rule/-A/-D} 2>/dev/null',
  '    done',
  '    iptables -t "$table" -F "$chain" 2>/dev/null',
  '    iptables -t "$table" -X "$chain" 2>/dev/null',
  'done',
  'for ipset in $(ipset list -n 2>/dev/null | grep -i netbird); do',
  '    ipset flush "$ipset" 2>/dev/null',
  '    ipset destroy "$ipset" 2>/dev/null',
  'done',
  "",
].join("\n");
const DEPLOY_NETBIRD_CLEANUP_SERVICE = [
  "[Unit]",
  "Description=Cleanup orphaned NetBird ipsets before start",
  "Before=netbird.service",
  "DefaultDependencies=no",
  "After=network-pre.target",
  "",
  "[Service]",
  "Type=oneshot",
  "ExecStart=/usr/local/bin/netbird-ipset-cleanup.sh",
  "RemainAfterExit=yes",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
  "",
].join("\n");
const DEPLOY_AGENT_SUDOERS = [
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl status *",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl start nginx",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl stop nginx",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl restart nginx",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl reload nginx",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl start fail2ban",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl stop fail2ban",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl restart fail2ban",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl start mariadb",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl stop mariadb",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl restart mariadb",
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/fail2ban-client *",
  "pgagent ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t",
  "pgagent ALL=(ALL) NOPASSWD: /usr/sbin/nginx",
  "pgagent ALL=(ALL) NOPASSWD: /usr/sbin/ipset *",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl start netbird",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl stop netbird",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl restart netbird",
  "pgagent ALL=(ALL) NOPASSWD: /usr/sbin/iptables *",
  "pgagent ALL=(ALL) NOPASSWD: /usr/sbin/iptables-save",
  "pgagent ALL=(ALL) NOPASSWD: /usr/sbin/netfilter-persistent save",
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/iptables/rules.v4",
  "pgagent ALL=(ALL) NOPASSWD: /usr/local/bin/update-lists.sh",
  "pgagent ALL=(ALL) NOPASSWD: /usr/local/bin/update-asn-block.sh",
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/netbird update",
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/apt install --only-upgrade netbird *",
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/apt-get install --only-upgrade netbird *",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl restart proxy-guardian-agent",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl stop proxy-guardian-agent",
  "pgagent ALL=(ALL) NOPASSWD: /bin/mkdir -p /etc/systemd/system/netbird.service.d",
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/systemd/system/netbird.service.d/restart-nginx.conf",
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/tee /usr/local/bin/netbird-ipset-cleanup.sh",
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/systemd/system/netbird-cleanup.service",
  "pgagent ALL=(ALL) NOPASSWD: /bin/chmod +x /usr/local/bin/netbird-ipset-cleanup.sh",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl daemon-reload",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl enable netbird-cleanup.service",
  "pgagent ALL=(ALL) NOPASSWD: /bin/systemctl disable netbird-cleanup.service",
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/sudoers.d/proxy-guardian-agent",
  "pgagent ALL=(ALL) NOPASSWD: /bin/mkdir -p /root/.ssh",
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/tee -a /root/.ssh/authorized_keys",
  "pgagent ALL=(ALL) NOPASSWD: /bin/chmod 700 /root/.ssh",
  "pgagent ALL=(ALL) NOPASSWD: /bin/chmod 600 /root/.ssh/authorized_keys",
  "pgagent ALL=(ALL) NOPASSWD: /bin/mkdir -p /var/cache/nginx/epg /var/cache/nginx/streaming",
  "pgagent ALL=(ALL) NOPASSWD: /bin/chown -R www-data /var/cache/nginx/epg",
  "pgagent ALL=(ALL) NOPASSWD: /bin/chown -R www-data /var/cache/nginx/streaming",
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/logrotate.d/proxyguardian",
  "pgagent ALL=(ALL) NOPASSWD: /usr/sbin/logrotate *",
  "pgagent ALL=(ALL) NOPASSWD: /bin/chmod 644 /etc/logrotate.d/proxyguardian",
  "",
].join("\n");
const DEPLOY_LOGROTATE_CONF = [
  "/var/log/nginx/access.log",
  "/var/log/nginx/error.log",
  "/opt/log/modsec_audit.log",
  "{",
  "    daily",
  "    rotate 3",
  "    missingok",
  "    notifempty",
  "    compress",
  "    delaycompress",
  "    sharedscripts",
  "    postrotate",
  "        [ -f /var/run/nginx.pid ] && kill -USR1 $(cat /var/run/nginx.pid) 2>/dev/null || true",
  "    endscript",
  "}",
  "",
  "/var/log/fail2ban.log {",
  "    daily",
  "    rotate 3",
  "    missingok",
  "    notifempty",
  "    compress",
  "    delaycompress",
  "    postrotate",
  "        fail2ban-client flushlogs 2>/dev/null || true",
  "    endscript",
  "}",
].join("\n");
const DEPLOY_IPSET_RESTORE_SERVICE = [
  "[Unit]",
  "Description=Restore ipset rules",
  "Before=network-pre.target iptables-restore.service netfilter-persistent.service",
  "Wants=network-pre.target",
  "",
  "[Service]",
  "Type=oneshot",
  "ExecStart=/bin/bash -c 'if [ -s /etc/ipset.conf ]; then /sbin/ipset restore -exist -file /etc/ipset.conf; else echo \"ipset-restore: /etc/ipset.conf non trovato o vuoto, skip.\"; fi'",
  "RemainAfterExit=yes",
  "SuccessExitStatus=0",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
  "",
].join("\n");
const DEPLOY_WHITELIST_WATCHER_SERVICE = [
  "[Unit]",
  "Description=Aggiorna ipset blocked_asn quando cambia la whitelist",
  "After=network.target ipset-restore.service",
  "",
  "[Service]",
  "Type=simple",
  "ExecStartPre=/usr/bin/apt-get install -y inotify-tools",
  "ExecStart=/usr/local/bin/whitelist-watcher.sh",
  "Restart=always",
  "RestartSec=5",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
  "",
].join("\n");
const DEPLOY_ANTI_IPTV_SERVICE = [
  "[Unit]",
  "Description=ProxyGuardian Anti-IPTV watcher",
  "After=network.target nginx.service",
  "Wants=nginx.service",
  "",
  "[Service]",
  "Type=simple",
  "ExecStart=/usr/local/sbin/anti-iptv.sh",
  "Restart=always",
  "RestartSec=5",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
  "",
].join("\n");

function isOperatorAllowedPost(path: string): boolean {
  return OPERATOR_WRITE_PATHS.some(r => r.test(path));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isValidDeployHost(value: string): boolean {
  return validateIp(value) || DEPLOY_HOST_RE.test(value);
}

function parseDeployPort(value: unknown, fallback: number): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? parseInt(value, 10)
      : fallback;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null;
}

function parseDeployToggle(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function getSessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET?.trim();
  if (fromEnv) return fromEnv;

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  if (existsSync(SESSION_SECRET_FILE)) {
    const existing = readFileSync(SESSION_SECRET_FILE, "utf-8").trim();
    if (existing) return existing;
  }

  const generated = randomBytes(32).toString("hex");
  writeFileSync(SESSION_SECRET_FILE, `${generated}\n`, { mode: 0o600 });
  console.warn(`[Session] SESSION_SECRET non impostato: secret persistente generato in ${SESSION_SECRET_FILE}`);
  return generated;
}

async function loadMaxMindReader(path: string): Promise<Reader<any> | null> {
  if (!existsSync(path)) return null;
  try {
    return await openMaxMind(path);
  } catch (error) {
    console.warn(`[GeoIP] Impossibile aprire database MaxMind ${path}:`, error);
    return null;
  }
}

async function getAsnReader(): Promise<Reader<any> | null> {
  asnReaderPromise ??= loadMaxMindReader(GEOLITE2_ASN_DB_PATH);
  return asnReaderPromise;
}

async function getCountryReader(): Promise<Reader<any> | null> {
  countryReaderPromise ??= loadMaxMindReader(GEOLITE2_COUNTRY_DB_PATH);
  return countryReaderPromise;
}

function normalizeIpInfo(data?: Partial<IpInfo> | null): IpInfo | null {
  if (!data) return null;
  const normalized: IpInfo = {
    asn: data.asn?.trim() || "",
    org: data.org?.trim() || "",
    countryCode: data.countryCode?.trim() || "",
  };
  return normalized.asn || normalized.org || normalized.countryCode ? normalized : null;
}

async function lookupMaxMindIpInfo(ip: string): Promise<IpInfo | null> {
  if (!validateIp(ip)) return null;

  const [asnReader, countryReader] = await Promise.all([getAsnReader(), getCountryReader()]);
  const asnData = asnReader?.get(ip) as any;
  const countryData = countryReader?.get(ip) as any;

  return normalizeIpInfo({
    asn: asnData?.autonomous_system_number ? `AS${asnData.autonomous_system_number}` : "",
    org: asnData?.autonomous_system_organization || "",
    countryCode: countryData?.country?.iso_code || countryData?.registered_country?.iso_code || "",
  });
}

function mergeIpInfo(primary?: IpInfo | null, fallback?: IpInfo | null): IpInfo | null {
  return normalizeIpInfo({
    asn: primary?.asn || fallback?.asn || "",
    org: primary?.org || fallback?.org || "",
    countryCode: primary?.countryCode || fallback?.countryCode || "",
  });
}

function shouldUseIpApi(): boolean {
  return Date.now() >= ipApiBackoffUntil;
}

function noteIpApiFailure(): void {
  ipApiBackoffUntil = Date.now() + IP_API_BACKOFF_MS;
}

function noteIpApiSuccess(): void {
  ipApiBackoffUntil = 0;
}

function getCachedIpInfo(ip: string): IpInfo | null {
  const cached = ipInfoCache.get(ip);
  if (!cached || Date.now() - cached.at >= IP_INFO_TTL) return null;
  return cached.data;
}

function setCachedIpInfo(ip: string, data: IpInfo): void {
  ipInfoCache.set(ip, { data, at: Date.now() });
}

function createDeferredIpInfo(ip: string): DeferredIpInfo {
  let resolve!: (data: IpInfo) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<IpInfo>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const trackedPromise = promise.finally(() => {
    if (ipInfoInFlight.get(ip) === trackedPromise) {
      ipInfoInFlight.delete(ip);
    }
  });
  ipInfoInFlight.set(ip, trackedPromise);
  return { promise: trackedPromise, resolve, reject };
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = IP_API_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function lookupIpApiInfo(ip: string): Promise<IpInfo | null> {
  if (!shouldUseIpApi()) return null;
  const r = await fetchWithTimeout(`http://ip-api.com/json/${ip}?fields=status,as,org,isp,countryCode`);
  const item = await r.json() as any;
  if (item?.status && item.status !== "success") return null;
  return normalizeIpInfo({
    asn: item?.as || "",
    org: item?.org || item?.isp || "",
    countryCode: item?.countryCode || "",
  });
}

async function lookupIpInfo(ip: string): Promise<IpInfo> {
  const maxMindInfoPromise = lookupMaxMindIpInfo(ip);
  let ipApiInfo: IpInfo | null = null;
  try {
    ipApiInfo = await lookupIpApiInfo(ip);
    if (ipApiInfo) noteIpApiSuccess();
  } catch {
    noteIpApiFailure();
    ipApiInfo = null;
  }

  if (ipApiInfo?.asn && ipApiInfo.org && ipApiInfo.countryCode) {
    return ipApiInfo;
  }

  const maxMindInfo = await maxMindInfoPromise;
  return mergeIpInfo(ipApiInfo, maxMindInfo) || { asn: "", org: "", countryCode: "" };
}

async function getOrLoadIpInfo(ip: string): Promise<IpInfo> {
  const cached = getCachedIpInfo(ip);
  if (cached) return cached;

  const existing = ipInfoInFlight.get(ip);
  if (existing) return existing;

  const deferred = createDeferredIpInfo(ip);
  try {
    const data = await lookupIpInfo(ip);
    setCachedIpInfo(ip, data);
    deferred.resolve(data);
    return data;
  } catch (error) {
    deferred.reject(error);
    throw error;
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });

  const sessionStore = new FileStore({
    path: SESSION_DIR,
    ttl: Math.floor(SESSION_TTL_MS / 1000),
    reapInterval: Math.floor(SESSION_TTL_MS / 1000),
    retries: 0,
    logFn: () => {},
  });

  app.use(session({
    secret: getSessionSecret(),
    store: sessionStore,
    resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: SESSION_TTL_MS },
  }));

  // Auth
  app.post("/api/auth/login", (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Parametri mancanti" });
    const user = validateCredentials(username, password);
    if (!user) return res.status(401).json({ error: "Credenziali non valide" });
    req.session.userId = user.id; req.session.userRole = user.role;
    res.json({ user });
  });
  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => { res.clearCookie("connect.sid"); res.json({ success: true }); });
  });
  app.get("/api/auth/me", requireAuth, (req, res) => {
    const user = getUserById(req.session.userId!);
    if (!user) return res.status(401).json({ error: "Non trovato" });
    res.json({ user });
  });

  // Users
  app.get("/api/users", requireAuth, requireAdmin, (_req, res) => res.json(getAllUsers()));
  app.post("/api/users", requireAuth, requireAdmin, (req, res) => {
    try {
      const { username, password, role, assignedVps } = req.body;
      res.status(201).json(createUser(username, password, role as UserRole, assignedVps));
    }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  app.put("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
    try { res.json(updateUser(req.params.id, req.body)); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  app.delete("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
    try { deleteUser(req.params.id); res.json({ success: true }); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // VPS CRUD
  app.get("/api/vps", requireAuth, (req, res) => {
    const all = getAllVps();
    const allowed = getUserAllowedVps(req.session.userId!);
    if (allowed === undefined) return res.json(all); // admin: tutti
    res.json(all.filter(v => allowed.includes(v.id)));
  });
  app.post("/api/vps", requireAuth, requireAdmin, (req, res) => {
    try {
      const { name, host, port, apiKey, tags } = req.body;
      if (!name || !host || !apiKey) return res.status(400).json({ error: "name, host, apiKey richiesti" });
      res.status(201).json(createVps({ name, host, port, apiKey, tags }));
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  app.put("/api/vps/:id", requireAuth, requireAdmin, (req, res) => {
    try { res.json(updateVps(req.params.id, req.body)); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  app.delete("/api/vps/:id", requireAuth, requireAdmin, (req, res) => {
    try { deleteVps(req.params.id); res.json({ success: true }); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  app.get("/api/vps/health/all", requireAuth, async (req, res) => {
    const healthMap = Object.fromEntries(getHealthFromCache());
    const allowed = getUserAllowedVps(req.session.userId!);
    if (allowed === undefined) return res.json(healthMap);
    const filtered = Object.fromEntries(Object.entries(healthMap).filter(([id]) => allowed.includes(id)));
    res.json(filtered);
  });
  app.get("/api/vps/:id/health", requireAuth, async (req, res) => {
    const vps = getVpsById(req.params.id);
    if (!vps) return res.status(404).json({ error: "VPS non trovato" });
    if (!requireVpsAccess(req.params.id, req.session.userId!)) return res.status(403).json({ error: "Accesso negato" });
    const online = await checkVpsHealth(vps);
    res.json({ online, lastSeen: vps.lastSeen });
  });

  // Agent versions
  app.get("/api/vps/agents/versions", requireAuth, async (req, res) => {
    const all = getAllVps();
    const allowed = getUserAllowedVps(req.session.userId!);
    const targets = allowed === undefined ? all : all.filter(v => allowed.includes(v.id));
    const results = await Promise.allSettled(targets.map(async vps => {
      const cfg = getVpsById(vps.id);
      if (!cfg) return { vpsId: vps.id, vpsName: vps.name, version: null, online: false };
      try {
        const data = await agentGet(cfg, "/health");
        return { vpsId: vps.id, vpsName: vps.name, version: data.version || null, online: true };
      } catch {
        return { vpsId: vps.id, vpsName: vps.name, version: null, online: false };
      }
    }));
    res.json(results.map(r => r.status === "fulfilled" ? r.value : { vpsId: "?", vpsName: "?", version: null, online: false }));
  });

  // Agent update bulk (deve stare prima di /:id per evitare che "bulk" venga catturato come id)
  app.post("/api/vps/bulk/agent/update", requireAuth, requireAdmin, async (_req, res) => {
    try { res.json(await bulkAgentUpdate("all")); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Agent update singolo VPS
  app.post("/api/vps/:id/agent/update", requireAuth, requireAdmin, async (req, res) => {
    const vps = getVpsById(req.params.id);
    if (!vps) return res.status(404).json({ error: "VPS non trovato" });
    try {
      const bundle = Buffer.from(readFileSync(join(process.cwd(), "agent", "agent-bundle.js")));
      res.json(await agentUpdate(vps, bundle));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Proxy singolo VPS
  app.get("/api/vps/:id/proxy/*", requireAuth, async (req, res) => {
    if (!requireVpsAccess(req.params.id, req.session.userId!)) return res.status(403).json({ error: "Accesso negato" });
    const vps = getVpsById(req.params.id);
    if (!vps) return res.status(404).json({ error: "VPS non trovato" });
    if (vps.lastStatus === "offline") return res.status(502).json({ error: "VPS offline" });
    const proxyPath = "/" + (req.params as any)[0];
    const rawQuery = req.url.includes("?") ? req.url.substring(req.url.indexOf("?")) : "";
    const timeout = SLOW_PATHS.includes(proxyPath) ? SLOW_REQUEST_TIMEOUT : undefined;
    try { res.json(await agentGet(vps, proxyPath + rawQuery, timeout)); }
    catch (e: any) { res.status(502).json({ error: e.message }); }
  });
  app.post("/api/vps/:id/proxy/*", requireAuth, requireOperator, async (req, res) => {
    if (!requireVpsAccess(req.params.id, req.session.userId!)) return res.status(403).json({ error: "Accesso negato" });
    const proxyPath = "/" + (req.params as any)[0];
    if (req.session.userRole === "operator" && !isOperatorAllowedPost(proxyPath)) {
      return res.status(403).json({ error: "Permessi insufficienti: solo admin può modificare le configurazioni" });
    }
    const vps = getVpsById(req.params.id);
    if (!vps) return res.status(404).json({ error: "VPS non trovato" });
    if (vps.lastStatus === "offline") return res.status(502).json({ error: "VPS offline" });
    const timeout = SLOW_PATHS.includes(proxyPath) ? SLOW_REQUEST_TIMEOUT : undefined;
    try { res.json(await agentPost(vps, proxyPath, req.body, timeout)); }
    catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  // Bulk
  app.post("/api/vps/bulk/get", requireAuth, async (req, res) => {
    const { vpsIds, path } = req.body;
    if (!vpsIds || !path) return res.status(400).json({ error: "vpsIds e path richiesti" });
    // Filtra VPS accessibili per operator
    const allowed = getUserAllowedVps(req.session.userId!);
    const allVps = getAllVps().map(v => v.id);
    const ids: string[] = vpsIds === "all"
      ? (allowed === undefined ? allVps : allVps.filter(id => allowed.includes(id)))
      : (Array.isArray(vpsIds) ? vpsIds.filter(id => allowed === undefined || allowed.includes(id)) : []);
    res.json(await bulkGet(ids, path));
  });
  app.post("/api/vps/bulk/post", requireAuth, requireOperator, async (req, res) => {
    const { vpsIds, path, body } = req.body;
    if (!vpsIds || !path) return res.status(400).json({ error: "vpsIds e path richiesti" });
    if (req.session.userRole === "operator" && !isOperatorAllowedPost(path)) {
      return res.status(403).json({ error: "Permessi insufficienti: solo admin può modificare le configurazioni" });
    }
    const allowed = getUserAllowedVps(req.session.userId!);
    const allVps = getAllVps().map(v => v.id);
    const ids: string[] = vpsIds === "all"
      ? (allowed === undefined ? allVps : allVps.filter(id => allowed.includes(id)))
      : (Array.isArray(vpsIds) ? vpsIds.filter(id => allowed === undefined || allowed.includes(id)) : []);
    res.json(await bulkPost(ids, path, body || {}));
  });

  // ─── Fleet ASN config (repo-backed) ─────────────────────────────────────────

  const FLEET_DIR = join(process.cwd(), "asn-block");
  const ASN_BLOCKLIST_EXCLUDED_VPS_NAMES = new Set(["dynamoxc"]);

  function getAsnBlocklistTargetVpsIds(): string[] {
    return getAllVps()
      .filter(vps => vps.enabled && !ASN_BLOCKLIST_EXCLUDED_VPS_NAMES.has(vps.name.trim().toLowerCase()))
      .map(vps => vps.id);
  }
  function readFleetFile(name: string): string {
    const p = join(FLEET_DIR, name);
    try { return existsSync(p) ? readFileSync(p, "utf-8") : ""; } catch { return ""; }
  }

  function writeFleetFile(name: string, content: string): void {
    if (!existsSync(FLEET_DIR)) mkdirSync(FLEET_DIR, { recursive: true });
    writeFileSync(join(FLEET_DIR, name), content, "utf-8");
    // Git commit locale (best-effort, nessun push)
    try {
      execSync(
        `git -C "${process.cwd()}" add asn-block/ && ` +
        `(git -C "${process.cwd()}" diff --staged --quiet || ` +
        `git -C "${process.cwd()}" -c user.name="Dashboard" -c user.email="dashboard@local" commit -m "chore: update fleet ${name}")`,
        { stdio: "pipe" }
      );
    } catch {}
  }

  // Block list (asn-blocklist.txt — AsnBlock format: "AS12345 # Description")
  app.get("/api/fleet/asn/blocklist", requireAuth, (_req, res) => {
    res.json({ content: readFleetFile("asn-blocklist.txt") });
  });

  app.post("/api/fleet/asn/blocklist", requireAuth, requireAdmin, async (req, res) => {
    const { content } = req.body;
    if (typeof content !== "string") return res.status(400).json({ error: "content required" });
    writeFleetFile("asn-blocklist.txt", content);
    // Push file to all eligible VPS, then trigger update-asn-block.sh.
    // dynamoxc keeps a dedicated ASN blocklist and must not receive fleet updates.
    const targetVpsIds = getAsnBlocklistTargetVpsIds();
    const syncResults = await bulkPost(targetVpsIds, "/api/config/asn-blocklist.txt", { content });
    const applyResults = await bulkPost(targetVpsIds, "/api/asn/update-set", {});
    res.json({ ok: true, syncResults, applyResults });
  });

  // Whitelist (asn-whitelist.txt — inotify watcher triggers update automatically)
  app.get("/api/fleet/asn/whitelist", requireAuth, async (_req, res) => {
    // Se il file locale ha contenuto reale, usalo
    const local = readFleetFile("asn-whitelist.txt");
    const hasContent = local.split("\n").some(l => { const t = l.trim(); return t && !t.startsWith("#"); });
    if (hasContent) return res.json({ content: local });
    // Altrimenti leggi dal primo VPS agent disponibile
    const allVps = getAllVps();
    for (const safe of allVps.filter(v => v.enabled)) {
      const vps = getVpsById(safe.id);
      if (!vps) continue;
      try {
        const data = await agentGet(vps, "/api/asn/whitelist");
        const entries: Array<{ value: string; comment: string }> = data.entries || [];
        const content = entries.map(e => e.comment ? `${e.value} # ${e.comment}` : e.value).join("\n") + (entries.length ? "\n" : "");
        return res.json({ content });
      } catch (e: any) {
        console.error(`[fleet/asn/whitelist] ${vps.name}: ${e.message}`);
      }
    }
    res.json({ content: local });
  });

  app.post("/api/fleet/asn/whitelist", requireAuth, requireAdmin, async (req, res) => {
    const { content } = req.body;
    if (typeof content !== "string") return res.status(400).json({ error: "content required" });
    writeFleetFile("asn-whitelist.txt", content);
    // Writing triggers inotify watcher → update-asn-block.sh automatically
    const syncResults = await bulkPost("all", "/api/config/asn-whitelist.txt", { content });
    res.json({ ok: true, syncResults });
  });

  // Leggi blocklist da un VPS specifico (per importare nel fleet)
  app.get("/api/fleet/asn/blocklist/import/:vpsId", requireAuth, requireAdmin, async (req, res) => {
    const vps = getVpsById(req.params.vpsId);
    if (!vps) return res.status(404).json({ error: "VPS non trovato" });
    try {
      const data = await agentGet(vps, "/api/config/asn-blocklist.txt");
      res.json({ content: data.content || "" });
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  // Sync da AsnBlock GitHub repo su tutti i VPS
  app.post("/api/fleet/asn/sync-github", requireAuth, requireAdmin, async (_req, res) => {
    const results = await bulkPost(getAsnBlocklistTargetVpsIds(), "/api/asn/update-lists", {});
    res.json({ ok: true, results });
  });

  // ─── Backup / Restore ─────────────────────────────────────────────────────

  const DATA_DIR_PATH = join(process.cwd(), "data");

  app.get("/api/admin/backup", requireAuth, requireAdmin, (_req, res) => {
    try {
      const readData = (file: string) => {
        const p = join(DATA_DIR_PATH, file);
        try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : []; } catch { return []; }
      };
      const backup = {
        version: 1,
        timestamp: new Date().toISOString(),
        vps: readData("vps.json"),
        users: readData("users.json"),
        asnBlocklist: readFleetFile("asn-blocklist.txt"),
        asnWhitelist: readFleetFile("asn-whitelist.txt"),
      };
      const filename = `pg-backup-${new Date().toISOString().slice(0, 10)}.json`;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.json(backup);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/admin/restore", requireAuth, requireAdmin, (req, res) => {
    try {
      const { version, vps, users, asnBlocklist, asnWhitelist } = req.body;
      if (version !== 1 || !Array.isArray(vps) || !Array.isArray(users)) {
        return res.status(400).json({ error: "File backup non valido o versione non supportata" });
      }
      if (!existsSync(DATA_DIR_PATH)) mkdirSync(DATA_DIR_PATH, { recursive: true });
      writeFileSync(join(DATA_DIR_PATH, "vps.json"), JSON.stringify(vps, null, 2), "utf-8");
      writeFileSync(join(DATA_DIR_PATH, "users.json"), JSON.stringify(users, null, 2), "utf-8");
      if (typeof asnBlocklist === "string") writeFleetFile("asn-blocklist.txt", asnBlocklist);
      if (typeof asnWhitelist === "string") writeFleetFile("asn-whitelist.txt", asnWhitelist);
      res.json({ ok: true, message: "Dati ripristinati. Il server si riavvierà tra 2 secondi." });
      // Riavvio per ricaricare vpsStore e usersStore in memoria
      setTimeout(() => process.exit(1), 2000);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Locali
  app.get("/api/services", requireAuth, async (_req, res) => { try { res.json(await storage.getServices()); } catch { res.status(500).json({ error: "Errore" }); } });
  app.post("/api/services/action", requireAuth, requireOperator, async (req, res) => {
    try {
      const r = serviceActionSchema.safeParse(req.body);
      if (!r.success) return res.status(400).json({ error: "Parametri non validi" });
      await storage.serviceAction(r.data.service, r.data.action);
      await new Promise(resolve => setTimeout(resolve, 1000));
      res.json(await storage.getServiceStatus(r.data.service));
    } catch { res.status(500).json({ error: "Errore" }); }
  });
  app.get("/api/banned-ips", requireAuth, async (_req, res) => { try { res.json(await storage.getBannedIps()); } catch { res.status(500).json({ error: "Errore" }); } });
  app.post("/api/unban", requireAuth, requireOperator, async (req, res) => {
    try {
      const r = unbanRequestSchema.safeParse(req.body);
      if (!r.success) return res.status(400).json({ error: "Parametri non validi" });
      await storage.unbanIp(r.data.ip, r.data.jail);
      res.json({ success: true, message: `IP ${r.data.ip} sbloccato` });
    } catch { res.status(500).json({ error: "Errore" }); }
  });
  app.post("/api/unban-all", requireAuth, requireOperator, async (_req, res) => { try { res.json(await storage.unbanAll()); } catch { res.status(500).json({ error: "Errore" }); } });
  app.get("/api/stats", requireAuth, async (_req, res) => { try { res.json(await storage.getStats()); } catch { res.status(500).json({ error: "Errore" }); } });

  // Singolo IP
  app.get("/api/ip-info/:ip", requireAuth, async (req, res) => {
    const ip = req.params.ip;
    if (!validateIp(ip)) return res.status(400).json({ error: "IP non valido" });
    const data = await getOrLoadIpInfo(ip);
    res.json(data);
  });

  // Batch IP (max 100, cache 48h)
  app.post("/api/ip-info/batch", requireAuth, async (req, res) => {
    const ips: string[] = Array.isArray(req.body?.ips)
      ? req.body.ips.filter((ip: unknown): ip is string => typeof ip === "string" && validateIp(ip)).slice(0, 100)
      : [];
    const result: Record<string, { asn: string; org: string; countryCode: string }> = {};
    const owned = new Map<string, DeferredIpInfo>();
    const shared = new Map<string, Promise<IpInfo>>();

    for (const ip of ips) {
      const cached = getCachedIpInfo(ip);
      if (cached) {
        result[ip] = cached;
        continue;
      }

      const existing = ipInfoInFlight.get(ip);
      if (existing) {
        shared.set(ip, existing);
        continue;
      }

      owned.set(ip, createDeferredIpInfo(ip));
    }

    const ownedIps = [...owned.keys()];
    if (ownedIps.length > 0) {
      try {
        const maxMindByIp = new Map<string, IpInfo | null>(
          await Promise.all(ownedIps.map(async ip => [ip, await lookupMaxMindIpInfo(ip)] as const))
        );
        const unresolved = new Set(ownedIps);

        if (shouldUseIpApi()) {
          try {
            const r = await fetchWithTimeout("http://ip-api.com/batch?fields=status,query,as,org,isp,countryCode", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(ownedIps.map(q => ({ query: q }))),
            });
            const items = await r.json() as any[];
            noteIpApiSuccess();
            for (const item of items) {
              const ip = item?.query;
              if (!ip || !owned.has(ip)) continue;
              unresolved.delete(ip);
              const data = mergeIpInfo(
                normalizeIpInfo({
                  asn: item?.status === "success" ? item.as || "" : "",
                  org: item?.status === "success" ? item.org || item.isp || "" : "",
                  countryCode: item?.status === "success" ? item.countryCode || "" : "",
                }),
                maxMindByIp.get(ip) || null,
              ) || { asn: "", org: "", countryCode: "" };
              setCachedIpInfo(ip, data);
              owned.get(ip)?.resolve(data);
              result[ip] = data;
            }
          } catch {
            noteIpApiFailure();
          }
        }

        for (const ip of unresolved) {
          const data = maxMindByIp.get(ip) || { asn: "", org: "", countryCode: "" };
          setCachedIpInfo(ip, data);
          owned.get(ip)?.resolve(data);
          result[ip] = data;
        }
      } catch (error) {
        for (const ip of ownedIps) {
          owned.get(ip)?.reject(error);
        }
        throw error;
      }
    }

    if (shared.size > 0) {
      const sharedResults = await Promise.all(
        [...shared.entries()].map(async ([ip, promise]) => [ip, await promise] as const)
      );
      for (const [ip, data] of sharedResults) {
        result[ip] = data;
      }
    }

    res.json(result);
  });
  app.get("/api/logs/:logType", requireAuth, async (req, res) => {
    try {
      const allowedLogTypes = ["nginx-access", "nginx-error", "fail2ban", "modsec", "syslog"];
      if (!allowedLogTypes.includes(req.params.logType)) {
        return res.status(400).json({ error: "Tipo di log non valido" });
      }
      const lines = Math.min(Math.max(parseInt(req.query.lines as string) || 100, 1), 10000);
      res.json(await storage.getLogs(req.params.logType, lines));
    }
    catch { res.status(500).json({ error: "Errore" }); }
  });
  app.get("/api/config/:filename", requireAuth, async (req, res) => {
    try { const c = await storage.getConfigFile(req.params.filename); if (!c) return res.status(404).json({ error: "Non trovato" }); res.json(c); }
    catch { res.status(500).json({ error: "Errore" }); }
  });
  app.post("/api/config/update", requireAuth, requireAdmin, async (req, res) => {
    try {
      const r = updateConfigRequestSchema.safeParse(req.body);
      if (!r.success) return res.status(400).json({ error: "Parametri non validi" });
      await storage.updateConfigFile(r.data.filename, r.data.content);
      res.json({ success: true, message: "Configurazione aggiornata" });
    } catch { res.status(500).json({ error: "Errore" }); }
  });
  app.get("/api/fail2ban/jails", requireAuth, async (_req, res) => { try { res.json(await storage.getJails()); } catch { res.status(500).json({ error: "Errore" }); } });
  app.post("/api/fail2ban/jails/:name", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!jailNameSchema.safeParse(req.params.name).success) {
        return res.status(400).json({ error: "Nome jail non valido" });
      }
      const r = updateJailRequestSchema.safeParse(req.body);
      if (!r.success) return res.status(400).json({ error: "Parametri non validi" });
      await storage.updateJail(req.params.name, r.data.config);
      res.json({ success: true });
    } catch { res.status(500).json({ error: "Errore" }); }
  });
  app.get("/api/fail2ban/filters", requireAuth, async (_req, res) => { try { res.json(await storage.getFilters()); } catch { res.status(500).json({ error: "Errore" }); } });
  app.get("/api/fail2ban/filters/:name", requireAuth, async (req, res) => {
    try {
      if (!filterNameSchema.safeParse(req.params.name).success) {
        return res.status(400).json({ error: "Nome filtro non valido" });
      }
      const f = await storage.getFilter(req.params.name); if (!f) return res.status(404).json({ error: "Non trovato" }); res.json(f);
    }
    catch { res.status(500).json({ error: "Errore" }); }
  });
  app.post("/api/fail2ban/filters/:name", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!filterNameSchema.safeParse(req.params.name).success) {
        return res.status(400).json({ error: "Nome filtro non valido" });
      }
      const r = updateFilterRequestSchema.safeParse(req.body);
      if (!r.success) return res.status(400).json({ error: "Parametri non validi" });
      await storage.updateFilter(req.params.name, r.data.failregex, r.data.ignoreregex);
      res.json({ success: true });
    } catch { res.status(500).json({ error: "Errore" }); }
  });
  app.get("/api/fail2ban/config/:type", requireAuth, async (req, res) => {
    try {
      const { type } = req.params;
      if (type !== "jail.local" && type !== "fail2ban.local") return res.status(400).json({ error: "Tipo non valido" });
      res.json(await storage.getFail2banConfig(type));
    } catch { res.status(500).json({ error: "Errore" }); }
  });
  app.post("/api/fail2ban/config/:type", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { type } = req.params;
      if (type !== "jail.local" && type !== "fail2ban.local") return res.status(400).json({ error: "Tipo non valido" });
      await storage.updateFail2banConfig(type, req.body.content);
      res.json({ success: true });
    } catch { res.status(500).json({ error: "Errore" }); }
  });

  // Dashboard host health
  app.get("/api/dashboard/system", requireAuth, (_req, res) => {
    try {
      const memTotal = totalmem();
      const memFree = freemem();
      const memUsedPct = Math.round(((memTotal - memFree) / memTotal) * 100);
      let disk = { used: "—", total: "—", percent: "—" };
      let load = { "1m": 0, "5m": 0, "15m": 0 };
      try {
        const df = execSync("df -h / 2>/dev/null", { timeout: 3000 }).toString().trim().split("\n");
        if (df.length >= 2) { const p = df[1].trim().split(/\s+/); disk = { used: p[2], total: p[1], percent: p[4] }; }
      } catch {}
      try {
        const la = execSync("cat /proc/loadavg 2>/dev/null", { timeout: 1000 }).toString().trim().split(" ");
        load = { "1m": parseFloat(la[0]) || 0, "5m": parseFloat(la[1]) || 0, "15m": parseFloat(la[2]) || 0 };
      } catch {}
      res.json({ memory: { totalMb: Math.round(memTotal / 1024 / 1024), usedPct: memUsedPct }, disk, load, cpuCount: cpus().length });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ─── Fleet Banned IPs streaming ───────────────────────────────────────────────

  // Invia i risultati man mano che ogni VPS risponde (SSE) — timeout 5s per VPS
  app.post("/api/fleet/iptv-ban/sync", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const result = await syncIptvBanFleet();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── IP Investigator ──────────────────────────────────────────────────────────

  app.post("/api/fleet/ip-investigate", requireAuth, async (req, res) => {
    const { ip } = req.body;
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return res.status(400).json({ error: "IP non valido" });

    const vpsList = getAllVps().filter(v => v.enabled).map(s => getVpsById(s.id)).filter((v): v is any => !!v);

    const results = await Promise.allSettled(vpsList.map(async (vps) => {
      try {
        const [grepData, ipsetData] = await Promise.allSettled([
          agentGet(vps, `/api/grep?q=${encodeURIComponent(ip)}&type=nginx_access`, 15000),
          agentGet(vps, "/api/ipset/iptv_ban?limit=50000", 10000),
        ]);

        const rawLines: string[] = grepData.status === "fulfilled"
          ? (grepData.value.entries || []).map((e: any) => e.message || e).filter(Boolean)
          : [];
        const lines: string[] = rawLines.filter((l: string) => l.includes(ip));

        const banned = ipsetData.status === "fulfilled"
          ? (ipsetData.value.members || []).some((m: string) => m.startsWith(ip + " ") || m === ip)
          : false;

        if (lines.length === 0 && !banned) return null;

        const usernameRe = /[?&]username=([^&\s"*]+)/;
        const pathRe = /"(?:GET|POST) ([^\s"]+)/;
        const statusRe = /"\s+(\d{3})\s+/;
        const usernames = [...new Set(lines.map(l => { const m = usernameRe.exec(l); return m?.[1] || null; }).filter(Boolean))] as string[];
        const paths = [...new Set(lines.map(l => { const m = pathRe.exec(l); return m?.[1]?.split("?")[0] || null; }).filter(Boolean))] as string[];
        const statuses = lines.map(l => { const m = statusRe.exec(l); return m?.[1] || null; }).filter(Boolean) as string[];
        const ua = lines.map(l => { const m = /"([^"]+)"\s+"[^"]*"\s+"[^"]*"\s+"/.exec(l); return m?.[1] || null; }).find(Boolean) || null;

        const usernameStats: Record<string, Record<string, number>> = {};
        for (const line of lines) {
          const uMatch = usernameRe.exec(line);
          const sMatch = statusRe.exec(line);
          if (uMatch) {
            const u = uMatch[1];
            const s = sMatch?.[1] || "?";
            if (!usernameStats[u]) usernameStats[u] = {};
            usernameStats[u][s] = (usernameStats[u][s] || 0) + 1;
          }
        }

        return { vpsId: vps.id, vpsName: vps.name, count: lines.length, usernames, paths, statuses, ua, banned, sample: lines, usernameStats };
      } catch { return null; }
    }));

    const hits = results.map(r => r.status === "fulfilled" ? r.value : null).filter(Boolean) as any[];
    const allUsernames = [...new Set(hits.flatMap(h => h.usernames))];
    const totalRequests = hits.reduce((s, h) => s + h.count, 0);

    const allUsernameStats: Record<string, Record<string, number>> = {};
    for (const hit of hits) {
      for (const [u, stats] of Object.entries(hit.usernameStats || {})) {
        if (!allUsernameStats[u]) allUsernameStats[u] = {};
        for (const [s, n] of Object.entries(stats as Record<string, number>)) {
          allUsernameStats[u][s] = (allUsernameStats[u][s] || 0) + n;
        }
      }
    }

    // Geo info via existing ip-info endpoint
    let geoInfo: any = null;
    try {
      const geoRes = await fetch(`http://localhost:${process.env.PORT || 5000}/api/ip-info/${ip}`, {
        headers: { cookie: req.headers.cookie || "" }
      });
      if (geoRes.ok) geoInfo = await geoRes.json();
    } catch {}

    res.json({ ip, totalVps: hits.length, totalRequests, allUsernames, allUsernameStats, geoInfo, vpsResults: hits });
  });

  app.post("/api/fleet/ip-ban", requireAuth, requireAdmin, async (req, res) => {
    const { ip } = req.body;
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return res.status(400).json({ error: "IP non valido" });
    const vpsList = getAllVps().filter(v => v.enabled).map(s => getVpsById(s.id)).filter((v): v is any => !!v);
    const results = await Promise.allSettled(vpsList.map(async (vps) => {
      try { await agentPost(vps, "/api/ipset/iptv_ban/add", { ip }); return { vpsId: vps.id, vpsName: vps.name, ok: true }; }
      catch (e: any) { return { vpsId: vps.id, vpsName: vps.name, ok: false, error: e.message }; }
    }));
    const data = results.map(r => r.status === "fulfilled" ? r.value : { ok: false, error: "rejected" });
    res.json({ ok: data.filter(d => d.ok).length, fail: data.filter(d => !d.ok).length, results: data });
  });

  app.post("/api/fleet/ip-unban", requireAuth, requireAdmin, async (req, res) => {
    const { ip } = req.body;
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return res.status(400).json({ error: "IP non valido" });
    const vpsList = getAllVps().filter(v => v.enabled).map(s => getVpsById(s.id)).filter((v): v is any => !!v);
    const results = await Promise.allSettled(vpsList.map(async (vps) => {
      try {
        await agentPost(vps, "/api/unban", { ip, jail: "anti-iptv" });
        return { vpsId: vps.id, vpsName: vps.name, ok: true };
      } catch (e: any) { return { vpsId: vps.id, vpsName: vps.name, ok: false, error: e.message }; }
    }));
    const data = results.map(r => r.status === "fulfilled" ? r.value : { ok: false, error: "rejected" });
    res.json({ ok: data.filter(d => d.ok).length, fail: data.filter(d => !d.ok).length });
  });

  app.get("/api/fleet/banned-ips/stream", requireAuth, async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const allowed = getUserAllowedVps(req.session.userId!);
    const targets = getAllVps().filter(v => v.enabled && (allowed === undefined || allowed.includes(v.id)));
    const total = targets.length;

    const safeWrite = (chunk: string) => { if (!res.writableEnded) res.write(chunk); };

    safeWrite(`event: total\ndata: ${JSON.stringify({ total })}\n\n`);

    if (total === 0) {
      safeWrite(`event: done\ndata: {}\n\n`);
      res.end();
      return;
    }

    let completed = 0;
    await Promise.allSettled(targets.map(async (safe) => {
      const vps = getVpsById(safe.id);
      if (!vps) { completed++; return; }
      try {
        const data = await agentGet(vps, "/api/banned-ips", 5000);
        safeWrite(`event: result\ndata: ${JSON.stringify({ vpsId: vps.id, vpsName: vps.name, success: true, data })}\n\n`);
      } catch (e: any) {
        safeWrite(`event: result\ndata: ${JSON.stringify({ vpsId: vps.id, vpsName: vps.name, success: false, error: e.message })}\n\n`);
      }
      completed++;
      if (completed === total) {
        safeWrite(`event: done\ndata: {}\n\n`);
        if (!res.writableEnded) res.end();
      }
    }));
  });

  // ─── Main Backend Ban Management ─────────────────────────────────────────────

  const MAIN_HOST = process.env.MAIN_HOST || "";
  const MAIN_SSH_PASS = process.env.MAIN_SSH_PASS || "";
  const MAIN_JAILS = ["player-api-stuffing", "player-api", "panel-api", "nginx-abuse", "404-0", "block22", "sshd"];

  async function mainSsh(cmd: string, timeoutMs = 10000): Promise<string> {
    if (!MAIN_HOST || !MAIN_SSH_PASS) throw new Error("MAIN_HOST/MAIN_SSH_PASS non configurati in .env");
    const { stdout } = await execFileAsync(
      "sshpass",
      ["-e", "ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=6", `root@${MAIN_HOST}`, cmd],
      { env: { ...process.env, SSHPASS: MAIN_SSH_PASS }, timeout: timeoutMs }
    );
    return stdout.trim();
  }

  app.get("/api/main/bans", requireAuth, async (_req, res) => {
    try {
      const parseIps = (raw: string) =>
        raw.split("\n").map((s: string) => s.trim()).filter((s: string) => /^\d+\.\d+\.\d+\.\d+$/.test(s));

      const [f2bResults, manualRaw, f2bChainRaw, iptvRaw] = await Promise.allSettled([
        Promise.allSettled(MAIN_JAILS.map(async jail => {
          const raw = await mainSsh(`fail2ban-client get ${jail} banlist 2>/dev/null || echo ""`);
          return { name: jail, ips: raw.split(/[\s,]+/).map((s: string) => s.trim()).filter((s: string) => /^\d+\.\d+\.\d+\.\d+$/.test(s)) };
        })),
        mainSsh(`iptables -S INPUT | grep ' -j DROP' | grep -oE '([0-9]{1,3}\\.){3}[0-9]{1,3}' | sort -u`),
        mainSsh(`iptables -S | awk '/^-A f2b-/{chain=$2; for(i=1;i<=NF;i++) if($i=="-s") ip=$(i+1); if(chain&&ip) print chain":"ip; chain=""; ip=""}'`),
        mainSsh(`ipset list iptv_ban 2>/dev/null | grep -E '^[0-9]+\\.' | awk '{print $1}' | sort -u`),
      ]);

      type MainJailEntry = { name: string; ips: string[]; type: "f2b" | "iptables-chain" | "iptables-manual" | "iptv_ban"; jailKey?: string };
      const jails: MainJailEntry[] = [];

      // fail2ban managed bans
      if (f2bResults.status === "fulfilled") {
        for (const r of f2bResults.value) {
          if (r.status === "fulfilled" && r.value.ips.length > 0)
            jails.push({ ...r.value, type: "f2b", jailKey: r.value.name });
        }
      }

      // iptables direct DROP in INPUT (manual bans)
      if (manualRaw.status === "fulfilled") {
        const ips = parseIps(manualRaw.value);
        if (ips.length > 0) jails.push({ name: "iptables-manual", ips, type: "iptables-manual" });
      }

      // f2b iptables chains (bans persisted in iptables after f2b restart)
      if (f2bChainRaw.status === "fulfilled") {
        const byChain: Record<string, string[]> = {};
        f2bChainRaw.value.split("\n").forEach((line: string) => {
          const m = line.match(/^(f2b-[^:]+):(\d+\.\d+\.\d+\.\d+)(\/\d+)?$/);
          if (!m) return;
          const jailKey = m[1].replace(/^f2b-/, "");
          if (!byChain[jailKey]) byChain[jailKey] = [];
          if (!byChain[jailKey].includes(m[2])) byChain[jailKey].push(m[2]);
        });
        for (const [jailKey, ips] of Object.entries(byChain)) {
          const alreadyShown = jails.some(j => j.jailKey === jailKey && j.ips.length > 0);
          if (!alreadyShown && ips.length > 0)
            jails.push({ name: jailKey + " (iptables)", ips, type: "iptables-chain", jailKey });
        }
      }

      // iptv_ban ipset
      if (iptvRaw.status === "fulfilled") {
        const ips = parseIps(iptvRaw.value);
        if (ips.length > 0) jails.push({ name: "iptv_ban", ips, type: "iptv_ban" });
      }

      res.json({ jails, updatedAt: new Date().toISOString() });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/main/unban", requireAuth, requireAdmin, async (req, res) => {
    const { ip, jail, type } = req.body;
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return res.status(400).json({ error: "IP non valido" });
    // strict: only lowercase alphanumeric, hyphen, underscore — no spaces/parens used in shell
    if (!jail || !/^[a-z0-9_-]{1,64}$/.test(jail)) return res.status(400).json({ error: "Jail non valida" });
    const validTypes = ["f2b", "iptables-chain", "iptables-manual", "iptv_ban"] as const;
    if (!validTypes.includes(type)) return res.status(400).json({ error: "Tipo non valido" });
    try {
      if (type === "iptables-manual") {
        // ip validated above, no user-controlled shell metacharacters
        await mainSsh(`iptables -D INPUT -s ${ip} -j DROP 2>/dev/null; true`);
      } else if (type === "iptables-chain") {
        // jail is [a-z0-9_-] only — safe to interpolate; chain derived server-side
        const chain = "f2b-" + jail;
        await mainSsh(`iptables -D ${chain} -s ${ip}/32 -j DROP 2>/dev/null; true`);
      } else if (type === "f2b") {
        await mainSsh(`fail2ban-client set ${jail} unbanip ${ip} 2>/dev/null; true`);
      } else {
        return res.status(400).json({ error: "Tipo non supportato per unban" });
      }
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Fleet Upgrade ────────────────────────────────────────────────────────────

  // Job attivo più recente (per riconnettersi dopo navigazione)
  app.get("/api/fleet/upgrade/active", requireAuth, (_req, res) => {
    const active = getActiveJob();
    if (!active) return res.status(404).json({ error: "Nessun job attivo" });
    res.json({ jobId: active.id, status: active.status });
  });

  // Avvia un job di upgrade su VPS selezionati
  app.post("/api/fleet/upgrade/start", requireAuth, requireAdmin, async (req, res) => {
    const { vpsIds } = req.body;
    if (!vpsIds) return res.status(400).json({ error: "vpsIds richiesto" });
    try {
      const jobId = await startUpgradeJob(vpsIds);
      res.json({ jobId });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // SSE stream per un job in corso
  app.get("/api/fleet/upgrade/:jobId/events", requireAuth, (req, res) => {
    const ok = subscribeToJob(req.params.jobId, res);
    if (!ok) res.status(404).json({ error: "Job non trovato" });
  });

  // Snapshot dello stato corrente (per polling/refresh)
  app.get("/api/fleet/upgrade/:jobId/status", requireAuth, (req, res) => {
    const job = getJobSnapshot(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job non trovato" });
    res.json(job);
  });

  // Log completo di un VPS (per download)
  app.get("/api/fleet/upgrade/:jobId/logs/:vpsId", requireAuth, (req, res) => {
    const logs = getJobLogs(req.params.jobId, req.params.vpsId);
    if (!logs) return res.status(404).json({ error: "Log non trovati" });
    res.json({ logs });
  });

  // ─── Fleet Nginx Config ───────────────────────────────────────────────────────

  const NGINX_TEMPLATE_PATH = join(process.cwd(), "server", "nginx-template.conf");
  const MODSEC_RELAXED_PATH = join(process.cwd(), "server", "modsec_api_relaxed.conf");
  const AGENT_ASN_LOG_STATS_PATH = join(process.cwd(), "agent", "asn-log-stats.py");
  const ASN_TO_IPSET_PATH = join(process.cwd(), "scripts", "asn-to-ipset.py");
  const UPDATE_ASN_BLOCK_PATH = join(process.cwd(), "scripts", "update-asn-block.sh");
  const UPDATE_LISTS_PATH = join(process.cwd(), "scripts", "update-lists.sh");
  const WHITELIST_WATCHER_PATH = join(process.cwd(), "scripts", "whitelist-watcher.sh");
  const ANTI_IPTV_PY_PATH = join(process.cwd(), "scripts", "anti-iptv.py");
  const ANTI_IPTV_SH_PATH = join(process.cwd(), "scripts", "anti-iptv.sh");
  const FAIL2BAN_TEMPLATE_DIR = join(process.cwd(), "scripts", "fail2ban");
  const FAIL2BAN_JAIL_TEMPLATE_PATH = join(FAIL2BAN_TEMPLATE_DIR, "jail.local");
  const FAIL2BAN_FILTER_NAMES = ["404-0", "block22", "nginx-abuse", "xtream", "xtream-api"];

  function isNginxOptimized(config: string): { optimized: boolean; checks: Record<string, boolean>; cacheSize?: string } {
    // Cache: verifica che sia presente un valore valido (non placeholder) >= 5g
    const cacheMatch = config.match(/stream_cache:200m max_size=(\d+[gGmM])/);
    const cacheSize = cacheMatch ? cacheMatch[1] : null;
    const cacheValid = cacheSize && !cacheSize.includes("__") && (
      cacheSize.toLowerCase().endsWith("g") ? parseInt(cacheSize) >= 5 :
      cacheSize.toLowerCase().endsWith("m") ? parseInt(cacheSize) >= 5120 : false
    );
    const checks: Record<string, boolean> = {
      streamCacheValid: !!cacheValid,
      modsecurityActive: /^\s*modsecurity\s+on;/m.test(config),
      reuseport: config.includes("listen 8880 reuseport"),
      upstreamKeepalive: config.includes("keepalive 32"),
      openFileCache: config.includes("open_file_cache max=10000"),
      largeProxyBuffers: config.includes("proxy_buffers 16 512k"),
    };
    return { optimized: Object.values(checks).every(Boolean), checks, cacheSize: cacheSize || undefined };
  }

  app.get("/api/fleet/nginx/template", requireAuth, (_req, res) => {
    try {
      const content = readFileSync(NGINX_TEMPLATE_PATH, "utf-8");
      res.json({ content });
    } catch (e: any) {
      res.status(500).json({ error: "Template non trovato: " + e.message });
    }
  });

  app.get("/api/fleet/nginx/status", requireAuth, async (_req, res) => {
    const vpsList = getAllVps().filter(v => v.enabled).map(s => getVpsById(s.id)).filter(Boolean) as any[];
    const results = await Promise.all(vpsList.map(async (vps) => {
      try {
        const data = await agentGet(vps, "/api/config/nginx.conf");
        const config: string = data.content || "";
        const { optimized, checks, cacheSize } = isNginxOptimized(config);
        return { vpsId: vps.id, vpsName: vps.name, optimized, checks, cacheSize, error: null };
      } catch (e: any) {
        return { vpsId: vps.id, vpsName: vps.name, optimized: false, checks: {}, cacheSize: null, error: e.message };
      }
    }));
    res.json(results);
  });

  function calculateCacheSize(diskFree: string): string {
    // diskFree es: "115G", "500M", "2T"
    const match = diskFree.match(/^(\d+(?:\.\d+)?)([gGmMtT])$/);
    if (!match) return "5g"; // fallback
    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    let freeGB: number;
    if (unit === "t") freeGB = value * 1024;
    else if (unit === "g") freeGB = value;
    else if (unit === "m") freeGB = value / 1024;
    else freeGB = 5;
    // 60% dello spazio libero, min 5g, max 100g
    const cacheGB = Math.min(100, Math.max(5, Math.floor(freeGB * 0.6)));
    return cacheGB + "g";
  }

  app.post("/api/fleet/nginx/apply", requireAuth, requireAdmin, async (req, res) => {
    const { vpsIds } = req.body;
    if (!vpsIds || !Array.isArray(vpsIds)) return res.status(400).json({ error: "vpsIds[] richiesto" });
    let template: string;
    try {
      template = readFileSync(NGINX_TEMPLATE_PATH, "utf-8");
    } catch (e: any) {
      return res.status(500).json({ error: "Template nginx non trovato sul server" });
    }
    const vpsList = getAllVps().filter(v => vpsIds.includes(v.id) && v.enabled).map(s => getVpsById(s.id)).filter(Boolean) as any[];
    const results = await Promise.all(vpsList.map(async (vps) => {
      try {
        // Ottieni info disco dal VPS
        const sysInfo = await agentGet(vps, "/api/system");
        const diskFree = sysInfo.disk?.free || "5g";
        const cacheSize = calculateCacheSize(diskFree);
        // Sostituisci placeholder nel template
        const config = template.replace(/__STREAM_CACHE_SIZE__/g, cacheSize);
        await agentPost(vps, "/api/system/setup-nginx-dirs", {});
        await agentPost(vps, "/api/config/nginx.conf", { content: config });
        const reload = await agentPost(vps, "/api/nginx/reload", {});
        return { vpsId: vps.id, vpsName: vps.name, ok: reload.ok !== false, cacheSize, error: reload.error };
      } catch (e: any) {
        return { vpsId: vps.id, vpsName: vps.name, ok: false, cacheSize: null, error: e.message };
      }
    }));
    res.json(results);
  });

  // ─── Fleet Netbird Cleanup ─────────────────────────────────────────────────────

  app.get("/api/fleet/netbird/cleanup-status", requireAuth, async (_req, res) => {
    const vpsList = getAllVps().filter(v => v.enabled).map(s => getVpsById(s.id)).filter(Boolean) as any[];
    const results = await Promise.all(vpsList.map(async (vps) => {
      try {
        const data = await agentGet(vps, "/api/netbird/cleanup-status");
        return { vpsId: vps.id, vpsName: vps.name, ready: data.ready, checks: data, error: null };
      } catch (e: any) {
        return { vpsId: vps.id, vpsName: vps.name, ready: false, checks: null, error: e.message };
      }
    }));
    res.json(results);
  });

  app.post("/api/fleet/netbird/setup-cleanup", requireAuth, requireAdmin, async (req, res) => {
    const { vpsIds } = req.body;
    if (!vpsIds || !Array.isArray(vpsIds)) return res.status(400).json({ error: "vpsIds[] richiesto" });
    const vpsList = getAllVps().filter(v => vpsIds.includes(v.id) && v.enabled).map(s => getVpsById(s.id)).filter(Boolean) as any[];
    const results = await Promise.all(vpsList.map(async (vps) => {
      try {
        const data = await agentPost(vps, "/api/netbird/setup-cleanup", {});
        return { vpsId: vps.id, vpsName: vps.name, ok: data.ok, error: data.ok ? null : "Setup fallito" };
      } catch (e: any) {
        return { vpsId: vps.id, vpsName: vps.name, ok: false, error: e.message };
      }
    }));
    res.json(results);
  });

  // ─── Fleet NetBird Update ──────────────────────────────────────────────────────

  app.get("/api/fleet/netbird/update-status", requireAuth, async (_req, res) => {
    const vpsList = getAllVps().filter(v => v.enabled).map(s => getVpsById(s.id)).filter(Boolean) as any[];
    const results = await Promise.all(vpsList.map(async (vps) => {
      try {
        const [statusData, versionData] = await Promise.all([
          agentGet(vps, "/api/netbird/status"),
          agentGet(vps, "/api/netbird/version"),
        ]);
        return {
          vpsId: vps.id,
          vpsName: vps.name,
          running: statusData.running,
          connected: statusData.connected,
          version: versionData.version || null,
          error: null,
        };
      } catch (e: any) {
        return { vpsId: vps.id, vpsName: vps.name, running: false, connected: false, version: null, error: e.message };
      }
    }));
    res.json(results);
  });

  let netbirdLatestCache: { version: string; fetchedAt: number } | null = null;
  app.get("/api/fleet/netbird/latest-version", requireAuth, async (_req, res) => {
    const CACHE_TTL = 3600 * 1000;
    if (netbirdLatestCache && Date.now() - netbirdLatestCache.fetchedAt < CACHE_TTL) {
      return res.json({ version: netbirdLatestCache.version });
    }
    try {
      const r = await fetch("https://api.github.com/repos/netbirdio/netbird/releases/latest", {
        headers: { "Accept": "application/vnd.github+json", "User-Agent": "ProxyGuardian" },
        signal: AbortSignal.timeout(5000),
      });
      const data: any = await r.json();
      const version = (data.tag_name || "").replace(/^v/, "") || null;
      if (version) netbirdLatestCache = { version, fetchedAt: Date.now() };
      res.json({ version });
    } catch {
      res.json({ version: netbirdLatestCache?.version || null });
    }
  });

  app.post("/api/fleet/netbird/update", requireAuth, requireAdmin, async (req, res) => {
    const { vpsIds } = req.body;
    if (!vpsIds || !Array.isArray(vpsIds)) return res.status(400).json({ error: "vpsIds richiesto" });
    const vpsList = getAllVps().filter(v => vpsIds.includes(v.id) && v.enabled).map(s => getVpsById(s.id)).filter(Boolean) as any[];
    const results = await Promise.allSettled(vpsList.map(async (vps) => {
      try {
        const data = await agentPost(vps, "/api/netbird/update", {}, SLOW_REQUEST_TIMEOUT);
        const versionData = await agentGet(vps, "/api/netbird/version").catch(() => null);
        return {
          vpsId: vps.id,
          vpsName: vps.name,
          ok: data.ok && data.running,
          newVersion: versionData?.version || null,
          output: data.output,
          error: data.ok ? null : (data.output || "Update fallito"),
        };
      } catch (e: any) {
        return { vpsId: vps.id, vpsName: vps.name, ok: false, newVersion: null, error: e.message };
      }
    }));
    res.json(results.map(r => r.status === "fulfilled" ? r.value : { vpsId: "unknown", vpsName: "unknown", ok: false, newVersion: null, error: "rejected" }));
  });

  // ─── Fleet CrowdSec ───────────────────────────────────────────────────────────

  app.get("/api/fleet/crowdsec/summary", requireAuth, async (_req, res) => {
    const vpsList = getAllVps().filter(v => v.enabled).map(s => getVpsById(s.id)).filter(Boolean) as any[];
    const results = await Promise.all(vpsList.map(async (vps) => {
      try {
        const [statusData, decisionsData] = await Promise.allSettled([
          agentGet(vps, "/api/crowdsec/status", 5000),
          agentGet(vps, "/api/crowdsec/decisions", 8000),
        ]);
        const status = statusData.status === "fulfilled" ? statusData.value : null;
        const decisions = decisionsData.status === "fulfilled" && Array.isArray(decisionsData.value)
          ? decisionsData.value
          : [];
        return {
          vpsId: vps.id,
          vpsName: vps.name,
          installed: status?.installed ?? false,
          crowdsecActive: status?.crowdsecActive ?? false,
          bouncerActive: status?.bouncerActive ?? false,
          activeDecisions: decisions.length,
          error: null,
        };
      } catch (e: any) {
        return { vpsId: vps.id, vpsName: vps.name, installed: false, crowdsecActive: false, bouncerActive: false, activeDecisions: 0, error: e.message };
      }
    }));
    res.json(results);
  });

  // ─── Scenario management (server-side YAML files) ────────────────────────────

  const SCENARIOS_DIR = join(process.cwd(), "crowdsec", "scenarios");

  app.get("/api/crowdsec/scenarios", requireAuth, (_req, res) => {
    try {
      if (!existsSync(SCENARIOS_DIR)) return res.json([]);
      const names = readdirSync(SCENARIOS_DIR)
        .filter((f: string) => f.endsWith(".yaml") || f.endsWith(".yml"))
        .map((f: string) => f.replace(/\.(yaml|yml)$/, ""));
      const scenarios = names.map((name: string) => {
        try {
          const content = readFileSync(join(SCENARIOS_DIR, name + ".yaml"), "utf-8");
          return { name, content };
        } catch {
          return { name, content: "" };
        }
      });
      res.json(scenarios);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/crowdsec/scenarios/:name", requireAuth, (req, res) => {
    const name = req.params.name;
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: "Invalid name" });
    try {
      const content = readFileSync(join(SCENARIOS_DIR, name + ".yaml"), "utf-8");
      res.json({ name, content });
    } catch (e: any) {
      res.status(404).json({ error: "Scenario not found" });
    }
  });

  app.post("/api/crowdsec/scenarios/:name", requireAuth, requireOperator, async (req, res) => {
    const name = req.params.name;
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: "Invalid name" });
    const content = typeof req.body.content === "string" ? req.body.content : "";
    if (!content.trim()) return res.status(400).json({ error: "Content required" });
    if (!existsSync(SCENARIOS_DIR)) mkdirSync(SCENARIOS_DIR, { recursive: true });
    writeFileSync(join(SCENARIOS_DIR, name + ".yaml"), content, "utf-8");
    // Deploy to all CrowdSec VPS
    const vpsList = getAllVps().filter(v => v.enabled).map(s => getVpsById(s.id)).filter(Boolean) as any[];
    const deployResults = await Promise.allSettled(vpsList.map(async (vps) => {
      try {
        const status = await agentGet(vps, "/api/crowdsec/status", 5000);
        if (!status.installed) return { vpsId: vps.id, vpsName: vps.name, ok: false, reason: "not installed" };
        const r = await agentPost(vps, "/api/crowdsec/scenario", { name, content }, 15000);
        return { vpsId: vps.id, vpsName: vps.name, ok: r.ok === true };
      } catch (e: any) {
        return { vpsId: vps.id, vpsName: vps.name, ok: false, reason: e.message };
      }
    }));
    res.json({ saved: true, deploy: deployResults.map(r => r.status === "fulfilled" ? r.value : { ok: false }) });
  });

  app.delete("/api/crowdsec/scenarios/:name", requireAuth, requireOperator, async (req, res) => {
    const name = req.params.name;
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: "Invalid name" });
    const filePath = join(SCENARIOS_DIR, name + ".yaml");
    if (existsSync(filePath)) {
      try { unlinkSync(filePath); } catch { /* ignore */ }
    }
    // Undeploy from all CrowdSec VPS
    const vpsList = getAllVps().filter(v => v.enabled).map(s => getVpsById(s.id)).filter(Boolean) as any[];
    const deployResults = await Promise.allSettled(vpsList.map(async (vps) => {
      try {
        const status = await agentGet(vps, "/api/crowdsec/status", 5000);
        if (!status.installed) return { vpsId: vps.id, vpsName: vps.name, ok: false, reason: "not installed" };
        const r = await agentDelete(vps, `/api/crowdsec/scenario/${name}`, 15000);
        return { vpsId: vps.id, vpsName: vps.name, ok: r.ok === true };
      } catch (e: any) {
        return { vpsId: vps.id, vpsName: vps.name, ok: false, reason: e.message };
      }
    }));
    res.json({ deleted: true, deploy: deployResults.map(r => r.status === "fulfilled" ? r.value : { ok: false }) });
  });

  app.get("/api/fleet/crowdsec/decisions", requireAuth, async (_req, res) => {
    const vpsList = getAllVps().filter(v => v.enabled).map(s => getVpsById(s.id)).filter(Boolean) as any[];
    const results = await Promise.allSettled(vpsList.map(async (vps) => {
      try {
        const status = await agentGet(vps, "/api/crowdsec/status", 5000);
        if (!status.installed) return { vpsId: vps.id, vpsName: vps.name, decisions: [], skipped: true };
        const decisions = await agentGet(vps, "/api/crowdsec/decisions", 10000);
        return { vpsId: vps.id, vpsName: vps.name, decisions: Array.isArray(decisions) ? decisions : [], skipped: false };
      } catch (e: any) {
        return { vpsId: vps.id, vpsName: vps.name, decisions: [], error: e.message };
      }
    }));
    res.json(results.map(r => r.status === "fulfilled" ? r.value : { vpsId: "", vpsName: "", decisions: [], error: "rejected" }));
  });

  app.post("/api/fleet/crowdsec/unban", requireAuth, requireOperator, async (req, res) => {
    const { ip } = req.body;
    if (!ip || typeof ip !== "string" || !/^[0-9a-fA-F.:/]{1,43}$/.test(ip)) {
      return res.status(400).json({ error: "IP non valido" });
    }
    const vpsList = getAllVps().filter(v => v.enabled).map(s => getVpsById(s.id)).filter(Boolean) as any[];
    const results = await Promise.allSettled(vpsList.map(async (vps) => {
      try {
        const status = await agentGet(vps, "/api/crowdsec/status", 5000);
        if (!status.installed) return { vpsId: vps.id, vpsName: vps.name, ok: false, reason: "not installed" };
        const r = await agentPost(vps, "/api/crowdsec/unban", { ip }, 10000);
        return { vpsId: vps.id, vpsName: vps.name, ok: r.ok === true };
      } catch (e: any) {
        return { vpsId: vps.id, vpsName: vps.name, ok: false, reason: e.message };
      }
    }));
    res.json(results.map(r => r.status === "fulfilled" ? r.value : { ok: false }));
  });

  app.get("/api/fleet/crowdsec/metrics", requireAuth, async (_req, res) => {
    const vpsList = getAllVps().filter(v => v.enabled).map(s => getVpsById(s.id)).filter(Boolean) as any[];
    const results = await Promise.allSettled(vpsList.map(async (vps) => {
      try {
        const status = await agentGet(vps, "/api/crowdsec/status", 5000);
        if (!status.installed) return { vpsId: vps.id, vpsName: vps.name, metrics: null, skipped: true };
        const data = await agentGet(vps, "/api/crowdsec/metrics", 15000);
        return { vpsId: vps.id, vpsName: vps.name, metrics: data.metrics || null, skipped: false };
      } catch (e: any) {
        return { vpsId: vps.id, vpsName: vps.name, metrics: null, error: e.message };
      }
    }));
    res.json(results.map(r => r.status === "fulfilled" ? r.value : { vpsId: "", vpsName: "", metrics: null, error: "rejected" }));
  });

  // ─── Fleet Sudoers Update ────────────────────────────────────────────────────

  app.post("/api/fleet/update-sudoers", requireAuth, requireAdmin, async (req, res) => {
    const { vpsIds } = req.body;
    const all = getAllVps().filter(v => v.enabled).map(s => getVpsById(s.id)).filter(Boolean) as any[];
    const targets = vpsIds && Array.isArray(vpsIds)
      ? all.filter(v => vpsIds.includes(v.id))
      : all;
    const results = await Promise.allSettled(targets.map(async (vps) => {
      try {
        const r = await agentPost(vps, "/api/system/update-sudoers", {}, 15000);
        return { vpsId: vps.id, vpsName: vps.name, ok: r.ok === true };
      } catch (e: any) {
        return { vpsId: vps.id, vpsName: vps.name, ok: false, error: e.message };
      }
    }));
    res.json(results.map(r => r.status === "fulfilled" ? r.value : { ok: false }));
  });

  // ─── Fleet Logrotate ───────────────────────────────────────────────────────────

  app.get("/api/fleet/logrotate/status", requireAuth, async (_req, res) => {
    const vpsList = getAllVps().filter(v => v.enabled).map(s => getVpsById(s.id)).filter(Boolean) as any[];
    const results = await Promise.all(vpsList.map(async (vps) => {
      try {
        const data = await agentGet(vps, "/api/logrotate/status");
        return { vpsId: vps.id, vpsName: vps.name, ready: data.ready, checks: data, error: null };
      } catch (e: any) {
        return { vpsId: vps.id, vpsName: vps.name, ready: false, checks: null, error: e.message };
      }
    }));
    res.json(results);
  });

  app.post("/api/fleet/logrotate/setup", requireAuth, requireAdmin, async (req, res) => {
    const { vpsIds, config } = req.body;
    if (!vpsIds || !Array.isArray(vpsIds)) return res.status(400).json({ error: "vpsIds[] richiesto" });
    const vpsList = getAllVps().filter(v => vpsIds.includes(v.id) && v.enabled).map(s => getVpsById(s.id)).filter(Boolean) as any[];
    const results = await Promise.all(vpsList.map(async (vps) => {
      try {
        const data = await agentPost(vps, "/api/logrotate/setup", { config });
        return { vpsId: vps.id, vpsName: vps.name, ok: data.ok, error: data.ok ? null : "Setup fallito" };
      } catch (e: any) {
        return { vpsId: vps.id, vpsName: vps.name, ok: false, error: e.message };
      }
    }));
    res.json(results);
  });

  // ─── Fleet Nginx Versions ─────────────────────────────────────────────────────

  app.get("/api/fleet/nginx/versions", requireAuth, async (_req, res) => {
    const vpsList = getAllVps().filter(v => v.enabled).map(s => getVpsById(s.id)).filter(Boolean) as any[];
    const results = await Promise.all(vpsList.map(async (vps) => {
      try {
        const data = await agentGet(vps, "/api/nginx/version");
        return { vpsId: vps.id, vpsName: vps.name, version: data.version || null, error: null };
      } catch (e: any) {
        return { vpsId: vps.id, vpsName: vps.name, version: null, error: e.message };
      }
    }));
    res.json(results);
  });

  // ─── Fleet SSH Key ────────────────────────────────────────────────────────────

  app.get("/api/fleet/ssh-key", requireAuth, requireAdmin, (_req, res) => {
    try {
      const key = readFileSync(join(homedir(), ".ssh", "id_ed25519.pub"), "utf-8").trim();
      res.json({ key });
    } catch {
      res.status(404).json({ error: "Chiave SSH non trovata su questo server" });
    }
  });

  app.post("/api/fleet/ssh-key/install/:vpsId", requireAuth, requireAdmin, async (req, res) => {
    const vps = getVpsById(req.params.vpsId);
    if (!vps) return res.status(404).json({ error: "VPS non trovato" });
    let key: string;
    try {
      key = readFileSync(join(homedir(), ".ssh", "id_ed25519.pub"), "utf-8").trim();
    } catch {
      return res.status(500).json({ error: "Chiave SSH non trovata sul server dashboard" });
    }
    try {
      const data = await agentPost(vps, "/api/system/install-ssh-key", { publicKey: key });
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── SSH Console ──────────────────────────────────────────────────────────────

  // Genera token usa-e-getta (30s) per autenticare la WebSocket SSH
  app.post("/api/admin/ssh/token", requireAuth, requireAdmin, (req, res) => {
    const { vpsId } = req.body;
    if (!vpsId) return res.status(400).json({ error: "vpsId richiesto" });
    const vps = getVpsById(vpsId);
    if (!vps) return res.status(404).json({ error: "VPS non trovato" });
    const token = generateSshToken(vpsId, req.session.userId!);
    res.json({ token });
  });

  // ─── Deploy VPS ───────────────────────────────────────────────────────────────

  app.post("/api/deploy/generate-script", requireAuth, requireAdmin, (req, res) => {
    try {
      if (!NETBIRD_SETUP_KEY) {
        return res.status(503).json({ error: "NETBIRD_SETUP_KEY non configurata sul dashboard" });
      }

      const rawName = typeof req.body?.vpsName === "string" ? req.body.vpsName.trim() : "";
      const rawBackendIp = typeof req.body?.backendIp === "string" ? req.body.backendIp.trim() : "";
      const bPort = parseDeployPort(req.body?.backendPort, 8880);
      const pPort = parseDeployPort(req.body?.proxyPort, 8880);
      const installAsnBlock = parseDeployToggle(req.body?.installAsnBlock, true);
      const installAntiIptv = parseDeployToggle(req.body?.installAntiIptv, false);
      const installCrowdSec = parseDeployToggle(req.body?.installCrowdSec, false);

      if (!rawName || !DEPLOY_VPS_NAME_RE.test(rawName)) {
        return res.status(400).json({ error: "Nome VPS non valido: usa solo lettere, numeri, spazi e .()_-" });
      }
      if (!rawBackendIp || !isValidDeployHost(rawBackendIp)) {
        return res.status(400).json({ error: "Backend IP / hostname non valido" });
      }
      if (bPort === null || pPort === null) {
        return res.status(400).json({ error: "Porta non valida: usa un valore tra 1 e 65535" });
      }

      const name = rawName;
      const bIp = rawBackendIp;
      const agentBundleUrl = `https://raw.githubusercontent.com/perfido19/ProxyGuardian/${DEPLOY_AGENT_GIT_REF}/agent/agent-bundle.js`;
      const bannerName = name.length > 47 ? `${name.slice(0, 44)}...` : name.padEnd(47);
      const bannerGeneratedAt = new Date().toISOString().slice(0, 19).padEnd(47);

      const nginxTemplate = readFileSync(NGINX_TEMPLATE_PATH, "utf-8");
      const nginxConf = nginxTemplate
        .replace(/__STREAM_CACHE_SIZE__/g, "5g")
        .replace(/main\.netbird\.cloud:8880/g, `${bIp}:${bPort}`)
        .replace(/listen 8880 reuseport/g, `listen ${pPort} reuseport`);

      const modsecRelaxed = readFileSync(MODSEC_RELAXED_PATH, "utf-8");

      const countryWhitelist = readFleetFile("country_whitelist.conf") || "";
      const blockAsn = installAsnBlock ? (readFleetFile("block_asn.conf") || "") : "";
      const blockIsp = readFleetFile("block_isp.conf") || "";
      const blockBadAgents = readFleetFile("block_badagents.conf") || "";
      const ipWhitelist = readFleetFile("ip_whitelist.conf") || "";
      const exclusionIp = readFleetFile("exclusion_ip.conf") || "";
      const asnBlocklist = installAsnBlock ? (readFleetFile("asn-blocklist.txt") || "# Fleet ASN Blocklist — nessuna entry configurata") : "";
      const asnWhitelist = installAsnBlock ? (readFleetFile("asn-whitelist.txt") || "# Fleet ASN Whitelist — nessuna entry configurata") : "";
      const agentAsnLogStats = readFileSync(AGENT_ASN_LOG_STATS_PATH, "utf-8");
      const asnToIpsetPy = installAsnBlock ? readFileSync(ASN_TO_IPSET_PATH, "utf-8") : "";
      const updateAsnBlockScript = installAsnBlock ? readFileSync(UPDATE_ASN_BLOCK_PATH, "utf-8") : "";
      const updateListsScript = installAsnBlock ? readFileSync(UPDATE_LISTS_PATH, "utf-8") : "";
      const whitelistWatcherScript = installAsnBlock ? readFileSync(WHITELIST_WATCHER_PATH, "utf-8") : "";
      const antiIptvPy = installAntiIptv ? readFileSync(ANTI_IPTV_PY_PATH, "utf-8") : "";
      const antiIptvSh = installAntiIptv ? readFileSync(ANTI_IPTV_SH_PATH, "utf-8") : "";
      const fail2banJailTemplate = readFileSync(FAIL2BAN_JAIL_TEMPLATE_PATH, "utf-8");
      const fail2banFilters = Object.fromEntries(FAIL2BAN_FILTER_NAMES.map((name) => [
        name,
        readFileSync(join(FAIL2BAN_TEMPLATE_DIR, `${name}.conf`), "utf-8"),
      ]));
      const geoIpAccountId = process.env.GEOIP_ACCOUNT_ID?.trim();
      const geoIpLicenseKey = process.env.GEOIP_LICENSE_KEY?.trim();
      const optionalPackages = Array.from(new Set([
        ...(installAsnBlock ? ["ipset", "inotify-tools", "python3-maxminddb", "python3-pip"] : []),
        ...(installAntiIptv ? ["conntrack", "ipset"] : []),
      ]));
      const optionalPackageSetup = optionalPackages.length > 0
        ? `# ── OPTIONAL PACKAGES ──────────────────────────────────────
info "Installing optional packages..."
apt-get install -y ${optionalPackages.join(" ")}`
        : "";

      const fail2banDbSetup = `# ── DATABASE FAIL2BAN ──────────────────────────────────────
info "Creating fail2ban database..."
FAIL2BAN_DB_NAME="fail2ban"
FAIL2BAN_DB_USER="f2b_\$(openssl rand -hex 4)"
FAIL2BAN_DB_PASSWORD="\$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 24)"

mysql -uroot -e "CREATE DATABASE IF NOT EXISTS \${FAIL2BAN_DB_NAME};"
mysql -uroot -e "CREATE USER IF NOT EXISTS '\${FAIL2BAN_DB_USER}'@'localhost' IDENTIFIED BY '\${FAIL2BAN_DB_PASSWORD}';"
mysql -uroot -e "CREATE USER IF NOT EXISTS '\${FAIL2BAN_DB_USER}'@'127.0.0.1' IDENTIFIED BY '\${FAIL2BAN_DB_PASSWORD}';"
mysql -uroot -e "GRANT ALL ON \${FAIL2BAN_DB_NAME}.* TO '\${FAIL2BAN_DB_USER}'@'localhost';"
mysql -uroot -e "GRANT ALL ON \${FAIL2BAN_DB_NAME}.* TO '\${FAIL2BAN_DB_USER}'@'127.0.0.1';"
mysql -uroot -e "FLUSH PRIVILEGES;"

mkdir -p ~/tmp
cd ~/tmp
wget -q https://github.com/iredmail/iRedMail/raw/1.3/samples/fail2ban/sql/fail2ban.mysql
wget -q https://github.com/iredmail/iRedMail/raw/1.3/samples/fail2ban/action.d/banned_db.conf
wget -q https://github.com/iredmail/iRedMail/raw/1.3/samples/fail2ban/bin/fail2ban_banned_db
mysql \${FAIL2BAN_DB_NAME} < ~/tmp/fail2ban.mysql

cat > /root/.my.cnf-fail2ban << MYCNFEOF
[client]
host="127.0.0.1"
port="3306"
user="\${FAIL2BAN_DB_USER}"
password="\${FAIL2BAN_DB_PASSWORD}"
MYCNFEOF
chmod 600 /root/.my.cnf-fail2ban

mv ~/tmp/banned_db.conf /etc/fail2ban/action.d/
mv ~/tmp/fail2ban_banned_db /usr/local/bin/
chmod 0550 /usr/local/bin/fail2ban_banned_db`;

      const geoIpSetup = geoIpAccountId && geoIpLicenseKey
        ? `# ── GEOIP2 ─────────────────────────────────────────────────
info "Configuring GeoIP2..."
mkdir -p /usr/share/GeoIP
cat > /etc/GeoIP.conf << GEOEOF
AccountID ${geoIpAccountId}
LicenseKey ${geoIpLicenseKey}
EditionIDs GeoLite2-ASN GeoLite2-City GeoLite2-Country
DatabaseDirectory /usr/share/GeoIP
GEOEOF

chmod 600 /etc/GeoIP.conf
cat > /etc/cron.d/proxyguardian-geoipupdate << 'CRONEOF'
0 1 * * * root /usr/bin/geoipupdate >/var/log/geoipupdate.log 2>&1
CRONEOF
chmod 644 /etc/cron.d/proxyguardian-geoipupdate
geoipupdate -v || error "geoipupdate fallito — verifica credenziali MaxMind in .env"
[ -f /usr/share/GeoIP/GeoLite2-Country.mmdb ] || error "Database GeoIP2 non trovato dopo geoipupdate"`
        : `# ── GEOIP2 ─────────────────────────────────────────────────
error "GEOIP_ACCOUNT_ID / GEOIP_LICENSE_KEY non impostati — richiesti per nginx. Configurali nel .env del dashboard e rigenera lo script."`;

      const asnBlockSetup = installAsnBlock
        ? `# ── ASN BLOCK ──────────────────────────────────────────────
info "Installing ASN block support..."
mkdir -p /etc/iptables
touch /etc/ipset.conf /var/log/update-asn-block.log

cat > /etc/asn-blocklist.txt << 'ASNBLKEOF'
${asnBlocklist}
ASNBLKEOF

cat > /etc/asn-whitelist-nets.txt << 'ASNWLEOF'
${asnWhitelist}
ASNWLEOF

cat > /usr/local/bin/asn-to-ipset.py << 'ASNTOIPSETEOF'
${asnToIpsetPy}
ASNTOIPSETEOF

cat > /usr/local/bin/update-asn-block.sh << 'UPDATEASNBLKEOF'
${updateAsnBlockScript}
UPDATEASNBLKEOF

cat > /usr/local/bin/update-lists.sh << 'UPDATELISTSEOF'
${updateListsScript}
UPDATELISTSEOF

cat > /usr/local/bin/whitelist-watcher.sh << 'WHITELISTWATCHEREOF'
${whitelistWatcherScript}
WHITELISTWATCHEREOF

chmod 755 /usr/local/bin/asn-to-ipset.py /usr/local/bin/update-asn-block.sh /usr/local/bin/update-lists.sh /usr/local/bin/whitelist-watcher.sh

pip3 install --break-system-packages maxminddb==2.6.3 >/dev/null 2>&1 || \
  pip3 install maxminddb==2.6.3 >/dev/null 2>&1 || \
  warn "Installazione maxminddb 2.6.3 fallita, provo con pacchetto di sistema"

cat > /etc/systemd/system/ipset-restore.service << 'IPSETRESTOREEOF'
${DEPLOY_IPSET_RESTORE_SERVICE}
IPSETRESTOREEOF

cat > /etc/systemd/system/whitelist-watcher.service << 'WHITELISTWATCHERSVCEOF'
${DEPLOY_WHITELIST_WATCHER_SERVICE}
WHITELISTWATCHERSVCEOF

ipset create blocked_asn hash:net family inet maxelem 1048576 -exist
iptables -C INPUT -m set --match-set blocked_asn src -m limit --limit 10/min --limit-burst 20 -j LOG --log-prefix "[ASN-BLOCK] " --log-level 4 2>/dev/null || \
  iptables -I INPUT 1 -m set --match-set blocked_asn src -m limit --limit 10/min --limit-burst 20 -j LOG --log-prefix "[ASN-BLOCK] " --log-level 4
iptables -C INPUT -m set --match-set blocked_asn src -j DROP 2>/dev/null || \
  iptables -I INPUT 2 -m set --match-set blocked_asn src -j DROP
ipset save > /etc/ipset.conf

if grep -Eq '^[[:space:]]*AS[0-9]+' /etc/asn-blocklist.txt; then
  /usr/local/bin/update-asn-block.sh >> /var/log/update-asn-block.log 2>&1 || warn "Aggiornamento iniziale ASN block fallito"
else
  warn "ASN blocklist vuota: installazione completata senza popolamento iniziale"
fi`
        : `# ── ASN BLOCK ──────────────────────────────────────────────
info "ASN block disabilitato per questo deploy"`;

      const crowdSecSetup = installCrowdSec
        ? `# ── CROWDSEC ────────────────────────────────────────────────
info "Installing CrowdSec..."
curl -fsSL https://packagecloud.io/crowdsec/crowdsec/gpgkey | gpg --dearmor -o /usr/share/keyrings/crowdsec-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/crowdsec-archive-keyring.gpg] https://packagecloud.io/crowdsec/crowdsec/ubuntu \$(lsb_release -cs) main" > /etc/apt/sources.list.d/crowdsec.list
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y crowdsec crowdsec-firewall-bouncer-iptables

cscli hub update >/dev/null 2>&1 || true
cscli collections install crowdsecurity/nginx >/dev/null 2>&1 || warn "Collection nginx parziale"
cscli scenarios install crowdsecurity/nginx-req-limit-exceeded >/dev/null 2>&1 || true
cscli scenarios install crowdsecurity/http-probing >/dev/null 2>&1 || true

echo "pgagent ALL=(ALL) NOPASSWD: /usr/bin/cscli *" > /etc/sudoers.d/pgagent-crowdsec
chmod 440 /etc/sudoers.d/pgagent-crowdsec
visudo -c >/dev/null 2>&1 || warn "Verifica manuale /etc/sudoers.d/pgagent-crowdsec"

systemctl enable crowdsec crowdsec-firewall-bouncer >/dev/null 2>&1 || true
systemctl restart crowdsec
sleep 2
systemctl restart crowdsec-firewall-bouncer || warn "crowdsec-firewall-bouncer restart fallito"
ok "CrowdSec installato (firewall bouncer iptables)"`
        : `# ── CROWDSEC ────────────────────────────────────────────────
info "CrowdSec disabilitato per questo deploy"`;

      const antiIptvSetup = installAntiIptv
        ? `# ── ANTI-IPTV ──────────────────────────────────────────────
info "Installing Anti-IPTV support..."
mkdir -p /var/log/anti-iptv
touch /var/log/anti-iptv/bans.log

cat > /usr/local/sbin/anti-iptv.py << 'ANTIIPTVPYEOF'
${antiIptvPy}
ANTIIPTVPYEOF

cat > /usr/local/sbin/anti-iptv.sh << 'ANTIIPTVSHEOF'
${antiIptvSh}
ANTIIPTVSHEOF

chmod 755 /usr/local/sbin/anti-iptv.py /usr/local/sbin/anti-iptv.sh
chown root:adm /var/log/anti-iptv /var/log/anti-iptv/bans.log 2>/dev/null || true
chmod 750 /var/log/anti-iptv 2>/dev/null || true
chmod 640 /var/log/anti-iptv/bans.log 2>/dev/null || true

cat > /etc/systemd/system/anti-iptv.service << 'ANTIIPTVSVCEOF'
${DEPLOY_ANTI_IPTV_SERVICE}
ANTIIPTVSVCEOF`
        : `# ── ANTI-IPTV ──────────────────────────────────────────────
info "Anti-IPTV disabilitato per questo deploy"`;

      const script = `#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════╗
# ║  ProxyGuardian - Deploy Script                          ║
# ║  VPS: ${bannerName}║
# ║  Generato: ${bannerGeneratedAt}║
# ╚══════════════════════════════════════════════════════════╝

set -euo pipefail

RED='\\033[0;31m'; GREEN='\\033[0;32m'; YELLOW='\\033[1;33m'; CYAN='\\033[0;36m'; NC='\\033[0m'
info()  { echo -e "\${CYAN}[INFO]\${NC} \$*"; }
ok()    { echo -e "\${GREEN}[OK]\${NC}   \$*"; }
warn()  { echo -e "\${YELLOW}[WARN]\${NC} \$*"; }
error() { echo -e "\${RED}[ERR]\${NC}  \$*"; exit 1; }

BACKEND_IP=${shellQuote(bIp)}
BACKEND_PORT=${bPort}
PROXY_PORT=${pPort}
VPS_NAME=${shellQuote(name)}
NETBIRD_SETUP_KEY=${shellQuote(NETBIRD_SETUP_KEY)}
AGENT_BUNDLE_URL=${shellQuote(agentBundleUrl)}
numcpu=\$(nproc)

echo ""
echo -e "\${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
echo -e "\${CYAN}   ProxyGuardian Deploy - \$VPS_NAME\${NC}"
echo -e "\${CYAN}   Backend: \$BACKEND_IP:\$BACKEND_PORT | Porta: \$PROXY_PORT\${NC}"
echo -e "\${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
echo ""

[ "\$(id -u)" -eq 0 ] || error "Esegui con sudo o come root"

# ── SISTEMA BASE ───────────────────────────────────────────
info "Updating & installing dependencies..."
apt-get update -y
apt-get upgrade -y
apt-get install -y \\
  build-essential libpcre3 libpcre3-dev zlib1g-dev libssl-dev \\
  libxslt1-dev fail2ban mariadb-server git libtool autoconf \\
  libxml2-dev libcurl4-openssl-dev automake pkgconf libyajl-dev \\
  liblua5.1-0-dev wget curl ca-certificates gnupg software-properties-common

apt-get install -y libmaxminddb-dev libmaxminddb0 mmdb-bin

# geoipupdate da GitHub releases (PPA maxmind spesso irraggiungibile)
GEOIPUPDATE_VER="6.1.0"
wget -q "https://github.com/maxmind/geoipupdate/releases/download/v\${GEOIPUPDATE_VER}/geoipupdate_\${GEOIPUPDATE_VER}_linux_amd64.deb" -O /tmp/geoipupdate.deb \\
  && dpkg -i /tmp/geoipupdate.deb >/dev/null 2>&1 \\
  && rm -f /tmp/geoipupdate.deb \\
  || warn "geoipupdate install fallito — GeoIP2 non disponibile"

# ── MODSECURITY v3 ─────────────────────────────────────────
info "Compiling ModSecurity v3..."
cd /usr/local/src
rm -rf ModSecurity
git clone --depth 1 -b v3.0.12 https://github.com/SpiderLabs/ModSecurity
cd ModSecurity
git submodule init && git submodule update
./build.sh && ./configure
make -j "\$numcpu" && make install

# ── MODSECURITY-NGINX CONNECTOR ────────────────────────────
cd /usr/local/src
rm -rf ModSecurity-nginx
git clone --depth 1 https://github.com/SpiderLabs/ModSecurity-nginx

# ── GEOIP2 MODULE ──────────────────────────────────────────
cd /usr/local/src
rm -rf ngx_http_geoip2_module-*
wget -q "https://github.com/leev/ngx_http_geoip2_module/archive/refs/tags/3.4.tar.gz" -O geoip2_module.tar.gz
tar zxf geoip2_module.tar.gz
GEOIP2_DIR=\$(ls -d /usr/local/src/ngx_http_geoip2_module-*)

# ── BUILD NGINX 1.26.2 ─────────────────────────────────────
info "Building Nginx 1.26.2..."
cd /usr/local/src
rm -rf "nginx-1.26.2" "nginx-1.26.2.tar.gz"
wget -q "https://nginx.org/download/nginx-1.26.2.tar.gz"
tar xzf "nginx-1.26.2.tar.gz"
cd "nginx-1.26.2"

./configure \\
  --with-cc-opt='-g -O2 -fPIE -fstack-protector-strong -Wformat -Werror=format-security -fPIC -Wdate-time -D_FORTIFY_SOURCE=2' \\
  --with-ld-opt='-Wl,-Bsymbolic-functions -fPIE -pie -Wl,-z,relro -Wl,-z,now -fPIC' \\
  --prefix=/usr/share/nginx --conf-path=/etc/nginx/nginx.conf \\
  --http-log-path=/var/log/nginx/access.log --error-log-path=/var/log/nginx/error.log \\
  --lock-path=/var/lock/nginx.lock --pid-path=/run/nginx.pid \\
  --modules-path=/usr/lib/nginx/modules \\
  --http-client-body-temp-path=/var/lib/nginx/body \\
  --http-fastcgi-temp-path=/var/lib/nginx/fastcgi \\
  --http-proxy-temp-path=/var/lib/nginx/proxy \\
  --http-scgi-temp-path=/var/lib/nginx/scgi \\
  --http-uwsgi-temp-path=/var/lib/nginx/uwsgi \\
  --with-pcre-jit --with-http_ssl_module --with-http_stub_status_module \\
  --with-http_realip_module --with-http_auth_request_module --with-http_v2_module \\
  --with-http_dav_module --with-http_slice_module --with-threads \\
  --with-http_addition_module --with-http_gunzip_module --with-http_gzip_static_module \\
  --with-http_sub_module --with-http_xslt_module=dynamic --with-stream=dynamic \\
  --with-stream_ssl_module --with-stream_ssl_preread_module --with-mail=dynamic \\
  --with-mail_ssl_module \\
  --add-dynamic-module=/usr/local/src/ModSecurity-nginx \\
  --add-dynamic-module="\$GEOIP2_DIR"

make -j "\$numcpu" && make install

ln -sf /usr/share/nginx/sbin/nginx /usr/sbin/nginx
ln -sf /usr/lib/nginx/modules /usr/share/nginx/modules
mkdir -p /var/lib/nginx/body /var/cache/nginx/epg /var/cache/nginx/streaming
chown -R www-data:www-data /var/cache/nginx/epg /var/cache/nginx/streaming

# ── NGINX.SERVICE ──────────────────────────────────────────
cat > /lib/systemd/system/nginx.service << 'SVCEOF'
[Unit]
Description=The NGINX HTTP and reverse proxy server
After=syslog.target network.target remote-fs.target nss-lookup.target

[Service]
Type=forking
PIDFile=/run/nginx.pid
ExecStartPre=/usr/sbin/nginx -t
ExecStart=/usr/sbin/nginx
ExecReload=/usr/sbin/nginx -s reload
ExecStop=/bin/kill -s QUIT \$MAINPID
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SVCEOF

# ── NGINX.CONF ─────────────────────────────────────────────
info "Installing nginx.conf..."
cat > /etc/nginx/nginx.conf << 'NGINXEOF'
${nginxConf}
NGINXEOF

# ── FILE CONFIG NGINX ──────────────────────────────────────
info "Creating nginx config files..."

cat > /etc/nginx/country_whitelist.conf << 'EOF'
${countryWhitelist || "# Default: tutti i paesi bloccati"}
EOF

cat > /etc/nginx/block_asn.conf << 'EOF'
${blockAsn || "# ASN block disabilitato per questo VPS"}
EOF

cat > /etc/nginx/block_isp.conf << 'EOF'
${blockIsp || "# ISP Block"}
EOF

cat > /etc/nginx/block_badagents.conf << 'EOF'
${blockBadAgents || "# Bad Agents Block"}
EOF

cat > /etc/nginx/ip_whitelist.conf << 'EOF'
${ipWhitelist || "# IP whitelist"}
EOF

cat > /etc/nginx/exclusion_ip.conf << 'EOF'
${exclusionIp || "# Esclusioni country block"}
EOF

# ── MODSECURITY CONFIG ─────────────────────────────────────
info "Configuring ModSecurity..."
mkdir -p /etc/nginx/modsec /etc/nginx/rules /opt/log

cp /usr/local/src/ModSecurity/modsecurity.conf-recommended /etc/nginx/modsec/modsecurity.conf
cp /usr/local/src/ModSecurity/unicode.mapping /etc/nginx/modsec/

sed -i "s/SecRuleEngine DetectionOnly/SecRuleEngine On/" /etc/nginx/modsec/modsecurity.conf
sed -i "s/SecAuditLogType Serial/SecAuditLogType Concurrent/" /etc/nginx/modsec/modsecurity.conf
sed -i "s|SecAuditLog /var/log/modsec_audit.log|SecAuditLog /opt/log/modsec_audit.log|" /etc/nginx/modsec/modsecurity.conf

chmod -R 755 /opt/log
chown -R www-data:www-data /opt/log

# ── OWASP CRS v4 ───────────────────────────────────────────
info "Installing OWASP CRS v4..."
cd /etc/nginx/modsec
rm -rf coreruleset
git clone --depth 1 https://github.com/coreruleset/coreruleset.git
cd /etc/nginx/modsec/coreruleset
cp crs-setup.conf.example crs-setup.conf
cp rules/*.conf /etc/nginx/rules/ 2>/dev/null || true
cp rules/*.data /etc/nginx/rules/ 2>/dev/null || true

cat > /etc/nginx/modsec_includes.conf << 'EOF'
Include /etc/nginx/modsec/modsecurity.conf
Include /etc/nginx/modsec/coreruleset/crs-setup.conf
Include /etc/nginx/rules/*.conf
EOF

cat > /etc/nginx/modsec_api_relaxed.conf << 'MODECEOF'
${modsecRelaxed}
MODECEOF

# ── FAIL2BAN ───────────────────────────────────────────────
info "Configuring Fail2ban..."
cat > /etc/fail2ban/jail.local << JAILEOF
${fail2banJailTemplate}
JAILEOF

cat > /etc/fail2ban/filter.d/404-0.conf << 'F2B404EOF'
${fail2banFilters["404-0"]}
F2B404EOF

cat > /etc/fail2ban/filter.d/block22.conf << 'F2BBLOCK22EOF'
${fail2banFilters.block22}
F2BBLOCK22EOF

cat > /etc/fail2ban/filter.d/nginx-abuse.conf << 'F2BNGINXABUSEEOF'
${fail2banFilters["nginx-abuse"]}
F2BNGINXABUSEEOF

cat > /etc/fail2ban/filter.d/xtream.conf << 'F2BXTREAMEOF'
${fail2banFilters.xtream}
F2BXTREAMEOF

cat > /etc/fail2ban/filter.d/xtream-api.conf << 'F2BXTREAMAPIEOF'
${fail2banFilters["xtream-api"]}
F2BXTREAMAPIEOF

${fail2banDbSetup}

${geoIpSetup}

${optionalPackageSetup}

${asnBlockSetup}

${antiIptvSetup}

${crowdSecSetup}

# ── SYSCTL ─────────────────────────────────────────────────
info "Applying sysctl settings..."
cat > /etc/sysctl.d/99-proxyguardian.conf << 'EOF'
# Proxy hardening
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.log_martians = 1
net.ipv4.conf.default.log_martians = 1
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.default.secure_redirects = 0
net.ipv4.ip_forward = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
kernel.randomize_va_space = 1
fs.file-max = 65535
kernel.pid_max = 65536
net.ipv4.ip_local_port_range = 2000 65000
net.ipv4.tcp_rmem = 4096 87380 8388608
net.ipv4.tcp_wmem = 4096 87380 8388608
net.core.rmem_max = 8388608
net.core.wmem_max = 8388608
net.core.netdev_max_backlog = 5000
net.ipv4.tcp_window_scaling = 1
EOF
sysctl --system >/dev/null || warn "Alcuni sysctl non sono supportati da questo kernel"

# ── IPTABLES ───────────────────────────────────────────────
info "Applying iptables rules..."
iptables -C INPUT -p tcp --tcp-flags ALL NONE -j DROP 2>/dev/null || iptables -A INPUT -p tcp --tcp-flags ALL NONE -j DROP
iptables -C INPUT -p tcp ! --syn -m state --state NEW -j DROP 2>/dev/null || iptables -A INPUT -p tcp ! --syn -m state --state NEW -j DROP
iptables -C INPUT -p tcp --tcp-flags ALL ALL -j DROP 2>/dev/null || iptables -A INPUT -p tcp --tcp-flags ALL ALL -j DROP

# ── AVVIO SERVIZI ──────────────────────────────────────────
info "Enabling and starting services..."
systemctl daemon-reload

# Nginx valida l'upstream main.netbird.cloud:8880: NetBird deve essere gia connesso.
info "Installing / connecting NetBird before nginx validation..."
curl --retry 5 --retry-delay 3 --connect-timeout 20 -fsSL https://pkgs.netbird.io/install.sh | bash
systemctl enable netbird || true
if netbird status 2>/dev/null | grep -q "Management: Connected"; then
  ok "NetBird gia connesso"
else
  netbird up --setup-key "\$NETBIRD_SETUP_KEY"
fi
for _ in \$(seq 1 15); do
  if netbird status 2>/dev/null | grep -q "Management: Connected"; then
    break
  fi
  sleep 2
done
netbird status 2>/dev/null | grep -q "Management: Connected" || error "NetBird non connesso"
MAIN_BACKEND_IP=\$(netbird status -d 2>/dev/null | awk '/ main\.netbird\.cloud:/{found=1} found && /NetBird IP:/{print \$3; exit}')
if [ -n "\$MAIN_BACKEND_IP" ]; then
  sed -i '/[[:space:]]main\.netbird\.cloud$/d' /etc/hosts
  echo "\$MAIN_BACKEND_IP main.netbird.cloud" >> /etc/hosts
  ok "main.netbird.cloud risolto via NetBird: \$MAIN_BACKEND_IP"
else
  warn "Peer main.netbird.cloud non trovato nella network map NetBird"
fi

systemctl enable nginx
nginx -t && systemctl start nginx
systemctl enable fail2ban
systemctl restart fail2ban

ok "Nginx 1.26.2 + ModSecurity v3 + OWASP CRS v4 installati"
ok "Fail2ban configurato"
ok "GeoIP2 configurato"

# ── NETBIRD ────────────────────────────────────────────────
info "Installing / updating NetBird..."
if ! command -v netbird >/dev/null 2>&1; then
  curl --retry 5 --retry-delay 3 --connect-timeout 20 -fsSL https://pkgs.netbird.io/install.sh | bash
fi
systemctl enable netbird || true

mkdir -p /etc/systemd/system/netbird.service.d
cat > /usr/local/bin/netbird-ipset-cleanup.sh << 'EOF'
${DEPLOY_NETBIRD_IPSET_CLEANUP_SH}
EOF
chmod +x /usr/local/bin/netbird-ipset-cleanup.sh

cat > /etc/systemd/system/netbird-cleanup.service << 'EOF'
${DEPLOY_NETBIRD_CLEANUP_SERVICE}
EOF

cat > /etc/systemd/system/netbird.service.d/restart-nginx.conf << 'EOF'
${DEPLOY_NETBIRD_RESTART_NGINX_CONF}
EOF

systemctl daemon-reload
systemctl enable netbird-cleanup.service >/dev/null 2>&1 || true

if netbird status 2>/dev/null | grep -q "Management: Connected"; then
  ok "NetBird già connesso"
else
  info "Connecting NetBird..."
  netbird up --setup-key "\$NETBIRD_SETUP_KEY"
fi

systemctl restart netbird

for _ in \$(seq 1 15); do
  if netbird status 2>/dev/null | grep -q "Management: Connected"; then
    break
  fi
  sleep 2
done

netbird status 2>/dev/null | grep -q "Management: Connected" || error "NetBird non connesso"
NETBIRD_IP=\$(ip -4 addr show 2>/dev/null | awk '/inet 100\./ {print \$2; exit}' | cut -d/ -f1)
[ -n "\$NETBIRD_IP" ] || error "IP NetBird 100.x non rilevato"
ok "IP NetBird rilevato: \$NETBIRD_IP"
MAIN_BACKEND_IP=\$(netbird status -d 2>/dev/null | awk '/ main\.netbird\.cloud:/{found=1} found && /NetBird IP:/{print \$3; exit}')
if [ -n "\$MAIN_BACKEND_IP" ]; then
  sed -i '/[[:space:]]main\.netbird\.cloud$/d' /etc/hosts
  echo "\$MAIN_BACKEND_IP main.netbird.cloud" >> /etc/hosts
fi

# ═══════════════════════════════════════════════════════════
# INSTALLAZIONE AGENT
# ═══════════════════════════════════════════════════════════
echo ""
echo -e "\${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
echo -e "\${CYAN}   Installazione ProxyGuardian Agent...\${NC}"
echo -e "\${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"

AGENT_DIR="/opt/proxy-guardian-agent"
AGENT_PORT="3001"
AGENT_USER="pgagent"
SERVICE_NAME="proxy-guardian-agent"
AGENT_API_KEY=\$(openssl rand -hex 32)
AGENT_BIND="\$NETBIRD_IP"
HOSTNAME=\$(hostname -f 2>/dev/null || hostname)

if command -v ipset &>/dev/null && ipset list blocked_asn &>/dev/null 2>&1; then
  ipset flush blocked_asn
  ok "ipset blocked_asn svuotata"
fi

# Node.js 20+
if command -v node &>/dev/null; then
  NODE_MAJOR=\$(node -v | cut -dv -f2 | cut -d. -f1)
  if [ "\$NODE_MAJOR" -ge 20 ]; then
    ok "Node.js \$(node -v) già installato"
  else
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y nodejs >/dev/null 2>&1
  fi
else
  apt-get update -qq
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y nodejs >/dev/null 2>&1
fi

id "\$AGENT_USER" &>/dev/null || useradd -r -m -s /bin/bash "\$AGENT_USER"

cat > /etc/sudoers.d/proxy-guardian-agent << 'SUDOEOF'
${DEPLOY_AGENT_SUDOERS}
SUDOEOF
chmod 440 /etc/sudoers.d/proxy-guardian-agent

usermod -aG adm "\$AGENT_USER" 2>/dev/null || true
chmod 644 /var/log/nginx/*.log 2>/dev/null || true
chmod 644 /var/log/fail2ban.log 2>/dev/null || true
[ -d /etc/nginx ] && chmod o+r /etc/nginx/*.conf /etc/nginx/conf.d/*.conf 2>/dev/null || true
if [ -f /etc/nginx/nginx.conf ]; then
  chown root:"\$AGENT_USER" /etc/nginx/nginx.conf
  chmod 664 /etc/nginx/nginx.conf
fi
if [ -f /etc/asn-blocklist.txt ]; then
  chown root:"\$AGENT_USER" /etc/asn-blocklist.txt /etc/asn-whitelist-nets.txt 2>/dev/null || true
  chmod 664 /etc/asn-blocklist.txt /etc/asn-whitelist-nets.txt 2>/dev/null || true
fi
if [ -f /var/log/update-asn-block.log ]; then
  chown root:adm /var/log/update-asn-block.log 2>/dev/null || true
  chmod 640 /var/log/update-asn-block.log 2>/dev/null || true
fi

NGINX_USER=\$(grep -oP '^user\\s+\\K\\S+(?=;)' /etc/nginx/nginx.conf 2>/dev/null || echo "www-data")
mkdir -p /opt/log /var/cache/nginx/epg /var/cache/nginx/streaming
touch /opt/log/modsec_audit.log
chown "\${NGINX_USER}:\${AGENT_USER}" /opt/log/modsec_audit.log
chmod 664 /opt/log/modsec_audit.log
chown "\${NGINX_USER}:\${AGENT_USER}" /opt/log
chmod 775 /opt/log
chown -R "\${NGINX_USER}:\${NGINX_USER}" /var/cache/nginx/epg /var/cache/nginx/streaming

mkdir -p "\$AGENT_DIR"
info "Download agent bundle..."
curl -fsSL "\$AGENT_BUNDLE_URL" -o "\$AGENT_DIR/agent-bundle.js" || \\
  error "Impossibile scaricare agent-bundle.js"

cat > /usr/local/bin/asn-log-stats.py << 'ASNLOGSTATSEOF'
${agentAsnLogStats}
ASNLOGSTATSEOF
chmod 755 /usr/local/bin/asn-log-stats.py

chown -R "\$AGENT_USER:\$AGENT_USER" "\$AGENT_DIR"

cat > "\$AGENT_DIR/.env" << ENVEOF
AGENT_API_KEY=\$AGENT_API_KEY
AGENT_PORT=\$AGENT_PORT
AGENT_BIND=\$AGENT_BIND
HOSTNAME=\$HOSTNAME
ENVEOF
chmod 600 "\$AGENT_DIR/.env"
chown "\$AGENT_USER:\$AGENT_USER" "\$AGENT_DIR/.env"

cat > "\$AGENT_DIR/start.sh" << 'STARTEOF'
#!/bin/bash
set -a
source /opt/proxy-guardian-agent/.env
set +a
exec node /opt/proxy-guardian-agent/agent-bundle.js
STARTEOF
chmod +x "\$AGENT_DIR/start.sh"
chown "\$AGENT_USER:\$AGENT_USER" "\$AGENT_DIR/start.sh"

cat > "/etc/logrotate.d/proxyguardian" << 'LOGEOF'
${DEPLOY_LOGROTATE_CONF}
LOGEOF
chmod 644 /etc/logrotate.d/proxyguardian

cat > "/etc/systemd/system/\$SERVICE_NAME.service" << SVCEOF
[Unit]
Description=ProxyGuardian Agent
After=network.target

[Service]
Type=simple
User=\$AGENT_USER
WorkingDirectory=\$AGENT_DIR
ExecStart=\$AGENT_DIR/start.sh
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable "\$SERVICE_NAME" >/dev/null 2>&1
systemctl restart "\$SERVICE_NAME"
${installAsnBlock ? `systemctl enable ipset-restore whitelist-watcher >/dev/null 2>&1 || true
systemctl start ipset-restore >/dev/null 2>&1 || true
systemctl restart whitelist-watcher >/dev/null 2>&1 || true` : ""}
${installAntiIptv ? `systemctl enable anti-iptv >/dev/null 2>&1 || true
systemctl restart anti-iptv >/dev/null 2>&1 || true` : ""}
sleep 2

# ── Firewall: lockdown porta agente (solo dashboard NetBird) ──────────────────
DASHBOARD_NETBIRD_IP="100.116.132.180"
if command -v iptables &>/dev/null; then
  iptables -D INPUT -p tcp --dport "\$AGENT_PORT" -j DROP 2>/dev/null || true
  iptables -D INPUT -p tcp --dport "\$AGENT_PORT" -j DROP 2>/dev/null || true
  iptables -D INPUT -p tcp --dport "\$AGENT_PORT" -s "\$DASHBOARD_NETBIRD_IP" -j ACCEPT 2>/dev/null || true
  iptables -D INPUT -p tcp --dport "\$AGENT_PORT" -s "\$DASHBOARD_NETBIRD_IP" -j ACCEPT 2>/dev/null || true
  iptables -I INPUT 1 -p tcp --dport "\$AGENT_PORT" -j DROP
  iptables -I INPUT 1 -p tcp --dport "\$AGENT_PORT" -s "\$DASHBOARD_NETBIRD_IP" -j ACCEPT
  mkdir -p /etc/iptables
  iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
  ok "Firewall: porta \$AGENT_PORT accessibile solo da \$DASHBOARD_NETBIRD_IP"
fi

echo ""
echo -e "\${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
echo -e "\${GREEN}   DEPLOY COMPLETATO ✓\${NC}"
echo -e "\${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
echo ""
echo -e "  VPS:        \${CYAN}\$VPS_NAME\${NC}"
echo -e "  Host:       \${CYAN}\$NETBIRD_IP\${NC}"
echo -e "  Porta:      \${CYAN}\$AGENT_PORT\${NC}"
echo -e "  API Key:    \${YELLOW}\$AGENT_API_KEY\${NC}"
echo ""
echo -e "  \${YELLOW}⚠  SALVA L'API KEY ORA! Non verrà mostrata di nuovo.\${NC}"
echo ""
echo -e "  \${CYAN}Ora aggiungi questo VPS nella dashboard:\${NC}"
echo -e "    Vai su VPS → Aggiungi VPS"
echo -e "    Nome: \$VPS_NAME"
echo -e "    Host: \$NETBIRD_IP"
echo -e "    Porta: \$AGENT_PORT"
echo -e "    API Key: (quella sopra)"
echo ""
if systemctl is-active --quiet "\$SERVICE_NAME"; then
  ok "Agent attivo e funzionante"
else
  error "Agent non avviato. Controlla: journalctl -u \$SERVICE_NAME -n 50"
fi
`;

      res.json({
        script,
        config: {
          vpsName: name,
          backendIp: bIp,
          backendPort: bPort,
          proxyPort: pPort,
          installAsnBlock,
          installAntiIptv,
          installCrowdSec,
        },
        embeddedConfigs: {
          countryWhitelist: !!countryWhitelist && countryWhitelist.trim().length > 0,
          blockAsn: installAsnBlock,
          blockIsp: !!blockIsp && blockIsp.trim().length > 0,
          blockBadAgents: !!blockBadAgents && blockBadAgents.trim().length > 0,
          ipWhitelist: !!ipWhitelist && ipWhitelist.trim().length > 0,
          exclusionIp: !!exclusionIp && exclusionIp.trim().length > 0,
          antiIptv: installAntiIptv,
          crowdSec: installCrowdSec,
          modsecRelaxed: true,
          nginxOptimized: true,
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: "Errore generazione script: " + e.message });
    }
  });

  startHealthPoller(30000);
  startBanSyncPoller(60000);

  const server = createServer(app);
  attachSshWebSocket(server);
  return server;
}