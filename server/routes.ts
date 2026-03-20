import type { Express } from "express";
import { createServer, type Server } from "http";
import { totalmem, freemem, cpus } from "os";
import { execSync } from "child_process";
import { storage } from "./storage";
import { serviceActionSchema, unbanRequestSchema, updateConfigRequestSchema, updateJailRequestSchema, updateFilterRequestSchema } from "@shared/schema";
import { requireAuth, requireOperator, requireAdmin, validateCredentials, getAllUsers, getUserById, createUser, updateUser, deleteUser, getUserAllowedVps, requireVpsAccess, type UserRole } from "./auth";
import { getAllVps, getVpsById, createVps, updateVps, deleteVps, checkVpsHealth, checkAllVpsHealth, agentGet, agentPost, bulkGet, bulkPost, agentUpdate, bulkAgentUpdate } from "./vps-manager";
import { readFileSync } from "fs";
import { join } from "path";
import session from "express-session";

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

  // Agent update singolo VPS
  app.post("/api/vps/:id/agent/update", requireAuth, requireAdmin, async (req, res) => {
    const vps = getVpsById(req.params.id);
    if (!vps) return res.status(404).json({ error: "VPS non trovato" });
    try {
      const bundle = Buffer.from(readFileSync(join(process.cwd(), "agent", "agent-bundle.js")));
      res.json(await agentUpdate(vps, bundle));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Agent update bulk
  app.post("/api/vps/bulk/agent/update", requireAuth, requireAdmin, async (_req, res) => {
    try { res.json(await bulkAgentUpdate("all")); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
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
    try { res.json(await agentPost(vps, proxyPath, req.body)); }
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

  return createServer(app);
}
