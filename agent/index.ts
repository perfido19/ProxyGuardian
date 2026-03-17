import express, { Request, Response, NextFunction } from "express";
import { exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, access, readdir } from "fs/promises";
import { constants } from "fs";
import path from "path";

const execAsync = promisify(exec);

const app = express();
app.use(express.json());

const AGENT_API_KEY = process.env.AGENT_API_KEY ?? "";
const PORT = parseInt(process.env.AGENT_PORT ?? "3001", 10);
const BIND = process.env.AGENT_BIND ?? "0.0.0.0";

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers["authorization"];
  const key = auth?.startsWith("Bearer ") ? auth.slice(7) : req.headers["x-api-key"];
  if (!AGENT_API_KEY || key !== AGENT_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

app.use("/api", requireApiKey);

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", hostname: process.env.HOSTNAME ?? "unknown", ts: Date.now() });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function runCmd(cmd: string): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 10000 });
    return { stdout: stdout.trim(), stderr: stderr.trim(), ok: true };
  } catch (err: any) {
    return { stdout: err.stdout?.trim() ?? "", stderr: err.stderr?.trim() ?? err.message, ok: false };
  }
}

async function getServiceStatus(name: string) {
  const { stdout, ok } = await runCmd(`sudo systemctl status ${name} --no-pager -l`);
  const active = /Active:\s+active/.test(stdout);
  const pidMatch = stdout.match(/Main PID:\s+(\d+)/);
  const uptimeMatch = stdout.match(/Active:.*?since.*?;\s+(.+?)(\n|$)/);
  return {
    name,
    status: ok && active ? "running" : "stopped",
    pid: pidMatch ? parseInt(pidMatch[1]) : undefined,
    uptime: uptimeMatch ? uptimeMatch[1].trim() : undefined,
    raw: stdout,
  };
}

// ─── Services ─────────────────────────────────────────────────────────────────

app.get("/api/services", async (_req, res) => {
  try {
    const services = await Promise.all([
      getServiceStatus("nginx"),
      getServiceStatus("fail2ban"),
      getServiceStatus("mariadb"),
    ]);
    res.json(services);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/services/:name", async (req, res) => {
  const allowed = ["nginx", "fail2ban", "mariadb", "mysql", "postgresql", "redis"];
  const { name } = req.params;
  if (!allowed.includes(name)) return res.status(400).json({ error: "Service not allowed" });
  try {
    res.json(await getServiceStatus(name));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/services/:name/action", async (req, res) => {
  const allowed = ["nginx", "fail2ban", "mariadb", "mysql"];
  const actions = ["start", "stop", "restart", "reload"];
  const { name } = req.params;
  const { action } = req.body;
  if (!allowed.includes(name)) return res.status(400).json({ error: "Service not allowed" });
  if (!actions.includes(action)) return res.status(400).json({ error: "Action not allowed" });
  const result = await runCmd(`sudo systemctl ${action} ${name}`);
  await new Promise(r => setTimeout(r, 1500));
  const status = await getServiceStatus(name);
  res.json({ ok: result.ok, stderr: result.stderr, service: status });
});

// ─── Fail2ban ─────────────────────────────────────────────────────────────────

app.get("/api/banned-ips", async (_req, res) => {
  try {
    const { stdout: jailList } = await runCmd("sudo fail2ban-client status | grep 'Jail list' | cut -d: -f2");
    const jails = jailList.split(",").map(j => j.trim()).filter(Boolean);
    const bannedIps: object[] = [];
    for (const jail of jails) {
      const { stdout } = await runCmd(`sudo fail2ban-client status ${jail}`);
      const match = stdout.match(/Banned IP list:\s*([\d\.\s,]+)/);
      if (match) {
        const ips = match[1].split(/[\s,]+/).filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
        for (const ip of ips) {
          bannedIps.push({ ip, jail, banTime: new Date().toISOString() });
        }
      }
    }
    res.json(bannedIps);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/unban", async (req, res) => {
  const { ip, jail } = req.body;
  if (!ip || !jail) return res.status(400).json({ error: "ip and jail required" });
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return res.status(400).json({ error: "Invalid IP" });
  const result = await runCmd(`sudo fail2ban-client set ${jail} unbanip ${ip}`);
  res.json({ ok: result.ok, message: result.ok ? `${ip} unbanned from ${jail}` : result.stderr });
});

app.post("/api/unban-all", async (_req, res) => {
  const { stdout: jailList } = await runCmd("sudo fail2ban-client status | grep 'Jail list' | cut -d: -f2");
  const jails = jailList.split(",").map(j => j.trim()).filter(Boolean);
  let total = 0;
  for (const jail of jails) {
    const { stdout } = await runCmd(`sudo fail2ban-client status ${jail}`);
    const match = stdout.match(/Banned IP list:\s*([\d\.\s,]+)/);
    if (match) {
      const ips = match[1].split(/[\s,]+/).filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
      for (const ip of ips) {
        await runCmd(`sudo fail2ban-client set ${jail} unbanip ${ip}`);
        total++;
      }
    }
  }
  res.json({ ok: true, unbannedCount: total, jailsProcessed: jails.length });
});

// ─── Stats ────────────────────────────────────────────────────────────────────

app.get("/api/stats", async (_req, res) => {
  try {
    const [connections, nginxStatus] = await Promise.all([
      runCmd("ss -tn state established '( dport = :80 or dport = :443 or dport = :8880 )' | wc -l"),
      runCmd("curl -sf http://127.0.0.1/nginx_status 2>/dev/null || echo ''"),
    ]);

    let activeConnections = parseInt(connections.stdout) || 0;
    if (nginxStatus.stdout) {
      const m = nginxStatus.stdout.match(/Active connections:\s*(\d+)/);
      if (m) activeConnections = parseInt(m[1]);
    }

    const { stdout: fail2banStatus } = await runCmd("sudo fail2ban-client status 2>/dev/null || echo ''");
    const totalBannedMatch = fail2banStatus.match(/Currently banned:\s*(\d+)/);
    const totalBans24h = totalBannedMatch ? parseInt(totalBannedMatch[1]) : 0;

    res.json({
      totalBans24h,
      activeConnections,
      blockedCountries: 0,
      totalRequests24h: 0,
      topBannedIps: [],
      bansByCountry: [],
      banTimeline: [],
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Logs ─────────────────────────────────────────────────────────────────────

const LOG_PATHS: Record<string, string> = {
  nginx_access: "/var/log/nginx/access.log",
  nginx_error: "/var/log/nginx/error.log",
  fail2ban: "/var/log/fail2ban.log",
  system: "/var/log/syslog",
};

app.get("/api/logs/:logType", async (req, res) => {
  const { logType } = req.params;
  const lines = Math.min(parseInt(req.query.lines as string) || 100, 500);
  const logPath = LOG_PATHS[logType];
  if (!logPath) return res.status(400).json({ error: "Unknown log type" });
  try {
    await access(logPath, constants.R_OK);
    const { stdout } = await runCmd(`tail -n ${lines} ${logPath}`);
    const entries = stdout.split("\n").filter(Boolean).map((line, i) => ({
      id: i,
      timestamp: new Date().toISOString(),
      level: line.toLowerCase().includes("error") ? "error" : line.toLowerCase().includes("warn") ? "warn" : "info",
      message: line,
      source: logType,
    }));
    res.json(entries.reverse());
  } catch {
    res.json([]);
  }
});

// ─── Config files ─────────────────────────────────────────────────────────────

const CONFIG_PATHS: Record<string, string> = {
  "nginx.conf": "/etc/nginx/nginx.conf",
  "jail.local": "/etc/fail2ban/jail.local",
  "fail2ban.local": "/etc/fail2ban/fail2ban.local",
  "country_whitelist.conf": "/etc/nginx/country_whitelist.conf",
  "block_asn.conf": "/etc/nginx/block_asn.conf",
  "block_isp.conf": "/etc/nginx/block_isp.conf",
  "useragent.rules": "/etc/nginx/useragent.rules",
  "ip_whitelist.conf": "/etc/nginx/ip_whitelist.conf",
  "exclusion_ip.conf": "/etc/nginx/exclusion_ip.conf",
};

app.get("/api/config/:filename", async (req, res) => {
  const filePath = CONFIG_PATHS[req.params.filename];
  if (!filePath) return res.status(400).json({ error: "File not allowed" });
  try {
    const content = await readFile(filePath, "utf-8");
    res.json({ filename: req.params.filename, content, path: filePath });
  } catch {
    res.json({ filename: req.params.filename, content: "", path: filePath });
  }
});

app.post("/api/config/:filename", async (req, res) => {
  const filePath = CONFIG_PATHS[req.params.filename];
  if (!filePath) return res.status(400).json({ error: "File not allowed" });
  const { content } = req.body;
  if (typeof content !== "string") return res.status(400).json({ error: "content required" });
  try {
    await writeFile(filePath, content, "utf-8");
    if (req.params.filename.startsWith("nginx") || req.params.filename.endsWith(".conf") || req.params.filename.endsWith(".rules")) {
      const test = await runCmd("sudo nginx -t");
      if (!test.ok) {
        return res.status(422).json({ error: `nginx -t failed: ${test.stderr}` });
      }
    }
    res.json({ ok: true, message: `${req.params.filename} updated` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Grep / search ────────────────────────────────────────────────────────────

app.get("/api/grep", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const logType = String(req.query.type ?? "nginx_access");
  const lines = Math.min(parseInt(req.query.lines as string) || 500, 500);
  if (q.length < 2) return res.status(400).json({ error: "Query troppo breve (min 2 caratteri)" });
  // Sanitize: allow only chars safe for a grep pattern (no shell metacharacters)
  const safe = q.replace(/[`$\\|;&<>'"!\n\r]/g, "").slice(0, 200);
  const logPath = LOG_PATHS[logType];
  if (!logPath) return res.status(400).json({ error: "Tipo log sconosciuto" });
  try {
    await access(logPath, constants.R_OK);
    const { stdout } = await runCmd(`grep -i -m ${lines} "${safe}" "${logPath}" 2>/dev/null`);
    const entries = stdout.split("\n").filter(Boolean).map((line, i) => ({
      id: i,
      level: line.toLowerCase().includes("error") ? "error" : line.toLowerCase().includes("warn") ? "warn" : "info",
      message: line,
    }));
    res.json({ query: safe, logType, count: entries.length, entries });
  } catch {
    res.json({ query: safe, logType, count: 0, entries: [] });
  }
});

// ─── Fail2ban filters ─────────────────────────────────────────────────────────

const FILTER_DIR = "/etc/fail2ban/filter.d";

app.get("/api/fail2ban/filters", async (_req, res) => {
  try {
    const files = await readdir(FILTER_DIR);
    const names = files.filter(f => f.endsWith(".conf")).map(f => path.basename(f, ".conf"));
    res.json(names);
  } catch {
    res.json([]);
  }
});

app.get("/api/fail2ban/filters/:name", async (req, res) => {
  const filePath = path.join(FILTER_DIR, `${req.params.name}.conf`);
  try {
    await access(filePath, constants.R_OK);
    const content = await readFile(filePath, "utf-8");
    res.json({ name: req.params.name, content, path: filePath });
  } catch {
    res.json({ name: req.params.name, content: "", path: filePath });
  }
});

app.post("/api/fail2ban/filters/:name", async (req, res) => {
  const filePath = path.join(FILTER_DIR, `${req.params.name}.conf`);
  const { content } = req.body;
  if (typeof content !== "string") return res.status(400).json({ error: "content required" });
  try {
    await writeFile(filePath, content, "utf-8");
    await runCmd("sudo fail2ban-client reload 2>/dev/null || true");
    res.json({ ok: true, message: `Filter ${req.params.name} updated` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Nginx ────────────────────────────────────────────────────────────────────

app.post("/api/nginx/test", async (_req, res) => {
  const result = await runCmd("sudo nginx -t");
  res.json({ ok: result.ok, output: result.stderr || result.stdout });
});

app.post("/api/nginx/reload", async (_req, res) => {
  const test = await runCmd("sudo nginx -t");
  if (!test.ok) return res.status(422).json({ ok: false, error: test.stderr });
  const result = await runCmd("sudo systemctl reload nginx");
  res.json({ ok: result.ok, error: result.stderr || undefined });
});

// ─── System info ──────────────────────────────────────────────────────────────

app.get("/api/system", async (_req, res) => {
  const [uptime, memory, disk, load] = await Promise.all([
    runCmd("uptime -p"),
    runCmd("free -m | awk 'NR==2{printf \"%s %s %s\", $2,$3,$4}'"),
    runCmd("df -h / | awk 'NR==2{printf \"%s %s %s %s\", $2,$3,$4,$5}'"),
    runCmd("cat /proc/loadavg"),
  ]);
  const [memTotal, memUsed, memFree] = (memory.stdout || "0 0 0").split(" ").map(Number);
  const [diskTotal, diskUsed, diskFree, diskPercent] = (disk.stdout || "0 0 0 0%").split(" ");
  const loadValues = (load.stdout || "0 0 0").split(" ").slice(0, 3).map(Number);
  res.json({
    uptime: uptime.stdout,
    memory: { total: memTotal, used: memUsed, free: memFree },
    disk: { total: diskTotal, used: diskUsed, free: diskFree, percent: diskPercent },
    load: { "1m": loadValues[0], "5m": loadValues[1], "15m": loadValues[2] },
    hostname: process.env.HOSTNAME ?? "unknown",
  });
});

// ─── Fail2ban jails ───────────────────────────────────────────────────────────

app.get("/api/fail2ban/jails", async (_req, res) => {
  try {
    const { stdout: jailList } = await runCmd("sudo fail2ban-client status | grep 'Jail list' | cut -d: -f2");
    const jailNames = jailList.split(",").map(j => j.trim()).filter(Boolean);
    const jails = await Promise.all(jailNames.map(async name => {
      const { stdout } = await runCmd(`sudo fail2ban-client status ${name}`);
      const banTimeMatch = stdout.match(/Ban time:\s*(\d+)/);
      const maxRetryMatch = stdout.match(/Max retry:\s*(\d+)/);
      const enabledMatch = stdout.match(/Status.*enabled/i);
      return {
        name,
        enabled: !!enabledMatch,
        banTime: banTimeMatch ? parseInt(banTimeMatch[1]) : 600,
        maxRetry: maxRetryMatch ? parseInt(maxRetryMatch[1]) : 5,
        findTime: 600,
      };
    }));
    res.json(jails);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/fail2ban/jails/:name", async (req, res) => {
  const { name } = req.params;
  const { config } = req.body;
  const cmds: string[] = [];
  if (config.enabled !== undefined) cmds.push(`sudo fail2ban-client set ${name} ${config.enabled ? "unbanip all" : "banned"}`);
  if (config.banTime !== undefined) cmds.push(`sudo fail2ban-client set ${name} bantime ${config.banTime}`);
  if (config.maxRetry !== undefined) cmds.push(`sudo fail2ban-client set ${name} maxretry ${config.maxRetry}`);
  if (config.findTime !== undefined) cmds.push(`sudo fail2ban-client set ${name} findtime ${config.findTime}`);
  for (const cmd of cmds) await runCmd(cmd);
  res.json({ ok: true, message: `Jail ${name} updated` });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, BIND, () => {
  console.log(`[ProxyGuardian Agent] Listening on ${BIND}:${PORT}`);
  if (!AGENT_API_KEY) console.warn("[WARN] AGENT_API_KEY not set — all requests will be rejected");
});
