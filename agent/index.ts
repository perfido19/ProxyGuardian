import express, { Request, Response, NextFunction } from "express";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, appendFile, access, readdir } from "fs/promises";
import { constants, existsSync } from "fs";
import path from "path";

const execAsync = promisify(exec);

const app = express();
app.use(express.json());

const AGENT_VERSION = "1.3.1";

const AGENT_API_KEY = process.env.AGENT_API_KEY || "";
const PORT = parseInt(process.env.AGENT_PORT || "3001", 10);
const BIND = process.env.AGENT_BIND || "0.0.0.0";

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers["authorization"];
  const key = (auth && auth.startsWith("Bearer ")) ? auth.slice(7) : req.headers["x-api-key"];
  if (!AGENT_API_KEY || key !== AGENT_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

app.use("/api", requireApiKey);

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", hostname: process.env.HOSTNAME || "unknown", ts: Date.now(), version: AGENT_VERSION });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function runCmd(cmd: string, timeout = 10000): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout });
    return { stdout: stdout.trim(), stderr: stderr.trim(), ok: true };
  } catch (err: any) {
    return { stdout: err.stdout ? err.stdout.trim() : "", stderr: err.stderr ? err.stderr.trim() : err.message, ok: false };
  }
}

async function getServiceStatus(name: string) {
  const { stdout } = await runCmd(`systemctl is-active ${name} 2>/dev/null`);
  const state = stdout.trim().toLowerCase();
  return {
    name,
    status: state === "active" ? "running" : "stopped",
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
    const { stdout: jailList } = await runCmd("sudo fail2ban-client status 2>/dev/null | grep -i 'jail list' | cut -d: -f2");
    const jails = jailList.split(",").map((j: string) => j.trim()).filter(Boolean);
    const bannedIps: object[] = [];
    for (const jail of jails) {
      const { stdout } = await runCmd(`sudo fail2ban-client status ${jail} 2>/dev/null`);
      // Match "Banned IP list:" line and extract all IPv4 addresses from it (handles any whitespace/comma separator)
      const listLine = stdout.split("\n").find(l => /banned ip list/i.test(l)) || "";
      const ips = listLine.match(/\d+\.\d+\.\d+\.\d+/g) || [];
      for (const ip of ips) {
        bannedIps.push({ ip, jail, banTime: new Date().toISOString() });
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
    // Count connections to port 8880 — grep avoids header-line ambiguity
    const { stdout: connOut } = await runCmd("ss -tn 2>/dev/null | grep -c ':8880' || echo 0");
    const activeConnections = parseInt(connOut.trim()) || 0;

    // Sum currently-banned across all fail2ban jails
    const { stdout: jailList } = await runCmd("sudo fail2ban-client status 2>/dev/null | grep -i 'jail list' | cut -d: -f2 || echo ''");
    const jails = jailList.split(",").map((j: string) => j.trim()).filter(Boolean);
    let totalBans24h = 0;
    for (const jail of jails) {
      const { stdout } = await runCmd(`sudo fail2ban-client status ${jail} 2>/dev/null`);
      const match = stdout.match(/Currently banned:\s*(\d+)/i);
      if (match) totalBans24h += parseInt(match[1]);
    }

    res.json({ totalBans24h, activeConnections, blockedCountries: 0, totalRequests24h: 0, topBannedIps: [], bansByCountry: [], banTimeline: [] });
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
  const grepRaw = String(req.query.grep || "").trim();
  const logPath = LOG_PATHS[logType];
  if (!logPath) return res.status(400).json({ error: "Unknown log type" });
  try {
    await access(logPath, constants.R_OK);
    let cmd: string;
    if (grepRaw.length >= 2) {
      const safe = grepRaw.replace(/[`$\\|;&<>'"!\n\r]/g, "").slice(0, 200);
      cmd = `grep -i -m ${lines} "${safe}" "${logPath}" 2>/dev/null`;
    } else {
      cmd = `tail -n ${lines} "${logPath}"`;
    }
    const { stdout } = await runCmd(cmd);
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
  "modsecurity.conf": "/etc/nginx/conf/modsecurity.conf",
  "crs-setup.conf": "/etc/nginx/conf/owasp-modsecurity-crs/crs-setup.conf",
  "block_baduseragents.conf": "/etc/nginx/block_badagents.conf",
  "asn-whitelist.txt": "/etc/asn-whitelist-nets.txt",
  "asn-blocklist.txt": "/etc/asn-blocklist.txt",
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
    if (err.code === "EACCES" || err.code === "EPERM") {
      const agentUser = process.env.USER || "pgagent";
      return res.status(403).json({
        error: `Permessi insufficienti su ${filePath} — esegui: chown root:${agentUser} ${filePath} && chmod 664 ${filePath}`,
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// ─── ModSecurity ──────────────────────────────────────────────────────────────

const MODSEC_CONF = "/etc/nginx/conf/modsecurity.conf";
const MODSEC_LOG  = "/opt/log/modsec_audit.log";

app.get("/api/modsec/status", async (_req, res) => {
  try {
    let engine = "unknown";
    let configFound = false;
    try {
      const raw = await readFile(MODSEC_CONF, "utf-8");
      configFound = true;
      const match = raw.match(/^\s*SecRuleEngine\s+(\S+)/m);
      if (match) engine = match[1];
    } catch {}

    const logStat = await runCmd(`wc -l ${MODSEC_LOG} 2>/dev/null || echo "0"`);
    const logLines = parseInt(logStat.stdout.trim().split(/\s+/)[0]) || 0;

    const nginxV = await runCmd("nginx -V 2>&1 | grep -i modsec | head -1");

    res.json({
      engine,
      configFound,
      moduleLoaded: nginxV.stdout.length > 0,
      logLines,
      logPath: MODSEC_LOG,
      configPath: MODSEC_CONF,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/modsec/engine", async (req, res) => {
  const { state } = req.body;
  if (!["On", "Off", "DetectionOnly"].includes(state)) {
    return res.status(400).json({ error: "state deve essere On, Off o DetectionOnly" });
  }
  try {
    const raw = await readFile(MODSEC_CONF, "utf-8");
    const updated = raw.replace(/^(\s*SecRuleEngine\s+)\S+/m, `$1${state}`);
    await writeFile(MODSEC_CONF, updated, "utf-8");
    const test = await runCmd("sudo nginx -t 2>&1");
    if (!test.ok) {
      // Ripristina
      await writeFile(MODSEC_CONF, raw, "utf-8");
      return res.status(422).json({ error: `nginx -t failed: ${test.stderr}` });
    }
    await runCmd("sudo nginx -s reload 2>&1");
    res.json({ ok: true, engine: state });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/modsec/log", async (req, res) => {
  const lines = Math.min(parseInt(req.query.lines as string) || 200, 1000);
  try {
    const result = await runCmd(`tail -${lines} ${MODSEC_LOG} 2>/dev/null || echo ""`);
    const raw = result.stdout;

    // Parsa eventi dal formato audit log ModSec (blocchi separati da --boundary-A--)
    const events: Array<{ id: string; timestamp: string; ip: string; uri: string; method: string; status: string; messages: string[] }> = [];
    const blocks = raw.split(/^--[a-f0-9]+-A--$/m).filter(b => b.trim());

    for (const block of blocks.slice(-50)) {
      try {
        const lines = block.split("\n");
        const headerLine = lines[0] || "";
        const tsMatch = headerLine.match(/\[([^\]]+)\]/);
        const timestamp = tsMatch ? tsMatch[1] : "";
        const idMatch = headerLine.match(/\S+\s+\S+\s+(\S+)/);
        const id = idMatch ? idMatch[1] : "";

        // Sezione B: request line
        const sectionB = block.match(/--[a-f0-9]+-B--\n([\s\S]*?)(?=\n--[a-f0-9]+-)/);
        const reqLine = sectionB ? sectionB[1].split("\n")[0] : "";
        const reqParts = reqLine.trim().split(" ");
        const method = reqParts[0] || "";
        const uri = reqParts[1] || "";

        // IP from request
        const ipMatch = block.match(/\[client (\S+)\]/) || block.match(/^(\d+\.\d+\.\d+\.\d+)/m);
        const ip = ipMatch ? ipMatch[1] : "";

        // Sezione F: response status
        const sectionF = block.match(/--[a-f0-9]+-F--\n([\s\S]*?)(?=\n--[a-f0-9]+-)/);
        const statusLine = sectionF ? sectionF[1].split("\n")[0] : "";
        const statusMatch = statusLine.match(/\s(\d{3})\s/);
        const status = statusMatch ? statusMatch[1] : "";

        // Messaggi (regole matchate) — sezione H
        const sectionH = block.match(/--[a-f0-9]+-H--\n([\s\S]*?)(?=\n--[a-f0-9]+-)/);
        const messages: string[] = [];
        if (sectionH) {
          const msgMatches = sectionH[1].matchAll(/Message: ([^\n]+)/g);
          for (const m of msgMatches) messages.push(m[1]);
        }

        if (method || ip) events.push({ id, timestamp, ip, uri, method, status, messages });
      } catch {}
    }

    res.json({ raw: raw.slice(-20000), events: events.slice(-30) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── IPSet ────────────────────────────────────────────────────────────────────

function parseIpsetList(output: string): Array<{ name: string; type: string; count: number; members: string[] }> {
  const sets: Array<{ name: string; type: string; count: number; members: string[] }> = [];
  const blocks = output.split(/(?=^Name:)/m);
  for (const block of blocks) {
    const nameMatch = block.match(/^Name:\s+(.+)/m);
    const typeMatch = block.match(/^Type:\s+(.+)/m);
    const countMatch = block.match(/^Number of entries:\s+(\d+)/m);
    const membersSection = block.match(/^Members:\n([\s\S]*)/m);
    if (!nameMatch) continue;
    const members = membersSection
      ? membersSection[1].trim().split("\n").filter(Boolean)
      : [];
    sets.push({
      name: nameMatch[1].trim(),
      type: typeMatch ? typeMatch[1].trim() : "unknown",
      count: countMatch ? parseInt(countMatch[1]) : members.length,
      members,
    });
  }
  return sets;
}

app.get("/api/ipset", async (_req, res) => {
  try {
    const { stdout, ok } = await runCmd("sudo ipset list");
    if (!ok) return res.status(500).json({ error: "ipset non disponibile" });
    const sets = parseIpsetList(stdout);
    res.json(sets.map(({ members, ...meta }) => ({ ...meta, count: members.length })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/ipset/:name", async (req, res) => {
  const { name } = req.params;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: "Nome ipset non valido" });
  try {
    const { stdout, ok } = await runCmd(`sudo ipset list ${name}`);
    if (!ok) return res.status(404).json({ error: "IPSet non trovato" });
    const sets = parseIpsetList(stdout);
    if (!sets.length) return res.status(404).json({ error: "IPSet non trovato" });
    res.json(sets[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ipset/:name/add", async (req, res) => {
  const { name } = req.params;
  const { ip } = req.body;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: "Nome ipset non valido" });
  if (!ip || !/^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(ip)) return res.status(400).json({ error: "IP non valido" });
  const result = await runCmd(`sudo ipset add ${name} ${ip}`);
  res.json({ ok: result.ok, error: result.ok ? undefined : result.stderr });
});

app.post("/api/ipset/:name/remove", async (req, res) => {
  const { name } = req.params;
  const { ip } = req.body;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: "Nome ipset non valido" });
  if (!ip || !/^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(ip)) return res.status(400).json({ error: "IP non valido" });
  const result = await runCmd(`sudo ipset del ${name} ${ip}`);
  res.json({ ok: result.ok, error: result.ok ? undefined : result.stderr });
});

// ─── IPTables ─────────────────────────────────────────────────────────────────

app.get("/api/iptables", async (_req, res) => {
  try {
    const { stdout } = await runCmd("sudo iptables -L -n --line-numbers -v 2>/dev/null");
    const chains: Array<{ name: string; policy: string; rules: string[] }> = [];
    let current: { name: string; policy: string; rules: string[] } | null = null;
    for (const line of stdout.split("\n")) {
      const chainMatch = line.match(/^Chain (\S+) \(policy (\S+)/);
      if (chainMatch) {
        if (current) chains.push(current);
        current = { name: chainMatch[1], policy: chainMatch[2], rules: [] };
      } else if (current && line.trim() && !line.startsWith("num")) {
        current.rules.push(line.trim());
      }
    }
    if (current) chains.push(current);
    res.json(chains);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/iptables/:chain/:linenum", async (req, res) => {
  const { chain, linenum } = req.params;
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(chain)) return res.status(400).json({ error: "Chain non valida" });
  if (!/^\d+$/.test(linenum)) return res.status(400).json({ error: "Numero riga non valido" });
  const result = await runCmd(`sudo iptables -D ${chain} ${linenum}`);
  res.json({ ok: result.ok, error: result.ok ? undefined : result.stderr });
});

app.post("/api/iptables/:chain/rule", async (req, res) => {
  const { chain } = req.params;
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(chain)) return res.status(400).json({ error: "Chain non valida" });
  const { target, protocol, source, dport, position } = req.body;
  if (!target || !/^(ACCEPT|DROP|REJECT|LOG)$/.test(target)) return res.status(400).json({ error: "Target non valido" });
  const flag = position === "insert" ? "-I" : "-A";
  const parts: string[] = [flag, chain];
  if (protocol && /^(tcp|udp|icmp|all)$/.test(protocol)) parts.push("-p", protocol);
  if (source && /^[\d./]+$/.test(source)) parts.push("-s", source);
  if (dport && /^\d+$/.test(dport) && protocol && protocol !== "icmp" && protocol !== "all") parts.push("--dport", dport);
  parts.push("-j", target);
  const result = await runCmd(`sudo iptables ${parts.join(" ")}`);
  res.json({ ok: result.ok, error: result.ok ? undefined : result.stderr });
});

app.post("/api/iptables/:chain/policy", async (req, res) => {
  const { chain } = req.params;
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(chain)) return res.status(400).json({ error: "Chain non valida" });
  const { policy } = req.body;
  if (!policy || !/^(ACCEPT|DROP)$/.test(policy)) return res.status(400).json({ error: "Policy deve essere ACCEPT o DROP" });
  const result = await runCmd(`sudo iptables -P ${chain} ${policy}`);
  res.json({ ok: result.ok, error: result.ok ? undefined : result.stderr });
});

app.post("/api/iptables/:chain/flush", async (req, res) => {
  const { chain } = req.params;
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(chain)) return res.status(400).json({ error: "Chain non valida" });
  const result = await runCmd(`sudo iptables -F ${chain}`);
  res.json({ ok: result.ok, error: result.ok ? undefined : result.stderr });
});

app.post("/api/iptables-save", async (_req, res) => {
  let result = await runCmd("sudo netfilter-persistent save 2>/dev/null");
  if (!result.ok) {
    result = await runCmd("sudo iptables-save | sudo tee /etc/iptables/rules.v4 > /dev/null 2>&1");
  }
  res.json({ ok: result.ok, error: result.ok ? undefined : result.stderr });
});

// ─── NetBird ──────────────────────────────────────────────────────────────────

app.get("/api/netbird", async (_req, res) => {
  try {
    const [serviceResult, connResult] = await Promise.all([
      runCmd("systemctl is-active netbird 2>/dev/null"),
      runCmd("nc -z -w3 main.netbird.cloud 8880 2>/dev/null && echo ok || echo fail"),
    ]);
    res.json({
      running: serviceResult.stdout.trim() === "active",
      connected: connResult.stdout.trim() === "ok",
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/netbird/restart", async (_req, res) => {
  const result = await runCmd("sudo systemctl restart netbird");
  res.json({ ok: result.ok, error: result.ok ? undefined : result.stderr });
});

app.post("/api/netbird/start", async (_req, res) => {
  const result = await runCmd("sudo systemctl start netbird");
  res.json({ ok: result.ok, error: result.ok ? undefined : result.stderr });
});

app.post("/api/netbird/stop", async (_req, res) => {
  const result = await runCmd("sudo systemctl stop netbird");
  res.json({ ok: result.ok, error: result.ok ? undefined : result.stderr });
});

app.post("/api/netbird/update", async (_req, res) => {
  const result = await runCmd("apt install --only-upgrade netbird -y 2>&1");
  await new Promise(r => setTimeout(r, 2000));
  const status = await runCmd("systemctl is-active netbird 2>/dev/null");
  res.json({ ok: result.ok, output: result.stdout || result.stderr, running: status.stdout.trim() === "active" });
});

app.get("/api/netbird/status", async (_req, res) => {
  try {
    const [serviceResult, statusResult] = await Promise.all([
      runCmd("systemctl is-active netbird 2>/dev/null"),
      runCmd("netbird status 2>/dev/null"),
    ]);
    const running = serviceResult.stdout.trim() === "active";
    const output = statusResult.stdout;

    const ipMatch = output.match(/NetBird IP:\s*([\d.]+)(?:\/\d+)?/);
    const ip = ipMatch ? ipMatch[1] : null;

    const managementMatch = output.match(/Management:\s*(\w+)/);
    const connected = managementMatch ? managementMatch[1] === "Connected" : false;

    const peers: Array<{ name: string; ip: string; latency: string; connected: boolean }> = [];
    const peerSectionMatch = output.match(/^Peers:\n([\s\S]*)/m);
    if (peerSectionMatch) {
      const entries = peerSectionMatch[1].split(/\n(?= \S)/);
      for (const entry of entries) {
        const nameMatch = entry.match(/^ (.+)/);
        const peerIpMatch = entry.match(/NetBird IP:\s*([\d.]+)/);
        const latencyMatch = entry.match(/Latency:\s*(\S+)/);
        const statusMatch = entry.match(/Status:\s*(\w+)/);
        if (nameMatch && peerIpMatch) {
          peers.push({
            name: nameMatch[1].trim(),
            ip: peerIpMatch[1],
            latency: latencyMatch ? latencyMatch[1] : "?",
            connected: statusMatch ? statusMatch[1] === "Connected" : false,
          });
        }
      }
    }

    res.json({ running, connected, ip, peers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── NetBird Cleanup Setup ────────────────────────────────────────────────────

const NETBIRD_RESTART_NGINX_CONF = "[Service]\nExecStartPost=/bin/bash -c 'sleep 3 && systemctl restart nginx'\n";

const NETBIRD_IPSET_CLEANUP_SH = [
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

const NETBIRD_CLEANUP_SERVICE = [
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

app.get("/api/netbird/cleanup-status", async (_req, res) => {
  try {
    const dropinInstalled = existsSync("/etc/systemd/system/netbird.service.d/restart-nginx.conf");
    const scriptInstalled = existsSync("/usr/local/bin/netbird-ipset-cleanup.sh");
    const serviceInstalled = existsSync("/etc/systemd/system/netbird-cleanup.service");
    const enabledResult = await runCmd("systemctl is-enabled netbird-cleanup.service 2>/dev/null || echo disabled");
    const serviceEnabled = enabledResult.stdout.trim() === "enabled";
    res.json({
      dropinInstalled,
      scriptInstalled,
      serviceInstalled,
      serviceEnabled,
      ready: dropinInstalled && scriptInstalled && serviceInstalled && serviceEnabled,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/netbird/setup-cleanup", async (_req, res) => {
  const steps: Array<{ step: string; ok: boolean; error?: string }> = [];

  function addStep(label: string, result: { ok: boolean; stderr: string }): void {
    steps.push({ step: label, ok: result.ok, error: result.ok ? undefined : result.stderr });
  }

  try {
    await writeFile("/tmp/pg-netbird-restart-nginx.conf", NETBIRD_RESTART_NGINX_CONF, "utf-8");
    await writeFile("/tmp/pg-netbird-ipset-cleanup.sh", NETBIRD_IPSET_CLEANUP_SH, "utf-8");
    await writeFile("/tmp/pg-netbird-cleanup.service", NETBIRD_CLEANUP_SERVICE, "utf-8");

    addStep("mkdir netbird.service.d", await runCmd("sudo mkdir -p /etc/systemd/system/netbird.service.d"));
    addStep("deploy restart-nginx.conf", await runCmd("cat /tmp/pg-netbird-restart-nginx.conf | sudo tee /etc/systemd/system/netbird.service.d/restart-nginx.conf > /dev/null"));
    addStep("deploy netbird-ipset-cleanup.sh", await runCmd("cat /tmp/pg-netbird-ipset-cleanup.sh | sudo tee /usr/local/bin/netbird-ipset-cleanup.sh > /dev/null"));
    addStep("chmod +x netbird-ipset-cleanup.sh", await runCmd("sudo chmod +x /usr/local/bin/netbird-ipset-cleanup.sh"));
    addStep("deploy netbird-cleanup.service", await runCmd("cat /tmp/pg-netbird-cleanup.service | sudo tee /etc/systemd/system/netbird-cleanup.service > /dev/null"));
    addStep("systemctl daemon-reload", await runCmd("sudo systemctl daemon-reload"));
    addStep("systemctl enable netbird-cleanup.service", await runCmd("sudo systemctl enable netbird-cleanup.service"));

    const allOk = steps.every(function(s) { return s.ok; });
    res.json({ ok: allOk, steps });
  } catch (err: any) {
    res.status(500).json({ error: err.message, steps });
  }
});

// ─── Grep / search ────────────────────────────────────────────────────────────

app.get("/api/grep", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const logType = String(req.query.type || "nginx_access");
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
    hostname: process.env.HOSTNAME || "unknown",
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

// ─── ASN Block ────────────────────────────────────────────────────────────────

const ASN_BLOCKLIST_FILE = "/etc/asn-blocklist.txt";
const ASN_WHITELIST_FILE = "/etc/asn-whitelist-nets.txt";
const ASN_UPDATE_SCRIPT = "/usr/local/bin/update-asn-block.sh";

let asnStatsCache: { data: any; ts: number } | null = null;
const ASN_CACHE_TTL = 5 * 60 * 1000;

const ASN_AGENT_USER = process.env.USER || "pgagent";

function spawnAsnUpdate() {
  var child = spawn("sudo", ["bash", ASN_UPDATE_SCRIPT], { detached: true, stdio: "ignore" });
  child.unref();
}

app.get("/api/asn/blocklist", async (_req, res) => {
  try {
    var raw = "";
    try { raw = await readFile(ASN_BLOCKLIST_FILE, "utf-8"); } catch {}
    var asns = raw.split("\n").map(function(l) { return l.trim(); }).filter(function(l) {
      return l.length > 0 && !l.startsWith("#");
    }).map(function(l) {
      var ci = l.indexOf("#");
      return (ci >= 0 ? l.slice(0, ci).trim() : l).trim();
    }).filter(function(l) { return l.length > 0; });
    res.json({ total: asns.length, asns: asns });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/asn/blocklist", async (req, res) => {
  try {
    var asn = String(req.body.asn || "").trim().toUpperCase();
    var comment = String(req.body.comment || "").replace(/[\n\r]/g, "").slice(0, 200);
    if (!asn) return res.status(400).json({ error: "asn required" });
    if (!/^AS\d+$/.test(asn)) return res.status(400).json({ error: "Formato ASN non valido (es: AS15169)" });
    var raw = "";
    try { raw = await readFile(ASN_BLOCKLIST_FILE, "utf-8"); } catch {}
    var exists = raw.split("\n").some(function(l) {
      var t = l.trim();
      if (!t || t.startsWith("#")) return false;
      var ci = t.indexOf("#");
      return (ci >= 0 ? t.slice(0, ci).trim() : t).trim() === asn;
    });
    if (exists) return res.status(409).json({ error: asn + " gia presente nella blocklist" });
    var line = comment ? (asn + "  # " + comment + "\n") : (asn + "\n");
    try {
      await appendFile(ASN_BLOCKLIST_FILE, line, "utf-8");
    } catch (err: any) {
      if (err.code === "EACCES" || err.code === "EPERM") {
        var u = ASN_AGENT_USER;
        return res.status(403).json({ error: "Permessi insufficienti su " + ASN_BLOCKLIST_FILE + " — esegui: chown root:" + u + " " + ASN_BLOCKLIST_FILE + " && chmod 664 " + ASN_BLOCKLIST_FILE });
      }
      throw err;
    }
    spawnAsnUpdate();
    res.json({ ok: true, asn: asn });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/asn/blocklist", async (req, res) => {
  try {
    var asn = String((req.body && req.body.asn) || "").trim().toUpperCase();
    if (!asn) return res.status(400).json({ error: "asn required" });
    if (!/^AS\d+$/.test(asn)) return res.status(400).json({ error: "Formato ASN non valido" });
    var raw = "";
    try { raw = await readFile(ASN_BLOCKLIST_FILE, "utf-8"); } catch {}
    var filtered = raw.split("\n").filter(function(l) {
      var t = l.trim();
      if (!t || t.startsWith("#")) return true;
      var ci = t.indexOf("#");
      return (ci >= 0 ? t.slice(0, ci).trim() : t).trim() !== asn;
    }).join("\n");
    try {
      await writeFile(ASN_BLOCKLIST_FILE, filtered, "utf-8");
    } catch (err: any) {
      if (err.code === "EACCES" || err.code === "EPERM") {
        var u = ASN_AGENT_USER;
        return res.status(403).json({ error: "Permessi insufficienti su " + ASN_BLOCKLIST_FILE + " — esegui: chown root:" + u + " " + ASN_BLOCKLIST_FILE + " && chmod 664 " + ASN_BLOCKLIST_FILE });
      }
      throw err;
    }
    spawnAsnUpdate();
    res.json({ ok: true, asn: asn });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/asn/stats", async (_req, res) => {
  try {
    if (asnStatsCache && Date.now() - asnStatsCache.ts < ASN_CACHE_TTL) {
      return res.json(asnStatsCache.data);
    }
    const [statsResult, prefixResult] = await Promise.all([
      runCmd("python3 /usr/local/bin/asn-log-stats.py --top 50 --json 2>/dev/null", 15000),
      runCmd("sudo ipset list blocked_asn 2>/dev/null | grep -c '/' || echo 0"),
    ]);
    let top: any[] = [];
    if (statsResult.ok && statsResult.stdout) {
      try { top = JSON.parse(statsResult.stdout); } catch {}
    }
    const totalPrefixes = parseInt(prefixResult.stdout.trim()) || 0;
    const data = { updatedAt: new Date().toISOString(), totalPrefixes, top };
    asnStatsCache = { data, ts: Date.now() };
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/asn/status", async (_req, res) => {
  try {
    const [ipsetRestore, whitelistWatcher, prefixes, lastMtime] = await Promise.all([
      runCmd("systemctl is-active ipset-restore 2>/dev/null"),
      runCmd("systemctl is-active whitelist-watcher 2>/dev/null"),
      runCmd("sudo ipset list blocked_asn 2>/dev/null | grep -c '/' || echo 0"),
      runCmd("stat -c %Y /var/log/update-asn-block.log 2>/dev/null || echo 0"),
    ]);
    const mtimeSec = parseInt(lastMtime.stdout.trim()) || 0;
    const lastUpdate = mtimeSec > 0 ? new Date(mtimeSec * 1000).toISOString() : "";
    res.json({
      ipsetRestore: ipsetRestore.stdout.trim(),
      whitelistWatcher: whitelistWatcher.stdout.trim(),
      totalPrefixes: parseInt(prefixes.stdout.trim()) || 0,
      lastUpdate: lastUpdate,
      installed: existsSync("/usr/local/bin/update-lists.sh") && existsSync(ASN_UPDATE_SCRIPT),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/asn/whitelist", async (_req, res) => {
  var raw = "";
  try {
    raw = await readFile(ASN_WHITELIST_FILE, "utf-8");
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error("[asn/whitelist] readFile " + ASN_WHITELIST_FILE + ":", err.message);
    }
  }
  var entries = raw.split("\n").map(function(line) {
    var t = line.trim();
    if (!t || t.startsWith("#")) return null;
    var ci = t.indexOf("#");
    var value = (ci >= 0 ? t.slice(0, ci).trim() : t).trim();
    var comment = ci >= 0 ? t.slice(ci + 1).trim() : "";
    if (!value) return null;
    var type = value.startsWith("domain:") ? "domain" : "cidr";
    return { value: value, comment: comment, type: type };
  }).filter(Boolean);
  res.json({ entries: entries });
});

app.post("/api/asn/whitelist", async (req, res) => {
  const { value, comment } = req.body;
  if (!value || typeof value !== "string") return res.status(400).json({ error: "value required" });
  if (!/^[\w.\-:/]+$/.test(value.trim())) return res.status(400).json({ error: "Valore non valido" });
  const safe = value.trim();
  const line = comment ? `${safe} # ${String(comment).replace(/[\n\r]/g, "").slice(0, 200)}` : safe;
  try {
    await appendFile(ASN_WHITELIST_FILE, line + "\n", "utf-8");
    res.json({ ok: true });
  } catch (err: any) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      var u = agentUser;
      return res.status(403).json({ error: "Permessi insufficienti su " + ASN_WHITELIST_FILE + " — esegui: chown root:" + u + " " + ASN_WHITELIST_FILE + " && chmod 664 " + ASN_WHITELIST_FILE });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/asn/whitelist", async (req, res) => {
  const { value } = req.body;
  if (!value || typeof value !== "string") return res.status(400).json({ error: "value required" });
  if (!/^[\w.\-:/]+$/.test(value.trim())) return res.status(400).json({ error: "Valore non valido" });
  try {
    var raw = await readFile(ASN_WHITELIST_FILE, "utf-8");
    var safe = value.trim();
    var filtered = raw.split("\n").filter(function(l) {
      var t = l.trim();
      if (!t || t.startsWith("#")) return true;
      var ci = t.indexOf("#");
      return (ci >= 0 ? t.slice(0, ci).trim() : t).trim() !== safe;
    }).join("\n");
    await writeFile(ASN_WHITELIST_FILE, filtered, "utf-8");
    res.json({ ok: true });
  } catch (err: any) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      var u = agentUser;
      return res.status(403).json({ error: "Permessi insufficienti su " + ASN_WHITELIST_FILE + " — esegui: chown root:" + u + " " + ASN_WHITELIST_FILE + " && chmod 664 " + ASN_WHITELIST_FILE });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/asn/update-lists", async (_req, res) => {
  if (!existsSync("/usr/local/bin/update-lists.sh")) {
    return res.status(404).json({ success: false, error: "Script update-lists.sh non trovato. AsnBlock non è installato su questo VPS." });
  }
  const result = await runCmd("sudo bash /usr/local/bin/update-lists.sh 2>&1", 60000);
  res.json({ success: result.ok, output: result.stdout || result.stderr });
});

app.post("/api/asn/update-set", async (_req, res) => {
  if (!existsSync(ASN_UPDATE_SCRIPT)) {
    return res.status(404).json({ success: false, error: "Script update-asn-block.sh non trovato. AsnBlock non è installato su questo VPS." });
  }
  const result = await runCmd("sudo bash " + ASN_UPDATE_SCRIPT + " 2>&1", 120000);
  asnStatsCache = null;
  res.json({ success: result.ok, output: result.stdout || result.stderr });
});

app.post("/api/asn/test-ip", async (req, res) => {
  const { ip } = req.body;
  if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return res.status(400).json({ error: "IP non valido" });
  const result = await runCmd(`sudo ipset test blocked_asn ${ip} 2>&1`);
  res.json({ blocked: result.ok });
});

app.get("/api/asn/log", async (_req, res) => {
  const { stdout } = await runCmd("tail -100 /var/log/update-asn-block.log 2>/dev/null || echo ''");
  res.json({ lines: stdout.split("\n").filter(Boolean) });
});

// ─── Sudoers management ───────────────────────────────────────────────────────

const SUDOERS_PATH = "/etc/sudoers.d/proxy-guardian-agent";

const SUDOERS_CONTENT = [
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
  "pgagent ALL=(ALL) NOPASSWD: /usr/bin/netbird update",
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
  "",
].join("\n");

app.get("/api/system/sudoers-status", async (_req, res) => {
  try {
    var content = "";
    try { content = await readFile(SUDOERS_PATH, "utf-8"); } catch {}
    res.json({
      exists: content.length > 0,
      hasNetbirdCleanupEntries: content.includes("tee /etc/systemd/system/netbird-cleanup.service"),
      canSelfUpdate: content.includes("tee /etc/sudoers.d/proxy-guardian-agent"),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/system/update-sudoers", async (_req, res) => {
  try {
    await writeFile("/tmp/pg-sudoers-update", SUDOERS_CONTENT, "utf-8");
    const result = await runCmd("cat /tmp/pg-sudoers-update | sudo tee " + SUDOERS_PATH + " > /dev/null");
    if (!result.ok) {
      return res.status(403).json({ ok: false, error: result.stderr });
    }
    await runCmd("chmod 440 " + SUDOERS_PATH);
    res.json({ ok: true, message: "Sudoers aggiornati" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SSH Key install ──────────────────────────────────────────────────────────

app.post("/api/system/install-ssh-key", async (req, res) => {
  var publicKey = (req.body && req.body.publicKey) ? String(req.body.publicKey).trim() : "";
  if (!publicKey || !/^ssh-/.test(publicKey)) {
    return res.status(400).json({ error: "publicKey non valida o mancante" });
  }
  // Sanifica: niente newline interne
  publicKey = publicKey.replace(/[\r\n]+/g, "");
  var steps: Array<{ step: string; ok: boolean; error?: string }> = [];
  function addStep(label: string, result: { ok: boolean; stderr: string }) {
    steps.push({ step: label, ok: result.ok, error: result.ok ? undefined : result.stderr });
  }
  try {
    addStep("mkdir -p /root/.ssh", await runCmd("sudo mkdir -p /root/.ssh"));
    addStep("chmod 700 /root/.ssh", await runCmd("sudo chmod 700 /root/.ssh"));
    // Evita duplicati
    var checkResult = await runCmd("sudo cat /root/.ssh/authorized_keys 2>/dev/null || echo ''");
    var existing = checkResult.stdout || "";
    if (existing.indexOf(publicKey) !== -1) {
      return res.json({ ok: true, steps: [], message: "Chiave gia presente" });
    }
    await writeFile("/tmp/pg-sshkey", publicKey + "\n", "utf-8");
    addStep("append authorized_keys", await runCmd("cat /tmp/pg-sshkey | sudo tee -a /root/.ssh/authorized_keys > /dev/null"));
    addStep("chmod 600 authorized_keys", await runCmd("sudo chmod 600 /root/.ssh/authorized_keys"));
    var allOk = steps.every(function(s) { return s.ok; });
    res.json({ ok: allOk, steps: steps });
  } catch (err: any) {
    res.status(500).json({ error: err.message, steps: steps });
  }
});

// ─── Nginx dirs setup ─────────────────────────────────────────────────────────

app.post("/api/system/setup-nginx-dirs", async (_req, res) => {
  var steps: Array<{ step: string; ok: boolean; error?: string }> = [];
  function addStep(label: string, result: { ok: boolean; stderr: string }) {
    steps.push({ step: label, ok: result.ok, error: result.ok ? undefined : result.stderr });
  }
  try {
    addStep("mkdir epg", await runCmd("sudo mkdir -p /var/cache/nginx/epg"));
    addStep("mkdir streaming", await runCmd("sudo mkdir -p /var/cache/nginx/streaming"));
    addStep("chown epg", await runCmd("sudo chown -R www-data /var/cache/nginx/epg"));
    addStep("chown streaming", await runCmd("sudo chown -R www-data /var/cache/nginx/streaming"));
    var allOk = steps.every(function(s) { return s.ok; });
    res.json({ ok: allOk, steps: steps });
  } catch (err: any) {
    res.status(500).json({ error: err.message, steps: steps });
  }
});

// ─── Agent self-update ────────────────────────────────────────────────────────

app.post("/api/agent/update", express.raw({ type: "*/*", limit: "10mb" }), async (req, res) => {
  var bundle = req.body;
  if (!Buffer.isBuffer(bundle) || bundle.length < 1000) {
    return res.status(400).json({ error: "Bundle non valido o troppo piccolo" });
  }
  var dir = path.dirname(path.resolve(process.argv[1]));
  var dest = path.join(dir, "agent-bundle.js");
  var startSh = path.join(dir, "start.sh");
  try {
    await writeFile(dest, bundle);
    // Assicura che start.sh punti a agent-bundle.js
    var startContent = "#!/bin/bash\nset -a\nsource " + dir + "/.env\nset +a\nexec node " + dest + "\n";
    await writeFile(startSh, startContent);
    res.json({ ok: true, version: AGENT_VERSION, message: "Bundle aggiornato, riavvio in corso..." });
    // process.exit(1) triggers systemd Restart=on-failure → picks up new bundle from disk
    setTimeout(function() { process.exit(1); }, 500);
  } catch (err) {
    var e = err as any;
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, BIND, () => {
  console.log(`[ProxyGuardian Agent] Listening on ${BIND}:${PORT}`);
  if (!AGENT_API_KEY) console.warn("[WARN] AGENT_API_KEY not set — all requests will be rejected");
});
