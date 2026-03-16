import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { serviceActionSchema, unbanRequestSchema, updateConfigRequestSchema, updateJailRequestSchema, updateFilterRequestSchema } from "@shared/schema";

export async function registerRoutes(app: Express): Promise<Server> {
  // Get all services status
  app.get("/api/services", async (req, res) => {
    try {
      const services = await storage.getServices();
      res.json(services);
    } catch (error) {
      console.error("Error getting services:", error);
      res.status(500).json({ error: "Errore nel recupero dello stato dei servizi" });
    }
  });

  // Service actions (start, stop, restart, reload)
  app.post("/api/services/action", async (req, res) => {
    try {
      const result = serviceActionSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: "Parametri non validi" });
      }

      const { service, action } = result.data;
      await storage.serviceAction(service, action);
      
      // Wait a moment for the service to change state
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const updatedService = await storage.getServiceStatus(service);
      res.json(updatedService);
    } catch (error) {
      console.error("Error executing service action:", error);
      res.status(500).json({ error: "Errore nell'esecuzione dell'azione" });
    }
  });

  // Get banned IPs
  app.get("/api/banned-ips", async (req, res) => {
    try {
      const bannedIps = await storage.getBannedIps();
      res.json(bannedIps);
    } catch (error) {
      console.error("Error getting banned IPs:", error);
      res.status(500).json({ error: "Errore nel recupero degli IP bannati" });
    }
  });

  // Unban IP
  app.post("/api/unban", async (req, res) => {
    try {
      const result = unbanRequestSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: "Parametri non validi" });
      }

      const { ip, jail } = result.data;
      await storage.unbanIp(ip, jail);
      res.json({ success: true, message: `IP ${ip} sbloccato dalla jail ${jail}` });
    } catch (error) {
      console.error("Error unbanning IP:", error);
      res.status(500).json({ error: "Errore nello sblocco dell'IP" });
    }
  });

  // Unban all IPs
  app.post("/api/unban-all", async (req, res) => {
    try {
      const result = await storage.unbanAll();
      res.json({ 
        success: true, 
        message: `Sbloccati ${result.unbannedCount} IP da ${result.jailsProcessed} jail`,
        unbannedCount: result.unbannedCount,
        jailsProcessed: result.jailsProcessed
      });
    } catch (error) {
      console.error("Error unbanning all IPs:", error);
      res.status(500).json({ error: "Errore nello sblocco di tutti gli IP" });
    }
  });

  // Get statistics
  app.get("/api/stats", async (req, res) => {
    try {
      const stats = await storage.getStats();
      res.json(stats);
    } catch (error) {
      console.error("Error getting stats:", error);
      res.status(500).json({ error: "Errore nel recupero delle statistiche" });
    }
  });

  // Get logs
  app.get("/api/logs/:logType", async (req, res) => {
    try {
      const { logType } = req.params;
      const lines = parseInt(req.query.lines as string) || 100;
      
      const logs = await storage.getLogs(logType, lines);
      res.json(logs);
    } catch (error) {
      console.error("Error getting logs:", error);
      res.status(500).json({ error: "Errore nel recupero dei log" });
    }
  });

  // Get config file
  app.get("/api/config/:filename", async (req, res) => {
    try {
      const { filename } = req.params;
      const config = await storage.getConfigFile(filename);
      
      if (!config) {
        return res.status(404).json({ error: "File di configurazione non trovato" });
      }
      
      res.json(config);
    } catch (error) {
      console.error("Error getting config file:", error);
      res.status(500).json({ error: "Errore nel recupero del file di configurazione" });
    }
  });

  // Update config file
  app.post("/api/config/update", async (req, res) => {
    try {
      const result = updateConfigRequestSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: "Parametri non validi" });
      }

      const { filename, content } = result.data;
      await storage.updateConfigFile(filename, content);
      res.json({ success: true, message: "Configurazione aggiornata con successo" });
    } catch (error) {
      console.error("Error updating config file:", error);
      res.status(500).json({ error: "Errore nell'aggiornamento della configurazione" });
    }
  });

  // Fail2ban Jail Management
  
  // Get all jails
  app.get("/api/fail2ban/jails", async (req, res) => {
    try {
      const jails = await storage.getJails();
      res.json(jails);
    } catch (error) {
      console.error("Error getting jails:", error);
      res.status(500).json({ error: "Errore nel recupero delle jail" });
    }
  });

  // Update jail configuration
  app.post("/api/fail2ban/jails/:name", async (req, res) => {
    try {
      const { name } = req.params;
      const result = updateJailRequestSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: "Parametri non validi" });
      }

      await storage.updateJail(name, result.data.config);
      res.json({ success: true, message: `Jail ${name} aggiornata con successo` });
    } catch (error) {
      console.error("Error updating jail:", error);
      res.status(500).json({ error: "Errore nell'aggiornamento della jail" });
    }
  });

  // Get all filters
  app.get("/api/fail2ban/filters", async (req, res) => {
    try {
      const filters = await storage.getFilters();
      res.json(filters);
    } catch (error) {
      console.error("Error getting filters:", error);
      res.status(500).json({ error: "Errore nel recupero dei filtri" });
    }
  });

  // Get single filter
  app.get("/api/fail2ban/filters/:name", async (req, res) => {
    try {
      const { name } = req.params;
      const filter = await storage.getFilter(name);
      
      if (!filter) {
        return res.status(404).json({ error: "Filtro non trovato" });
      }
      
      res.json(filter);
    } catch (error) {
      console.error("Error getting filter:", error);
      res.status(500).json({ error: "Errore nel recupero del filtro" });
    }
  });

  // Update filter
  app.post("/api/fail2ban/filters/:name", async (req, res) => {
    try {
      const { name } = req.params;
      const result = updateFilterRequestSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: "Parametri non validi" });
      }

      const { failregex, ignoreregex } = result.data;
      await storage.updateFilter(name, failregex, ignoreregex);
      res.json({ success: true, message: `Filtro ${name} aggiornato con successo` });
    } catch (error) {
      console.error("Error updating filter:", error);
      res.status(500).json({ error: "Errore nell'aggiornamento del filtro" });
    }
  });

  // Get fail2ban config file (jail.local or fail2ban.local)
  app.get("/api/fail2ban/config/:type", async (req, res) => {
    try {
      const { type } = req.params;
      if (type !== 'jail.local' && type !== 'fail2ban.local') {
        return res.status(400).json({ error: "Tipo di configurazione non valido" });
      }

      const config = await storage.getFail2banConfig(type as 'jail.local' | 'fail2ban.local');
      res.json(config);
    } catch (error) {
      console.error("Error getting fail2ban config:", error);
      res.status(500).json({ error: "Errore nel recupero della configurazione fail2ban" });
    }
  });

  // Update fail2ban config file
  app.post("/api/fail2ban/config/:type", async (req, res) => {
    try {
      const { type } = req.params;
      if (type !== 'jail.local' && type !== 'fail2ban.local') {
        return res.status(400).json({ error: "Tipo di configurazione non valido" });
      }

      const { content } = req.body;
      if (typeof content !== 'string') {
        return res.status(400).json({ error: "Contenuto non valido" });
      }

      await storage.updateFail2banConfig(type as 'jail.local' | 'fail2ban.local', content);
      res.json({ success: true, message: `${type} aggiornato con successo` });
    } catch (error) {
      console.error("Error updating fail2ban config:", error);
      res.status(500).json({ error: "Errore nell'aggiornamento della configurazione fail2ban" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
