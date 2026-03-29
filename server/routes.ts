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
    cookie: { httpOnly: true, secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 },
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
    let completed = 0;
    const total = targets.length;

    res.write(`event: total\ndata: ${JSON.stringify({ total })}\n\n`);

    await Promise.allSettled(targets.map(async (safe) => {
      const vps = getVpsById(safe.id);
      if (!vps) return;
      try {
        const data = await agentGet(vps, "/api/banned-ips", 5000);
        res.write(`event: result\ndata: ${JSON.stringify({ vpsId: vps.id, vpsName: vps.name, success: true, data })}\n\n`);
      } catch (e: any) {
        res.write(`event: result\ndata: ${JSON.stringify({ vpsId: vps.id, vpsName: vps.name, success: false, error: e.message })}\n\n`);
      }
      completed++;
      if (completed === total) {
        res.write(`event: done\ndata: {}\n\n`);
        res.end();
      }
    }));
  });

  // ─── Fleet Upgrade ────────────────────────────────────────────────────────────

  // Job attivo più recente (per riconnettersi dopo navigazione)
  app.get("/api/fleet/upgrade/active", requireAuth, (_req, res) => {
    const active = getActiveJob();
    if (!active) return res.status(404).json({ error: "Nessun job attivo" });
    res.json(active);
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

  const server = createServer(app);
  attachSshWebSocket(server);
  return server;
}
