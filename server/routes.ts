import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import {
  serviceActionSchema,
  unbanRequestSchema,
  updateConfigRequestSchema,
  updateJailRequestSchema,
  updateFilterRequestSchema,
} from "@shared/schema";
import {
  requireAuth,
  requireOperator,
  requireAdmin,
  validateCredentials,
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  type UserRole,
} from "./auth";
import session from "express-session";

export async function registerRoutes(app: Express): Promise<Server> {

  // ─── Session setup ───────────────────────────────────────────────────────────
  app.use(
    session({
      secret: process.env.SESSION_SECRET || "proxydashboard_dev_secret_change_in_prod",
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        maxAge: 8 * 60 * 60 * 1000, // 8 ore
      },
    })
  );

  // ─── Auth routes (pubbliche) ─────────────────────────────────────────────────

  app.post("/api/auth/login", (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Username e password richiesti" });
    }

    const user = validateCredentials(username, password);
    if (!user) {
      return res.status(401).json({ error: "Credenziali non valide" });
    }

    req.session.userId = user.id;
    req.session.userRole = user.role;

    res.json({ user });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      res.json({ success: true });
    });
  });

  app.get("/api/auth/me", requireAuth, (req, res) => {
    const user = getUserById(req.session.userId!);
    if (!user) return res.status(401).json({ error: "Utente non trovato" });
    res.json({ user });
  });

  // ─── User management (solo admin) ────────────────────────────────────────────

  app.get("/api/users", requireAuth, requireAdmin, (req, res) => {
    res.json(getAllUsers());
  });

  app.post("/api/users", requireAuth, requireAdmin, (req, res) => {
    try {
      const { username, password, role } = req.body;
      if (!username || !password || !role) {
        return res.status(400).json({ error: "Parametri mancanti" });
      }
      const validRoles: UserRole[] = ["admin", "operator", "viewer"];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ error: "Ruolo non valido" });
      }
      const user = createUser(username, password, role);
      res.status(201).json(user);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.put("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
    try {
      const { id } = req.params;
      const { password, role, enabled } = req.body;
      const user = updateUser(id, { password, role, enabled });
      res.json(user);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
    try {
      deleteUser(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // ─── Services ────────────────────────────────────────────────────────────────

  app.get("/api/services", requireAuth, async (req, res) => {
    try {
      const services = await storage.getServices();
      res.json(services);
    } catch (error) {
      console.error("Error getting services:", error);
      res.status(500).json({ error: "Errore nel recupero dello stato dei servizi" });
    }
  });

  app.post("/api/services/action", requireAuth, requireOperator, async (req, res) => {
    try {
      const result = serviceActionSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: "Parametri non validi" });
      }
      const { service, action } = result.data;
      await storage.serviceAction(service, action);
      await new Promise(resolve => setTimeout(resolve, 1000));
      const updatedService = await storage.getServiceStatus(service);
      res.json(updatedService);
    } catch (error) {
      console.error("Error executing service action:", error);
      res.status(500).json({ error: "Errore nell'esecuzione dell'azione" });
    }
  });

  // ─── Banned IPs ──────────────────────────────────────────────────────────────

  app.get("/api/banned-ips", requireAuth, async (req, res) => {
    try {
      const bannedIps = await storage.getBannedIps();
      res.json(bannedIps);
    } catch (error) {
      res.status(500).json({ error: "Errore nel recupero degli IP bannati" });
    }
  });

  app.post("/api/unban", requireAuth, requireOperator, async (req, res) => {
    try {
      const result = unbanRequestSchema.safeParse(req.body);
      if (!result.success) return res.status(400).json({ error: "Parametri non validi" });
      const { ip, jail } = result.data;
      await storage.unbanIp(ip, jail);
      res.json({ success: true, message: `IP ${ip} sbloccato dalla jail ${jail}` });
    } catch (error) {
      res.status(500).json({ error: "Errore nello sblocco dell'IP" });
    }
  });

  app.post("/api/unban-all", requireAuth, requireOperator, async (req, res) => {
    try {
      const result = await storage.unbanAll();
      res.json({
        success: true,
        message: `Sbloccati ${result.unbannedCount} IP da ${result.jailsProcessed} jail`,
        ...result,
      });
    } catch (error) {
      res.status(500).json({ error: "Errore nello sblocco di tutti gli IP" });
    }
  });

  // ─── Stats ───────────────────────────────────────────────────────────────────

  app.get("/api/stats", requireAuth, async (req, res) => {
    try {
      const stats = await storage.getStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: "Errore nel recupero delle statistiche" });
    }
  });

  // ─── Logs ────────────────────────────────────────────────────────────────────

  app.get("/api/logs/:logType", requireAuth, async (req, res) => {
    try {
      const { logType } = req.params;
      const lines = parseInt(req.query.lines as string) || 100;
      const logs = await storage.getLogs(logType, lines);
      res.json(logs);
    } catch (error) {
      res.status(500).json({ error: "Errore nel recupero dei log" });
    }
  });

  // ─── Config files ─────────────────────────────────────────────────────────────

  app.get("/api/config/:filename", requireAuth, async (req, res) => {
    try {
      const config = await storage.getConfigFile(req.params.filename);
      if (!config) return res.status(404).json({ error: "File non trovato" });
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: "Errore nel recupero del file di configurazione" });
    }
  });

  app.post("/api/config/update", requireAuth, requireOperator, async (req, res) => {
    try {
      const result = updateConfigRequestSchema.safeParse(req.body);
      if (!result.success) return res.status(400).json({ error: "Parametri non validi" });
      const { filename, content } = result.data;
      await storage.updateConfigFile(filename, content);
      res.json({ success: true, message: "Configurazione aggiornata con successo" });
    } catch (error) {
      res.status(500).json({ error: "Errore nell'aggiornamento della configurazione" });
    }
  });

  // ─── Fail2ban Jails ───────────────────────────────────────────────────────────

  app.get("/api/fail2ban/jails", requireAuth, async (req, res) => {
    try {
      res.json(await storage.getJails());
    } catch (error) {
      res.status(500).json({ error: "Errore nel recupero delle jail" });
    }
  });

  app.post("/api/fail2ban/jails/:name", requireAuth, requireOperator, async (req, res) => {
    try {
      const { name } = req.params;
      const result = updateJailRequestSchema.safeParse(req.body);
      if (!result.success) return res.status(400).json({ error: "Parametri non validi" });
      await storage.updateJail(name, result.data.config);
      res.json({ success: true, message: `Jail ${name} aggiornata con successo` });
    } catch (error) {
      res.status(500).json({ error: "Errore nell'aggiornamento della jail" });
    }
  });

  // ─── Fail2ban Filters ─────────────────────────────────────────────────────────

  app.get("/api/fail2ban/filters", requireAuth, async (req, res) => {
    try {
      res.json(await storage.getFilters());
    } catch (error) {
      res.status(500).json({ error: "Errore nel recupero dei filtri" });
    }
  });

  app.get("/api/fail2ban/filters/:name", requireAuth, async (req, res) => {
    try {
      const filter = await storage.getFilter(req.params.name);
      if (!filter) return res.status(404).json({ error: "Filtro non trovato" });
      res.json(filter);
    } catch (error) {
      res.status(500).json({ error: "Errore nel recupero del filtro" });
    }
  });

  app.post("/api/fail2ban/filters/:name", requireAuth, requireOperator, async (req, res) => {
    try {
      const { name } = req.params;
      const result = updateFilterRequestSchema.safeParse(req.body);
      if (!result.success) return res.status(400).json({ error: "Parametri non validi" });
      const { failregex, ignoreregex } = result.data;
      await storage.updateFilter(name, failregex, ignoreregex);
      res.json({ success: true, message: `Filtro ${name} aggiornato con successo` });
    } catch (error) {
      res.status(500).json({ error: "Errore nell'aggiornamento del filtro" });
    }
  });

  // ─── Fail2ban Config ──────────────────────────────────────────────────────────

  app.get("/api/fail2ban/config/:type", requireAuth, async (req, res) => {
    try {
      const { type } = req.params;
      if (type !== "jail.local" && type !== "fail2ban.local") {
        return res.status(400).json({ error: "Tipo non valido" });
      }
      res.json(await storage.getFail2banConfig(type));
    } catch (error) {
      res.status(500).json({ error: "Errore nel recupero della configurazione fail2ban" });
    }
  });

  app.post("/api/fail2ban/config/:type", requireAuth, requireOperator, async (req, res) => {
    try {
      const { type } = req.params;
      if (type !== "jail.local" && type !== "fail2ban.local") {
        return res.status(400).json({ error: "Tipo non valido" });
      }
      const { content } = req.body;
      if (typeof content !== "string") return res.status(400).json({ error: "Contenuto non valido" });
      await storage.updateFail2banConfig(type, content);
      res.json({ success: true, message: `${type} aggiornato con successo` });
    } catch (error) {
      res.status(500).json({ error: "Errore nell'aggiornamento della configurazione fail2ban" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
