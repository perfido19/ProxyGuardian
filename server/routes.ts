import type { Express } from "express";
import { createServer, type Server } from "http";
import { totalmem, freemem, cpus } from "os";
import { execSync } from "child_process";
import { storage } from "./storage";
import { serviceActionSchema, unbanRequestSchema, updateConfigRequestSchema, updateJailRequestSchema, updateFilterRequestSchema } from "@shared/schema";
import { requireAuth, requireOperator, requireAdmin, validateCredentials, getAllUsers, getUserById, createUser, updateUser, deleteUser, type UserRole } from "./auth";
import { getAllVps, getVpsById, createVps, updateVps, deleteVps, checkVpsHealth, checkAllVpsHealth, agentGet, agentPost, bulkGet, bulkPost } from "./vps-manager";
import session from "express-session";

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
    try { res.status(201).json(createUser(req.body.username, req.body.password, req.body.role as UserRole)); }
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
  app.get("/api/vps", requireAuth, (_req, res) => res.json(getAllVps()));
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
  app.get("/api/vps/health/all", requireAuth, async (_req, res) => {
    res.json(Object.fromEntries(await checkAllVpsHealth()));
  });
  app.get("/api/vps/:id/health", requireAuth, async (req, res) => {
    const vps = getVpsById(req.params.id);
    if (!vps) return res.status(404).json({ error: "VPS non trovato" });
    const online = await checkVpsHealth(vps);
    res.json({ online, lastSeen: vps.lastSeen });
  });

  // Proxy singolo VPS
  app.get("/api/vps/:id/proxy/*", requireAuth, async (req, res) => {
    const vps = getVpsById(req.params.id);
    if (!vps) return res.status(404).json({ error: "VPS non trovato" });
    try { res.json(await agentGet(vps, "/" + (req.params as any)[0])); }
    catch (e: any) { res.status(502).json({ error: e.message }); }
  });
  app.post("/api/vps/:id/proxy/*", requireAuth, requireOperator, async (req, res) => {
    const vps = getVpsById(req.params.id);
    if (!vps) return res.status(404).json({ error: "VPS non trovato" });
    try { res.json(await agentPost(vps, "/" + (req.params as any)[0], req.body)); }
    catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  // Bulk
  app.post("/api/vps/bulk/get", requireAuth, async (req, res) => {
    const { vpsIds, path } = req.body;
    if (!vpsIds || !path) return res.status(400).json({ error: "vpsIds e path richiesti" });
    res.json(await bulkGet(vpsIds, path));
  });
  app.post("/api/vps/bulk/post", requireAuth, requireOperator, async (req, res) => {
    const { vpsIds, path, body } = req.body;
    if (!vpsIds || !path) return res.status(400).json({ error: "vpsIds e path richiesti" });
    res.json(await bulkPost(vpsIds, path, body || {}));
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
  app.post("/api/config/update", requireAuth, requireOperator, async (req, res) => {
    try {
      const r = updateConfigRequestSchema.safeParse(req.body);
      if (!r.success) return res.status(400).json({ error: "Parametri non validi" });
      await storage.updateConfigFile(r.data.filename, r.data.content);
      res.json({ success: true, message: "Configurazione aggiornata" });
    } catch { res.status(500).json({ error: "Errore" }); }
  });
  app.get("/api/fail2ban/jails", requireAuth, async (_req, res) => { try { res.json(await storage.getJails()); } catch { res.status(500).json({ error: "Errore" }); } });
  app.post("/api/fail2ban/jails/:name", requireAuth, requireOperator, async (req, res) => {
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
  app.post("/api/fail2ban/filters/:name", requireAuth, requireOperator, async (req, res) => {
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
  app.post("/api/fail2ban/config/:type", requireAuth, requireOperator, async (req, res) => {
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
