import express, { Request, Response, NextFunction } from "express";
import { exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile } from "fs/promises";
import os from "os";

const execAsync = promisify(exec);
const app = express();
app.use(express.json());

const API_KEY = process.env.AGENT_API_KEY;
if (!API_KEY) { console.error("[Agent] AGENT_API_KEY non impostata. Uscita."); process.exit(1); }

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (req.headers["x-api-key"] !== API_KEY) { res.status(401).json({ error: "API key non valida" }); return; }
  next();
}
app.use(requireApiKey);

const PORT = parseInt(process.env.AGENT_PORT || "3001", 10);
const BIND = process.env.AGENT_BIND || "0.0.0.0";

app.get("/health", (_req, res) => {
  res.json({ status: "ok", hostname: os.hostname(), uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.get("/api/services", async (_req, res) => {
  const names = ["nginx", "fail2ban", "mariadb"];
  const services = await Promise.all(names.map(async name => {
    try {
      const { stdout } = await execAsync(`systemctl status ${name}`, { timeout: 5000 });
      const isActive = stdout.includes("Active: active (running)");
      const isFailed = stdout.includes("Active: failed");
      const pidMatch = stdout.match(/Main PID: (\d+)/);
      const uptimeMatch = stdout.match(/Active: active \(running\) since ([^;]+);/);
      return { name, status: isActive ? "running" : isFailed ? "error" : "stopped", pid: pidMatch ? parseInt(pidMatch[1]) : undefined, uptime: uptimeMatch?.[1]?.trim() };
    } catch { return { name, status: "stopped" }; }
  }));
  res.json(services);
});

app.post("/api/services/action", async (req, res) => {
  const { service, action } = req.body;
  const valid = ["start", "stop", "restart", "reload"];
  if (!valid.includes(action)) return res.status(400).json({ error: "Azione non valida" });
  if (action === "reload" && service !== "nginx") return res.status(400).json({ error: "Reload solo per nginx" });
  try {
    await execAsync(`systemctl ${action} ${service}`, { timeout: 10000 });
    await new Promise(r => setTimeout(r, 1000));
    const { stdout } = await execAsync(`systemctl status ${service}`, { timeout: 5000 });
    res.json({ success: true, name: service, status: stdout.includes("Active: active (running)") ? "running" : "stopped" });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get("/api/banned-ips", async (_req, res) => {
  try {
    const { stdout } = await execAsync("fail2ban-client status", { timeout: 5000 });
    const match = stdout.match(/Jail list:\s*(.+)/);
    if (!match) return res.json([]);
    const jails = match[1].split(",").map(j => j.trim()).filter(Boolean);
    const bannedIps: any[] = [];
    for (const jail of jails) {
      try {
        const { stdout: js } = await execAsync(`fail2ban-client status ${jail}`, { timeout: 5000 });
        const ipMatch = js.match(/Banned IP list:\s*(.+)/);
        if (ipMatch) {
          for (const ip of ipMatch[1].trim().split(/\s+/).filter(Boolean)) {
            bannedIps.push({ ip, jail, banTime: new Date().toLocaleString("it-IT"), timeLeft: "N/A" });
          }
        }
      } catch {}
    }
    res.json(bannedIps);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/api/unban", async (req, res) => {
  try { await execAsync(`fail2ban-client set ${req.body.jail} unbanip ${req.body.ip}`, { timeout: 5000 }); res.json({ success: true }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/api/unban-all", async (_req, res) => {
  try {
    const { stdout } = await execAsync("fail2ban-client status", { timeout: 5000 });
    const match = stdout.match(/Jail list:\s*(.+)/);
    if (!match) return res.json({ unbannedCount: 0, jailsProcessed: 0 });
    const jails = match[1].split(",").map(j => j.trim()).filter(Boolean);
    let unbannedCount = 0;
    for (const jail of jails) {
      try {
        const { stdout: js } = await execAsync(`fail2ban-client status ${jail}`, { timeout: 5000 });
        const ipMatch = js.match(/Banned IP list:\s*(.+)/);
        if (ipMatch) {
          for (const ip of ipMatch[1].trim().split(/\s+/).filter(Boolean)) {
            try { await execAsync(`fail2ban-client set ${jail} unbanip ${ip}`, { timeout: 3000 }); unbannedCount++; } catch {}
          }
        }
      } catch {}
    }
    res.json({ success: true, unbannedCount, jailsProcessed: jails.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get("/api/stats", async (_req, res) => {
  try {
    let activeConnections = 0;
    try { const { stdout } = await execAsync("curl -s http://localhost/nginx_status 2>/dev/null || echo ''", { timeout: 3000 }); const m = stdout.match(/Active connections:\s*(\d+)/); if (m) activeConnections = parseInt(m[1]); } catch {}
    res.json({ totalBans24h: 0, activeConnections, blockedCountries: 0, totalRequests24h: 0, topBannedIps: [], bansByCountry: [], banTimeline: [] });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

const logPaths: Record<string, string> = {
  "nginx-access": "/var/log/nginx/access.log", "nginx-error": "/var/log/nginx/error.log",
  "fail2ban": "/var/log/fail2ban.log", "modsec": "/opt/log/modsec_audit.log",
};

app.get("/api/logs/:logType", async (req, res) => {
  const logPath = logPaths[req.params.logType];
  if (!logPath) return res.status(400).json({ error: "Tipo log non valido" });
  try {
    const { stdout } = await execAsync(`tail -n ${parseInt(req.query.lines as string) || 100} ${logPath}`, { timeout: 5000 });
    res.json(stdout.split("\n").filter(Boolean).map((message, line) => ({ timestamp: new Date().toLocaleString("it-IT"), message, line: line + 1 })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

const configPaths: Record<string, string> = {
  "country_whitelist.conf": "/etc/nginx/country_whitelist.conf", "block_asn.conf": "/etc/nginx/block_asn.conf",
  "block_isp.conf": "/etc/nginx/block_isp.conf", "useragent.rules": "/etc/nginx/useragent.rules",
  "ip_whitelist.conf": "/etc/nginx/ip_whitelist.conf", "exclusion_ip.conf": "/etc/nginx/exclusion_ip.conf",
};

app.get("/api/config/:filename", async (req, res) => {
  const filePath = configPaths[req.params.filename];
  if (!filePath) return res.status(404).json({ error: "File non trovato" });
  try { res.json({ filename: req.params.filename, path: filePath, content: await readFile(filePath, "utf-8") }); }
  catch { res.json({ filename: req.params.filename, path: filePath, content: "" }); }
});

app.post("/api/config/update", async (req, res) => {
  const filePath = configPaths[req.body.filename];
  if (!filePath) return res.status(400).json({ error: "File non valido" });
  try { await writeFile(filePath, req.body.content, "utf-8"); res.json({ success: true }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get("/api/fail2ban/jails", async (_req, res) => {
  try {
    const content = await readFile("/etc/fail2ban/jail.local", "utf-8");
    const jails: any[] = [];
    for (const section of content.split(/\n\[/).filter(Boolean)) {
      const lines = section.split("\n");
      const nameMatch = lines[0].match(/^([^\]]+)\]/);
      if (!nameMatch || nameMatch[1] === "DEFAULT") continue;
      const name = nameMatch[1].trim(); const config: any = { name };
      for (const line of lines.slice(1)) {
        const t = line.trim();
        if (t.startsWith("#") || !t.includes("=")) continue;
        const [k, ...v] = t.split("="); const val = v.join("=").trim();
        switch (k.trim()) {
          case "enabled": config.enabled = val === "true"; break;
          case "maxretry": config.maxretry = parseInt(val); break;
          case "bantime": config.bantime = val; break;
          case "findtime": config.findtime = val; break;
          case "filter": config.filter = val; break;
          case "port": config.port = val; break;
          case "logpath": config.logpath = val; break;
        }
      }
      jails.push(config);
    }
    res.json(jails);
  } catch { res.json([]); }
});

app.post("/api/fail2ban/jails/:name", async (req, res) => {
  const { name } = req.params; const { config } = req.body;
  try {
    let content = ""; try { content = await readFile("/etc/fail2ban/jail.local", "utf-8"); } catch {}
    const jailRegex = new RegExp(`\\[${name}\\][\\s\\S]*?(?=\\n\\[|$)`, "g");
    if (jailRegex.test(content)) {
      content = content.replace(new RegExp(`\\[${name}\\][\\s\\S]*?(?=\\n\\[|$)`, "g"), match => {
        let u = match;
        if (config.enabled !== undefined) u = /enabled\s*=/.test(u) ? u.replace(/enabled\s*=.*/, `enabled = ${config.enabled}`) : u + `\nenabled = ${config.enabled}`;
        if (config.maxretry !== undefined) u = /maxretry\s*=/.test(u) ? u.replace(/maxretry\s*=.*/, `maxretry = ${config.maxretry}`) : u + `\nmaxretry = ${config.maxretry}`;
        if (config.bantime) u = /bantime\s*=/.test(u) ? u.replace(/bantime\s*=.*/, `bantime = ${config.bantime}`) : u + `\nbantime = ${config.bantime}`;
        if (config.findtime) u = /findtime\s*=/.test(u) ? u.replace(/findtime\s*=.*/, `findtime = ${config.findtime}`) : u + `\nfindtime = ${config.findtime}`;
        return u;
      });
    }
    await writeFile("/etc/fail2ban/jail.local", content, "utf-8");
    await execAsync("fail2ban-client reload", { timeout: 5000 });
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get("/api/fail2ban/filters", async (_req, res) => {
  try {
    const { stdout } = await execAsync("ls /etc/fail2ban/filter.d/*.conf", { timeout: 3000 });
    const filters: any[] = [];
    for (const fp of stdout.trim().split("\n")) {
      try {
        const content = await readFile(fp, "utf-8"); const name = fp.split("/").pop()?.replace(".conf", "") || "";
        const failregex: string[] = []; const ignoreregex: string[] = [];
        for (const line of content.split("\n")) {
          const fr = line.match(/failregex\s*=\s*(.+)/); const ir = line.match(/ignoreregex\s*=\s*(.+)/);
          if (fr) failregex.push(fr[1].trim()); if (ir) ignoreregex.push(ir[1].trim());
        }
        filters.push({ name, path: fp, failregex, ignoreregex });
      } catch {}
    }
    res.json(filters);
  } catch { res.json([]); }
});

app.post("/api/fail2ban/filters/:name", async (req, res) => {
  const { name } = req.params; const { failregex, ignoreregex } = req.body;
  try {
    let content = `# Fail2ban filter for ${name}\n\n[Definition]\n\n`;
    for (const r of failregex) content += `failregex = ${r}\n`;
    if (ignoreregex?.length) { content += "\n"; for (const r of ignoreregex) content += `ignoreregex = ${r}\n`; }
    await writeFile(`/etc/fail2ban/filter.d/${name}.conf`, content, "utf-8");
    await execAsync("fail2ban-client reload", { timeout: 5000 });
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get("/api/fail2ban/config/:type", async (req, res) => {
  const { type } = req.params;
  if (type !== "jail.local" && type !== "fail2ban.local") return res.status(400).json({ error: "Tipo non valido" });
  const path = type === "jail.local" ? "/etc/fail2ban/jail.local" : "/etc/fail2ban/fail2ban.local";
  try { res.json({ filename: type, path, content: await readFile(path, "utf-8") }); }
  catch { res.json({ filename: type, path, content: "" }); }
});

app.post("/api/fail2ban/config/:type", async (req, res) => {
  const { type } = req.params;
  if (type !== "jail.local" && type !== "fail2ban.local") return res.status(400).json({ error: "Tipo non valido" });
  const path = type === "jail.local" ? "/etc/fail2ban/jail.local" : "/etc/fail2ban/fail2ban.local";
  try { await writeFile(path, req.body.content, "utf-8"); await execAsync("fail2ban-client reload", { timeout: 5000 }); res.json({ success: true }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, BIND, () => {
  console.log(`[Agent] In ascolto su ${BIND}:${PORT} | Hostname: ${os.hostname()}`);
});
