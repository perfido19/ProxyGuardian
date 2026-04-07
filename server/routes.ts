import type { Express } from "express";
import { createServer, type Server } from "http";
import { totalmem, freemem, cpus } from "os";
import { execSync } from "child_process";
import { storage } from "./storage";
import { serviceActionSchema, unbanRequestSchema, updateConfigRequestSchema, updateJailRequestSchema, updateFilterRequestSchema } from "@shared/schema";
import { requireAuth, requireOperator, requireAdmin, validateCredentials, getAllUsers, getUserById, createUser, updateUser, deleteUser, getUserAllowedVps, requireVpsAccess, type UserRole } from "./auth";
import { getAllVps, getVpsById, createVps, updateVps, deleteVps, checkVpsHealth, checkAllVpsHealth, agentGet, agentPost, bulkGet, bulkPost, agentUpdate, bulkAgentUpdate, SLOW_REQUEST_TIMEOUT, SLOW_PATHS } from "./vps-manager";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import session from "express-session";
import { startUpgradeJob, subscribeToJob, getJobSnapshot, getJobLogs, getActiveJob } from "./fleet-upgrade";
import { generateSshToken, attachSshWebSocket } from "./ssh-console";

// Percorsi proxy che un operator può modificare (POST)
const OPERATOR_WRITE_PATHS = [
  /^\/api\/services\/[^/]+\/action$/,
  /^\/api\/unban$/,
  /^\/api\/unban-all$/,
];

function isOperatorAllowedPost(path: string): boolean {
  return OPERATOR_WRITE_PATHS.some(r => r.test(path));
}

export async function registerRoutes(app: Express): Promise<Server> {
  app.use(session({
    secret: process.env.SESSION_SECRET || "proxydashboard_dev_secret",
    resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 8 * 60 * 60 * 1000 },
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
    const healthMap = Object.fromEntries(await checkAllVpsHealth());
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
    try { res.json(await agentGet(vps, "/" + (req.params as any)[0])); }
    catch (e: any) { res.status(502).json({ error: e.message }); }
  });
  app.post("/api/vps/:id/proxy/*", requireAuth, requireOperator, async (req, res) => {
    if (!requireVpsAccess(req.params.id, req.session.userId!)) return res.status(403).json({ error: "Accesso negato" });
    const proxyPath = "/" + (req.params as any)[0];
    // Operator: solo servizi e ban/unban. Admin: tutto.
    if (req.session.userRole === "operator" && !isOperatorAllowedPost(proxyPath)) {
      return res.status(403).json({ error: "Permessi insufficienti: solo admin può modificare le configurazioni" });
    }
    const vps = getVpsById(req.params.id);
    if (!vps) return res.status(404).json({ error: "VPS non trovato" });
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

  // ── System config helpers for backup/restore ──

  const NGINX_CONF_FILES = [
    "country_whitelist.conf",
    "block_asn.conf",
    "block_isp.conf",
    "block_badagents.conf",
    "ip_whitelist.conf",
    "exclusion_ip.conf",
  ];

  const FAIL2BAN_CONF_FILES = [
    "jail.local",
    "fail2ban.local",
  ];

  function readSystemConfigs(): Record<string, Record<string, string>> {
    const nginxConfigs: Record<string, string> = {};
    for (const file of NGINX_CONF_FILES) {
      const path = `/etc/nginx/${file}`;
      try {
        if (existsSync(path)) nginxConfigs[file] = readFileSync(path, "utf-8");
      } catch {}
    }

    const fail2banConfigs: Record<string, string> = {};
    for (const file of FAIL2BAN_CONF_FILES) {
      const path = `/etc/fail2ban/${file}`;
      try {
        if (existsSync(path)) fail2banConfigs[file] = readFileSync(path, "utf-8");
      } catch {}
    }

    const asnBlockFiles: Record<string, string> = {};
    try {
      if (existsSync(FLEET_DIR)) {
        for (const file of ["blocked_asn.txt", "whitelisted_asn.txt"]) {
          const p = join(FLEET_DIR, file);
          if (existsSync(p)) asnBlockFiles[file] = readFileSync(p, "utf-8");
        }
      }
    } catch {}

    return { nginxConfigs, fail2banConfigs, asnBlockFiles };
  }

  // Block list (asn-blocklist.txt — AsnBlock format: "AS12345 # Description")
  app.get("/api/fleet/asn/blocklist", requireAuth, (_req, res) => {
    res.json({ content: readFleetFile("asn-blocklist.txt") });
  });

  app.post("/api/fleet/asn/blocklist", requireAuth, requireAdmin, async (req, res) => {
    const { content } = req.body;
    if (typeof content !== "string") return res.status(400).json({ error: "content required" });
    writeFleetFile("asn-blocklist.txt", content);
    // Push file to all VPS, then trigger update-asn-block.sh
    const syncResults = await bulkPost("all", "/api/config/asn-blocklist.txt", { content });
    const applyResults = await bulkPost("all", "/api/asn/update-set", {});
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
    const results = await bulkPost("all", "/api/asn/update-lists", {});
    res.json({ ok: true, results });
  });

  // ─── Backup / Restore ─────────────────────────────────────────────────────

  const DATA_DIR_PATH = join(process.cwd(), "data");
  const LOGROTATE_CONFIG_FILE = join(DATA_DIR_PATH, "logrotate-config.json");

  app.get("/api/admin/backup", requireAuth, requireAdmin, (_req, res) => {
    try {
      const readData = (file: string) => {
        const p = join(DATA_DIR_PATH, file);
        try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : []; } catch { return []; }
      };
      const systemConfigs = readSystemConfigs();
      const backup = {
        version: 2,
        timestamp: new Date().toISOString(),
        vps: readData("vps.json"),
        users: readData("users.json"),
        asnBlocklist: readFleetFile("asn-blocklist.txt"),
        asnWhitelist: readFleetFile("asn-whitelist.txt"),
        logrotateConfig: (() => {
          try {
            return existsSync(LOGROTATE_CONFIG_FILE) ? JSON.parse(readFileSync(LOGROTATE_CONFIG_FILE, "utf-8")) : null;
          } catch { return null; }
        })(),
        nginxConfigs: systemConfigs.nginxConfigs,
        fail2banConfigs: systemConfigs.fail2banConfigs,
        asnBlockFiles: systemConfigs.asnBlockFiles,
      };
      const filename = `pg-backup-${new Date().toISOString().slice(0, 10)}.json`;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.json(backup);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/admin/restore", requireAuth, requireAdmin, (req, res) => {
    try {
      const { version, vps, users, asnBlocklist, asnWhitelist, logrotateConfig, nginxConfigs, fail2banConfigs, asnBlockFiles } = req.body;
      if ((version !== 1 && version !== 2) || !Array.isArray(vps) || !Array.isArray(users)) {
        return res.status(400).json({ error: "File backup non valido o versione non supportata" });
      }
      if (!existsSync(DATA_DIR_PATH)) mkdirSync(DATA_DIR_PATH, { recursive: true });
      writeFileSync(join(DATA_DIR_PATH, "vps.json"), JSON.stringify(vps, null, 2), "utf-8");
      writeFileSync(join(DATA_DIR_PATH, "users.json"), JSON.stringify(users, null, 2), "utf-8");
      if (typeof asnBlocklist === "string") writeFleetFile("asn-blocklist.txt", asnBlocklist);
      if (typeof asnWhitelist === "string") writeFleetFile("asn-whitelist.txt", asnWhitelist);
      if (logrotateConfig && typeof logrotateConfig === "object") {
        writeFileSync(LOGROTATE_CONFIG_FILE, JSON.stringify(logrotateConfig, null, 2), "utf-8");
      }

      // Restore nginx configs
      if (nginxConfigs && typeof nginxConfigs === "object") {
        for (const [file, content] of Object.entries(nginxConfigs)) {
          try {
            writeFileSync(`/etc/nginx/${file}`, content as string, "utf-8");
          } catch (e: any) {
            console.error(`[Restore] Failed to write /etc/nginx/${file}:`, e.message);
          }
        }
      }

      // Restore fail2ban configs
      if (fail2banConfigs && typeof fail2banConfigs === "object") {
        for (const [file, content] of Object.entries(fail2banConfigs)) {
          try {
            writeFileSync(`/etc/fail2ban/${file}`, content as string, "utf-8");
          } catch (e: any) {
            console.error(`[Restore] Failed to write /etc/fail2ban/${file}:`, e.message);
          }
        }
      }

      // Restore ASN block files
      if (asnBlockFiles && typeof asnBlockFiles === "object") {
        if (!existsSync(FLEET_DIR)) mkdirSync(FLEET_DIR, { recursive: true });
        for (const [file, content] of Object.entries(asnBlockFiles)) {
          try {
            writeFileSync(join(FLEET_DIR, file), content as string, "utf-8");
          } catch (e: any) {
            console.error(`[Restore] Failed to write asn-block/${file}:`, e.message);
          }
        }
      }

      res.json({ ok: true, message: "Dati ripristinati. Il server si riavvierà tra 2 secondi." });
      // Riavvio per ricaricare vpsStore e usersStore in memoria
      setTimeout(() => process.exit(1), 2000);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Logrotate config
  app.get("/api/admin/logrotate-config", requireAuth, requireAdmin, (_req, res) => {
    try {
      if (existsSync(LOGROTATE_CONFIG_FILE)) {
        const data = JSON.parse(readFileSync(LOGROTATE_CONFIG_FILE, "utf-8"));
        res.json(data);
      } else {
        res.json(null);
      }
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/admin/logrotate-config", requireAuth, requireAdmin, (req, res) => {
    try {
      const config = req.body;
      if (!config || typeof config !== "object") {
        return res.status(400).json({ error: "Configurazione non valida" });
      }
      if (!existsSync(DATA_DIR_PATH)) mkdirSync(DATA_DIR_PATH, { recursive: true });
      writeFileSync(LOGROTATE_CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
      res.json({ ok: true });
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

  // IP info lookup (ASN, org) via ip-api.com con cache 24h
  const _ipInfoCache = new Map<string, { data: { asn: string; org: string; countryCode: string }; at: number }>();
  const IP_INFO_TTL = 24 * 60 * 60 * 1000;

  function parseIpApiItem(item: any): { asn: string; org: string; countryCode: string } {
    const asnFull: string = item.as || "";
    return {
      asn: asnFull.split(" ")[0] || "",
      org: item.org || asnFull.split(" ").slice(1).join(" ") || "",
      countryCode: item.countryCode || "",
    };
  }

  // Singolo IP (fallback, usato da IpCell se non c'è il batch)
  app.get("/api/ip-info/:ip", requireAuth, async (req, res) => {
    const { ip } = req.params;
    if (!/^[\d.a-fA-F:]+$/.test(ip)) return res.status(400).json({ error: "IP non valido" });
    const cached = _ipInfoCache.get(ip);
    if (cached && Date.now() - cached.at < IP_INFO_TTL) return res.json(cached.data);
    try {
      const r = await fetch(`http://ip-api.com/json/${ip}?fields=as,org,countryCode`);
      const d: any = await r.json();
      const info = parseIpApiItem(d);
      _ipInfoCache.set(ip, { data: info, at: Date.now() });
      res.json(info);
    } catch { res.status(502).json({ error: "Lookup fallito" }); }
  });

  // Batch IP (una sola richiesta per tabella intera)
  app.post("/api/ip-info/batch", requireAuth, async (req, res) => {
    const raw: string[] = Array.isArray(req.body?.ips) ? req.body.ips : [];
    const ips = [...new Set(raw.filter((ip: string) => typeof ip === "string" && /^[\d.a-fA-F:]+$/.test(ip)))];
    if (ips.length === 0) return res.json({});

    const result: Record<string, any> = {};
    const toFetch: string[] = [];

    for (const ip of ips) {
      const cached = _ipInfoCache.get(ip);
      if (cached && Date.now() - cached.at < IP_INFO_TTL) {
        result[ip] = cached.data;
      } else {
        toFetch.push(ip);
      }
    }

    // ip-api.com batch: max 100 IP per request
    for (let i = 0; i < toFetch.length; i += 100) {
      const chunk = toFetch.slice(i, i + 100);
      try {
        const r = await fetch("http://ip-api.com/batch?fields=query,as,org,countryCode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(chunk),
        });
        const items: any[] = await r.json();
        for (const item of items) {
          const info = parseIpApiItem(item);
          _ipInfoCache.set(item.query, { data: info, at: Date.now() });
          result[item.query] = info;
        }
      } catch { /* skip chunk, non bloccante */ }
    }

    res.json(result);
  });
  app.get("/api/logs/:logType", requireAuth, async (req, res) => {
    try { res.json(await storage.getLogs(req.params.logType, parseInt(req.query.lines as string) || 100)); }
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
      const r = updateJailRequestSchema.safeParse(req.body);
      if (!r.success) return res.status(400).json({ error: "Parametri non validi" });
      await storage.updateJail(req.params.name, r.data.config);
      res.json({ success: true });
    } catch { res.status(500).json({ error: "Errore" }); }
  });
  app.get("/api/fail2ban/filters", requireAuth, async (_req, res) => { try { res.json(await storage.getFilters()); } catch { res.status(500).json({ error: "Errore" }); } });
  app.get("/api/fail2ban/filters/:name", requireAuth, async (req, res) => {
    try { const f = await storage.getFilter(req.params.name); if (!f) return res.status(404).json({ error: "Non trovato" }); res.json(f); }
    catch { res.status(500).json({ error: "Errore" }); }
  });
  app.post("/api/fail2ban/filters/:name", requireAuth, requireAdmin, async (req, res) => {
    try {
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
    let modsecRelaxed: string;
    try {
      template = readFileSync(NGINX_TEMPLATE_PATH, "utf-8");
      modsecRelaxed = readFileSync(MODSEC_RELAXED_PATH, "utf-8");
    } catch (e: any) {
      return res.status(500).json({ error: "Template nginx o modsec non trovato sul server" });
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
        // Distribuisci config modsec relaxed per API
        await agentPost(vps, "/api/config/modsec_api_relaxed.conf", { content: modsecRelaxed });
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

  app.post("/api/deploy/generate-script", requireAuth, requireAdmin, (_req, res) => {
    try {
      const { backendIp, backendPort, proxyPort, vpsName } = _req.body;
      const bIp = backendIp || "main.netbird.cloud";
      const bPort = backendPort || 8880;
      const pPort = proxyPort || 8880;
      const name = vpsName || "nuovo-proxy";

      const nginxTemplate = readFileSync(NGINX_TEMPLATE_PATH, "utf-8");
      const nginxConf = nginxTemplate
        .replace(/__STREAM_CACHE_SIZE__/g, "5g")
        .replace(/main\.netbird\.cloud:8880/g, `${bIp}:${bPort}`)
        .replace(/listen 8880 reuseport/g, `listen ${pPort} reuseport`);

      const modsecRelaxed = readFileSync(MODSEC_RELAXED_PATH, "utf-8");

      const countryWhitelist = readFleetFile("country_whitelist.conf") || "";
      const blockAsn = readFleetFile("block_asn.conf") || "";
      const blockIsp = readFleetFile("block_isp.conf") || "";
      const blockBadAgents = readFleetFile("block_badagents.conf") || "";
      const ipWhitelist = readFleetFile("ip_whitelist.conf") || "";
      const exclusionIp = readFleetFile("exclusion_ip.conf") || "";

      const script = `#!/bin/bash
# ╔══════════════════════════════════════════════════════════╗
# ║  ProxyGuardian - Deploy Script                          ║
# ║  VPS: ${name.padEnd(47)}║
# ║  Generato: ${new Date().toISOString().slice(0, 19).padEnd(47)}║
# ╚══════════════════════════════════════════════════════════╝

set -e

RED='\\033[0;31m'; GREEN='\\033[0;32m'; YELLOW='\\033[1;33m'; CYAN='\\033[0;36m'; NC='\\033[0m'
info()  { echo -e "\${CYAN}[INFO]\${NC} \$*"; }
ok()    { echo -e "\${GREEN}[OK]\${NC}   \$*"; }
warn()  { echo -e "\${YELLOW}[WARN]\${NC} \$*"; }
error() { echo -e "\${RED}[ERR]\${NC}  \$*"; exit 1; }

BACKEND_IP="${bIp}"
BACKEND_PORT="${bPort}"
PROXY_PORT="${pPort}"
VPS_NAME="${name}"
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
  liblua5.1-0-dev wget curl

add-apt-repository -y ppa:maxmind/ppa
apt-get update -y
apt-get install -y libmaxminddb-dev libmaxminddb0 mmdb-bin geoipupdate

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
wget -q "http://nginx.org/download/nginx-1.26.2.tar.gz"
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
mkdir -p /var/lib/nginx/body

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
${blockAsn || "# Blacklist ASN"}
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
[nginx-req-limit]
enabled  = true
filter   = nginx-req-limit
action   = iptables-multiport[name=ReqLimit, port="\${PROXY_PORT}", protocol=tcp]
           banned_db[name=ReqLimit, port="\${PROXY_PORT}", protocol=tcp]
logpath  = /var/log/nginx/*error.log
findtime = 600
bantime  = 7200
maxretry = 10

[nginx-4xx]
enabled  = true
port     = http,https
action   = iptables-multiport[name=nginx-4xx, port="\${PROXY_PORT}", protocol=tcp]
           banned_db[name=ReqLimit, port="\${PROXY_PORT}", protocol=tcp]
logpath  = /var/log/nginx/access.log
findtime = 600
maxretry = 10
bantime  = 7200

[DEFAULT]
ignoreip = 127.0.0.1/8 10.0.0.0/8 192.168.0.0/16 172.16.0.0/16
JAILEOF

cat > /etc/fail2ban/filter.d/nginx-req-limit.conf << 'EOF'
[Definition]
failregex = limiting requests, excess:.* by zone.*client: <HOST>
ignoreregex =
EOF

cat > /etc/fail2ban/filter.d/nginx-4xx.conf << 'EOF'
[Definition]
failregex = ^<HOST>.*"(GET|POST).*" (404|444|403|400) .*$
ignoreregex =
EOF

# ── DATABASE FAIL2BAN ──────────────────────────────────────
info "Creating fail2ban database..."
mysql -uroot -e "CREATE DATABASE IF NOT EXISTS fail2ban;"
mysql -uroot -e "GRANT ALL ON fail2ban.* TO 'dynamo'@'%' IDENTIFIED BY 'dynamo@2018';"
mysql -uroot -e "GRANT ALL ON fail2ban.* TO 'dynamo'@'localhost' IDENTIFIED BY 'dynamo@2018';"
mysql -uroot -e "FLUSH PRIVILEGES;"

mkdir -p ~/tmp
cd ~/tmp
wget -q https://github.com/iredmail/iRedMail/raw/1.3/samples/fail2ban/sql/fail2ban.mysql
wget -q https://github.com/iredmail/iRedMail/raw/1.3/samples/fail2ban/action.d/banned_db.conf
wget -q https://github.com/iredmail/iRedMail/raw/1.3/samples/fail2ban/bin/fail2ban_banned_db
mysql fail2ban < ~/tmp/fail2ban.mysql

cat > /root/.my.cnf-fail2ban << 'MYCNFEOF'
[client]
host="127.0.0.1"
port="3306"
user="dynamo"
password="dynamo@2018"
MYCNFEOF

mv ~/tmp/banned_db.conf /etc/fail2ban/action.d/
mv ~/tmp/fail2ban_banned_db /usr/local/bin/
chmod 0550 /usr/local/bin/fail2ban_banned_db

# ── GEOIP2 ─────────────────────────────────────────────────
info "Configuring GeoIP2..."
cat > /etc/GeoIP.conf << GEOEOF
AccountID 768897
LicenseKey xJBgIatxy2Iw7V9h
EditionIDs GeoLite2-ASN GeoLite2-City GeoLite2-Country
GEOEOF

echo "0 1 * * *  /usr/bin/geoipupdate" >> /etc/crontab
geoipupdate

# ── SYSCTL ─────────────────────────────────────────────────
info "Applying sysctl settings..."
cat >> /etc/sysctl.conf << 'EOF'

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
sysctl -p

# ── IPTABLES ───────────────────────────────────────────────
info "Applying iptables rules..."
iptables -A INPUT -p tcp --tcp-flags ALL NONE -j DROP
iptables -A INPUT -p tcp ! --syn -m state --state NEW -j DROP
iptables -A INPUT -p tcp --tcp-flags ALL ALL -j DROP

# ── AVVIO SERVIZI ──────────────────────────────────────────
info "Enabling and starting services..."
systemctl daemon-reload
systemctl enable nginx
nginx -t && systemctl start nginx
systemctl enable fail2ban
systemctl restart fail2ban

ok "Nginx 1.26.2 + ModSecurity v3 + OWASP CRS v4 installati"
ok "Fail2ban configurato"
ok "GeoIP2 configurato"

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

NETBIRD_IP=\$(ip addr show 2>/dev/null | grep -oP '(?<=inet\\s)\\d+(\\.\\d+){3}' | grep -E '^100\\.' | head -1)
if [ -n "\$NETBIRD_IP" ]; then
  AGENT_BIND="\$NETBIRD_IP"
  ok "IP NetBird rilevato: \$NETBIRD_IP"
else
  AGENT_BIND="0.0.0.0"
  warn "NetBird non rilevato — agent su 0.0.0.0"
fi

PUBLIC_IP=\$(curl -sf --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print \$1}')
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
pgagent ALL=(ALL) NOPASSWD: /bin/systemctl status *
pgagent ALL=(ALL) NOPASSWD: /bin/systemctl start nginx
pgagent ALL=(ALL) NOPASSWD: /bin/systemctl stop nginx
pgagent ALL=(ALL) NOPASSWD: /bin/systemctl restart nginx
pgagent ALL=(ALL) NOPASSWD: /bin/systemctl reload nginx
pgagent ALL=(ALL) NOPASSWD: /bin/systemctl start fail2ban
pgagent ALL=(ALL) NOPASSWD: /bin/systemctl stop fail2ban
pgagent ALL=(ALL) NOPASSWD: /bin/systemctl restart fail2ban
pgagent ALL=(ALL) NOPASSWD: /bin/systemctl start mariadb
pgagent ALL=(ALL) NOPASSWD: /bin/systemctl stop mariadb
pgagent ALL=(ALL) NOPASSWD: /bin/systemctl restart mariadb
pgagent ALL=(ALL) NOPASSWD: /usr/bin/fail2ban-client *
pgagent ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t
pgagent ALL=(ALL) NOPASSWD: /usr/sbin/nginx
pgagent ALL=(ALL) NOPASSWD: /usr/sbin/ipset *
pgagent ALL=(ALL) NOPASSWD: /bin/systemctl start netbird
pgagent ALL=(ALL) NOPASSWD: /bin/systemctl stop netbird
pgagent ALL=(ALL) NOPASSWD: /bin/systemctl restart netbird
pgagent ALL=(ALL) NOPASSWD: /usr/sbin/iptables *
pgagent ALL=(ALL) NOPASSWD: /usr/sbin/iptables-save
pgagent ALL=(ALL) NOPASSWD: /usr/sbin/netfilter-persistent save
pgagent ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/iptables/rules.v4
pgagent ALL=(ALL) NOPASSWD: /usr/bin/netbird update
pgagent ALL=(ALL) NOPASSWD: /bin/systemctl restart proxy-guardian-agent
pgagent ALL=(ALL) NOPASSWD: /bin/systemctl stop proxy-guardian-agent
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

NGINX_USER=\$(grep -oP '^user\\s+\\K\\S+(?=;)' /etc/nginx/nginx.conf 2>/dev/null || echo "www-data")
mkdir -p /opt/log
touch /opt/log/modsec_audit.log
chown "\${NGINX_USER}:\${AGENT_USER}" /opt/log/modsec_audit.log
chmod 664 /opt/log/modsec_audit.log
chown "\${NGINX_USER}:\${AGENT_USER}" /opt/log
chmod 775 /opt/log

mkdir -p "\$AGENT_DIR"
info "Download agent bundle..."
curl -fsSL "https://raw.githubusercontent.com/perfido19/ProxyGuardian/main/agent/agent-bundle.js" -o "\$AGENT_DIR/index.js" || \\
  error "Impossibile scaricare agent-bundle.js"
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
exec node /opt/proxy-guardian-agent/index.js
STARTEOF
chmod +x "\$AGENT_DIR/start.sh"
chown "\$AGENT_USER:\$AGENT_USER" "\$AGENT_DIR/start.sh"

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
sleep 2

echo ""
echo -e "\${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
echo -e "\${GREEN}   DEPLOY COMPLETATO ✓\${NC}"
echo -e "\${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
echo ""
echo -e "  VPS:        \${CYAN}\$VPS_NAME\${NC}"
echo -e "  Host:       \${CYAN}\${NETBIRD_IP:-\$PUBLIC_IP}\${NC}"
echo -e "  Porta:      \${CYAN}\$AGENT_PORT\${NC}"
echo -e "  API Key:    \${YELLOW}\$AGENT_API_KEY\${NC}"
echo ""
echo -e "  \${YELLOW}⚠  SALVA L'API KEY ORA! Non verrà mostrata di nuovo.\${NC}"
echo ""
echo -e "  \${CYAN}Ora aggiungi questo VPS nella dashboard:\${NC}"
echo -e "    Vai su VPS → Aggiungi VPS"
echo -e "    Nome: \$VPS_NAME"
echo -e "    Host: \${NETBIRD_IP:-\$PUBLIC_IP}"
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
        },
        embeddedConfigs: {
          countryWhitelist: !!countryWhitelist && countryWhitelist.trim().length > 0,
          blockAsn: !!blockAsn && blockAsn.trim().length > 0,
          blockIsp: !!blockIsp && blockIsp.trim().length > 0,
          blockBadAgents: !!blockBadAgents && blockBadAgents.trim().length > 0,
          ipWhitelist: !!ipWhitelist && ipWhitelist.trim().length > 0,
          exclusionIp: !!exclusionIp && exclusionIp.trim().length > 0,
          modsecRelaxed: true,
          nginxOptimized: true,
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: "Errore generazione script: " + e.message });
    }
  });

  const server = createServer(app);
  attachSshWebSocket(server);
  return server;
}
