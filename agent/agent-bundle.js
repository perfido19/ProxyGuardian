"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// agent/index.ts
var import_express = __toESM(require("express"), 1);
var import_child_process = require("child_process");
var import_util = require("util");
var import_promises = require("fs/promises");
var import_fs = require("fs");
var import_path = __toESM(require("path"), 1);
var execAsync = (0, import_util.promisify)(import_child_process.exec);
var app = (0, import_express.default)();
app.use(import_express.default.json());
var AGENT_API_KEY = process.env.AGENT_API_KEY ?? "";
var PORT = parseInt(process.env.AGENT_PORT ?? "3001", 10);
var BIND = process.env.AGENT_BIND ?? "0.0.0.0";
function requireApiKey(req, res, next) {
  const auth = req.headers["authorization"];
  const key = auth?.startsWith("Bearer ") ? auth.slice(7) : req.headers["x-api-key"];
  if (!AGENT_API_KEY || key !== AGENT_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}
app.use("/api", requireApiKey);
app.get("/health", (_req, res) => {
  res.json({ status: "ok", hostname: process.env.HOSTNAME ?? "unknown", ts: Date.now() });
});
async function runCmd(cmd) {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 1e4 });
    return { stdout: stdout.trim(), stderr: stderr.trim(), ok: true };
  } catch (err) {
    return { stdout: err.stdout?.trim() ?? "", stderr: err.stderr?.trim() ?? err.message, ok: false };
  }
}
async function getServiceStatus(name) {
  const { stdout } = await runCmd(`systemctl is-active ${name} 2>/dev/null`);
  const state = stdout.trim().toLowerCase();
  return {
    name,
    status: state === "active" ? "running" : "stopped"
  };
}
app.get("/api/services", async (_req, res) => {
  try {
    const services = await Promise.all([
      getServiceStatus("nginx"),
      getServiceStatus("fail2ban"),
      getServiceStatus("mariadb")
    ]);
    res.json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/services/:name", async (req, res) => {
  const allowed = ["nginx", "fail2ban", "mariadb", "mysql", "postgresql", "redis"];
  const { name } = req.params;
  if (!allowed.includes(name)) return res.status(400).json({ error: "Service not allowed" });
  try {
    res.json(await getServiceStatus(name));
  } catch (err) {
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
  await new Promise((r) => setTimeout(r, 1500));
  const status = await getServiceStatus(name);
  res.json({ ok: result.ok, stderr: result.stderr, service: status });
});
app.get("/api/banned-ips", async (_req, res) => {
  try {
    const { stdout: jailList } = await runCmd("sudo fail2ban-client status 2>/dev/null | grep -i 'jail list' | cut -d: -f2");
    const jails = jailList.split(",").map((j) => j.trim()).filter(Boolean);
    const bannedIps = [];
    for (const jail of jails) {
      const { stdout } = await runCmd(`sudo fail2ban-client status ${jail} 2>/dev/null`);
      const listLine = stdout.split("\n").find((l) => /banned ip list/i.test(l)) ?? "";
      const ips = listLine.match(/\d+\.\d+\.\d+\.\d+/g) ?? [];
      for (const ip of ips) {
        bannedIps.push({ ip, jail, banTime: (/* @__PURE__ */ new Date()).toISOString() });
      }
    }
    res.json(bannedIps);
  } catch (err) {
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
  const jails = jailList.split(",").map((j) => j.trim()).filter(Boolean);
  let total = 0;
  for (const jail of jails) {
    const { stdout } = await runCmd(`sudo fail2ban-client status ${jail}`);
    const match = stdout.match(/Banned IP list:\s*([\d\.\s,]+)/);
    if (match) {
      const ips = match[1].split(/[\s,]+/).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
      for (const ip of ips) {
        await runCmd(`sudo fail2ban-client set ${jail} unbanip ${ip}`);
        total++;
      }
    }
  }
  res.json({ ok: true, unbannedCount: total, jailsProcessed: jails.length });
});
app.get("/api/stats", async (_req, res) => {
  try {
    const { stdout: connOut } = await runCmd("ss -tn 2>/dev/null | grep -c ':8880' || echo 0");
    const activeConnections = parseInt(connOut.trim()) || 0;
    const { stdout: jailList } = await runCmd("sudo fail2ban-client status 2>/dev/null | grep -i 'jail list' | cut -d: -f2 || echo ''");
    const jails = jailList.split(",").map((j) => j.trim()).filter(Boolean);
    let totalBans24h = 0;
    for (const jail of jails) {
      const { stdout } = await runCmd(`sudo fail2ban-client status ${jail} 2>/dev/null`);
      const match = stdout.match(/Currently banned:\s*(\d+)/i);
      if (match) totalBans24h += parseInt(match[1]);
    }
    res.json({ totalBans24h, activeConnections, blockedCountries: 0, totalRequests24h: 0, topBannedIps: [], bansByCountry: [], banTimeline: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
var LOG_PATHS = {
  nginx_access: "/var/log/nginx/access.log",
  nginx_error: "/var/log/nginx/error.log",
  fail2ban: "/var/log/fail2ban.log",
  system: "/var/log/syslog"
};
app.get("/api/logs/:logType", async (req, res) => {
  const { logType } = req.params;
  const lines = Math.min(parseInt(req.query.lines) || 100, 500);
  const grepRaw = String(req.query.grep ?? "").trim();
  const logPath = LOG_PATHS[logType];
  if (!logPath) return res.status(400).json({ error: "Unknown log type" });
  try {
    await (0, import_promises.access)(logPath, import_fs.constants.R_OK);
    let cmd;
    if (grepRaw.length >= 2) {
      const safe = grepRaw.replace(/[`$\\|;&<>'"!\n\r]/g, "").slice(0, 200);
      cmd = `grep -i -m ${lines} "${safe}" "${logPath}" 2>/dev/null`;
    } else {
      cmd = `tail -n ${lines} "${logPath}"`;
    }
    const { stdout } = await runCmd(cmd);
    const entries = stdout.split("\n").filter(Boolean).map((line, i) => ({
      id: i,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level: line.toLowerCase().includes("error") ? "error" : line.toLowerCase().includes("warn") ? "warn" : "info",
      message: line,
      source: logType
    }));
    res.json(entries.reverse());
  } catch {
    res.json([]);
  }
});
var CONFIG_PATHS = {
  "nginx.conf": "/etc/nginx/nginx.conf",
  "jail.local": "/etc/fail2ban/jail.local",
  "fail2ban.local": "/etc/fail2ban/fail2ban.local",
  "country_whitelist.conf": "/etc/nginx/country_whitelist.conf",
  "block_asn.conf": "/etc/nginx/block_asn.conf",
  "block_isp.conf": "/etc/nginx/block_isp.conf",
  "useragent.rules": "/etc/nginx/useragent.rules",
  "ip_whitelist.conf": "/etc/nginx/ip_whitelist.conf",
  "exclusion_ip.conf": "/etc/nginx/exclusion_ip.conf"
};
app.get("/api/config/:filename", async (req, res) => {
  const filePath = CONFIG_PATHS[req.params.filename];
  if (!filePath) return res.status(400).json({ error: "File not allowed" });
  try {
    const content = await (0, import_promises.readFile)(filePath, "utf-8");
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
    await (0, import_promises.writeFile)(filePath, content, "utf-8");
    if (req.params.filename.startsWith("nginx") || req.params.filename.endsWith(".conf") || req.params.filename.endsWith(".rules")) {
      const test = await runCmd("sudo nginx -t");
      if (!test.ok) {
        return res.status(422).json({ error: `nginx -t failed: ${test.stderr}` });
      }
    }
    res.json({ ok: true, message: `${req.params.filename} updated` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
function parseIpsetList(output) {
  const sets = [];
  const blocks = output.split(/(?=^Name:)/m);
  for (const block of blocks) {
    const nameMatch = block.match(/^Name:\s+(.+)/m);
    const typeMatch = block.match(/^Type:\s+(.+)/m);
    const countMatch = block.match(/^Number of entries:\s+(\d+)/m);
    const membersSection = block.match(/^Members:\n([\s\S]*)/m);
    if (!nameMatch) continue;
    const members = membersSection ? membersSection[1].trim().split("\n").filter(Boolean) : [];
    sets.push({
      name: nameMatch[1].trim(),
      type: typeMatch ? typeMatch[1].trim() : "unknown",
      count: countMatch ? parseInt(countMatch[1]) : members.length,
      members
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
  } catch (err) {
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/ipset/:name/add", async (req, res) => {
  const { name } = req.params;
  const { ip } = req.body;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: "Nome ipset non valido" });
  if (!ip || !/^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(ip)) return res.status(400).json({ error: "IP non valido" });
  const result = await runCmd(`sudo ipset add ${name} ${ip}`);
  res.json({ ok: result.ok, error: result.ok ? void 0 : result.stderr });
});
app.post("/api/ipset/:name/remove", async (req, res) => {
  const { name } = req.params;
  const { ip } = req.body;
  if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: "Nome ipset non valido" });
  if (!ip || !/^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(ip)) return res.status(400).json({ error: "IP non valido" });
  const result = await runCmd(`sudo ipset del ${name} ${ip}`);
  res.json({ ok: result.ok, error: result.ok ? void 0 : result.stderr });
});
app.get("/api/iptables", async (_req, res) => {
  try {
    const { stdout } = await runCmd("sudo iptables -L -n --line-numbers -v 2>/dev/null");
    const chains = [];
    let current = null;
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.delete("/api/iptables/:chain/:linenum", async (req, res) => {
  const { chain, linenum } = req.params;
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(chain)) return res.status(400).json({ error: "Chain non valida" });
  if (!/^\d+$/.test(linenum)) return res.status(400).json({ error: "Numero riga non valido" });
  const result = await runCmd(`sudo iptables -D ${chain} ${linenum}`);
  res.json({ ok: result.ok, error: result.ok ? void 0 : result.stderr });
});
app.post("/api/iptables/:chain/rule", async (req, res) => {
  const { chain } = req.params;
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(chain)) return res.status(400).json({ error: "Chain non valida" });
  const { target, protocol, source, dport, position } = req.body;
  if (!target || !/^(ACCEPT|DROP|REJECT|LOG)$/.test(target)) return res.status(400).json({ error: "Target non valido" });
  const flag = position === "insert" ? "-I" : "-A";
  const parts = [flag, chain];
  if (protocol && /^(tcp|udp|icmp|all)$/.test(protocol)) parts.push("-p", protocol);
  if (source && /^[\d./]+$/.test(source)) parts.push("-s", source);
  if (dport && /^\d+$/.test(dport) && protocol && protocol !== "icmp" && protocol !== "all") parts.push("--dport", dport);
  parts.push("-j", target);
  const result = await runCmd(`sudo iptables ${parts.join(" ")}`);
  res.json({ ok: result.ok, error: result.ok ? void 0 : result.stderr });
});
app.post("/api/iptables/:chain/policy", async (req, res) => {
  const { chain } = req.params;
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(chain)) return res.status(400).json({ error: "Chain non valida" });
  const { policy } = req.body;
  if (!policy || !/^(ACCEPT|DROP)$/.test(policy)) return res.status(400).json({ error: "Policy deve essere ACCEPT o DROP" });
  const result = await runCmd(`sudo iptables -P ${chain} ${policy}`);
  res.json({ ok: result.ok, error: result.ok ? void 0 : result.stderr });
});
app.post("/api/iptables/:chain/flush", async (req, res) => {
  const { chain } = req.params;
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(chain)) return res.status(400).json({ error: "Chain non valida" });
  const result = await runCmd(`sudo iptables -F ${chain}`);
  res.json({ ok: result.ok, error: result.ok ? void 0 : result.stderr });
});
app.post("/api/iptables-save", async (_req, res) => {
  let result = await runCmd("sudo netfilter-persistent save 2>/dev/null");
  if (!result.ok) {
    result = await runCmd("sudo iptables-save | sudo tee /etc/iptables/rules.v4 > /dev/null 2>&1");
  }
  res.json({ ok: result.ok, error: result.ok ? void 0 : result.stderr });
});
app.get("/api/netbird", async (_req, res) => {
  try {
    const [serviceResult, connResult] = await Promise.all([
      runCmd("systemctl is-active netbird 2>/dev/null"),
      runCmd("nc -z -w3 main.netbird.cloud 8880 2>/dev/null && echo ok || echo fail")
    ]);
    res.json({
      running: serviceResult.stdout.trim() === "active",
      connected: connResult.stdout.trim() === "ok"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/netbird/restart", async (_req, res) => {
  const result = await runCmd("sudo systemctl restart netbird");
  res.json({ ok: result.ok, error: result.ok ? void 0 : result.stderr });
});
app.post("/api/netbird/start", async (_req, res) => {
  const result = await runCmd("sudo systemctl start netbird");
  res.json({ ok: result.ok, error: result.ok ? void 0 : result.stderr });
});
app.post("/api/netbird/stop", async (_req, res) => {
  const result = await runCmd("sudo systemctl stop netbird");
  res.json({ ok: result.ok, error: result.ok ? void 0 : result.stderr });
});
app.post("/api/netbird/update", async (_req, res) => {
  const result = await runCmd("sudo netbird update 2>&1");
  await new Promise((r) => setTimeout(r, 2e3));
  const status = await runCmd("systemctl is-active netbird 2>/dev/null");
  res.json({ ok: result.ok, output: result.stdout || result.stderr, running: status.stdout.trim() === "active" });
});
app.get("/api/grep", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const logType = String(req.query.type ?? "nginx_access");
  const lines = Math.min(parseInt(req.query.lines) || 500, 500);
  if (q.length < 2) return res.status(400).json({ error: "Query troppo breve (min 2 caratteri)" });
  const safe = q.replace(/[`$\\|;&<>'"!\n\r]/g, "").slice(0, 200);
  const logPath = LOG_PATHS[logType];
  if (!logPath) return res.status(400).json({ error: "Tipo log sconosciuto" });
  try {
    await (0, import_promises.access)(logPath, import_fs.constants.R_OK);
    const { stdout } = await runCmd(`grep -i -m ${lines} "${safe}" "${logPath}" 2>/dev/null`);
    const entries = stdout.split("\n").filter(Boolean).map((line, i) => ({
      id: i,
      level: line.toLowerCase().includes("error") ? "error" : line.toLowerCase().includes("warn") ? "warn" : "info",
      message: line
    }));
    res.json({ query: safe, logType, count: entries.length, entries });
  } catch {
    res.json({ query: safe, logType, count: 0, entries: [] });
  }
});
var FILTER_DIR = "/etc/fail2ban/filter.d";
app.get("/api/fail2ban/filters", async (_req, res) => {
  try {
    const files = await (0, import_promises.readdir)(FILTER_DIR);
    const names = files.filter((f) => f.endsWith(".conf")).map((f) => import_path.default.basename(f, ".conf"));
    res.json(names);
  } catch {
    res.json([]);
  }
});
app.get("/api/fail2ban/filters/:name", async (req, res) => {
  const filePath = import_path.default.join(FILTER_DIR, `${req.params.name}.conf`);
  try {
    await (0, import_promises.access)(filePath, import_fs.constants.R_OK);
    const content = await (0, import_promises.readFile)(filePath, "utf-8");
    res.json({ name: req.params.name, content, path: filePath });
  } catch {
    res.json({ name: req.params.name, content: "", path: filePath });
  }
});
app.post("/api/fail2ban/filters/:name", async (req, res) => {
  const filePath = import_path.default.join(FILTER_DIR, `${req.params.name}.conf`);
  const { content } = req.body;
  if (typeof content !== "string") return res.status(400).json({ error: "content required" });
  try {
    await (0, import_promises.writeFile)(filePath, content, "utf-8");
    await runCmd("sudo fail2ban-client reload 2>/dev/null || true");
    res.json({ ok: true, message: `Filter ${req.params.name} updated` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/nginx/test", async (_req, res) => {
  const result = await runCmd("sudo nginx -t");
  res.json({ ok: result.ok, output: result.stderr || result.stdout });
});
app.post("/api/nginx/reload", async (_req, res) => {
  const test = await runCmd("sudo nginx -t");
  if (!test.ok) return res.status(422).json({ ok: false, error: test.stderr });
  const result = await runCmd("sudo systemctl reload nginx");
  res.json({ ok: result.ok, error: result.stderr || void 0 });
});
app.get("/api/system", async (_req, res) => {
  const [uptime, memory, disk, load] = await Promise.all([
    runCmd("uptime -p"),
    runCmd(`free -m | awk 'NR==2{printf "%s %s %s", $2,$3,$4}'`),
    runCmd(`df -h / | awk 'NR==2{printf "%s %s %s %s", $2,$3,$4,$5}'`),
    runCmd("cat /proc/loadavg")
  ]);
  const [memTotal, memUsed, memFree] = (memory.stdout || "0 0 0").split(" ").map(Number);
  const [diskTotal, diskUsed, diskFree, diskPercent] = (disk.stdout || "0 0 0 0%").split(" ");
  const loadValues = (load.stdout || "0 0 0").split(" ").slice(0, 3).map(Number);
  res.json({
    uptime: uptime.stdout,
    memory: { total: memTotal, used: memUsed, free: memFree },
    disk: { total: diskTotal, used: diskUsed, free: diskFree, percent: diskPercent },
    load: { "1m": loadValues[0], "5m": loadValues[1], "15m": loadValues[2] },
    hostname: process.env.HOSTNAME ?? "unknown"
  });
});
app.get("/api/fail2ban/jails", async (_req, res) => {
  try {
    const { stdout: jailList } = await runCmd("sudo fail2ban-client status | grep 'Jail list' | cut -d: -f2");
    const jailNames = jailList.split(",").map((j) => j.trim()).filter(Boolean);
    const jails = await Promise.all(jailNames.map(async (name) => {
      const { stdout } = await runCmd(`sudo fail2ban-client status ${name}`);
      const banTimeMatch = stdout.match(/Ban time:\s*(\d+)/);
      const maxRetryMatch = stdout.match(/Max retry:\s*(\d+)/);
      const enabledMatch = stdout.match(/Status.*enabled/i);
      return {
        name,
        enabled: !!enabledMatch,
        banTime: banTimeMatch ? parseInt(banTimeMatch[1]) : 600,
        maxRetry: maxRetryMatch ? parseInt(maxRetryMatch[1]) : 5,
        findTime: 600
      };
    }));
    res.json(jails);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/fail2ban/jails/:name", async (req, res) => {
  const { name } = req.params;
  const { config } = req.body;
  const cmds = [];
  if (config.enabled !== void 0) cmds.push(`sudo fail2ban-client set ${name} ${config.enabled ? "unbanip all" : "banned"}`);
  if (config.banTime !== void 0) cmds.push(`sudo fail2ban-client set ${name} bantime ${config.banTime}`);
  if (config.maxRetry !== void 0) cmds.push(`sudo fail2ban-client set ${name} maxretry ${config.maxRetry}`);
  if (config.findTime !== void 0) cmds.push(`sudo fail2ban-client set ${name} findtime ${config.findTime}`);
  for (const cmd of cmds) await runCmd(cmd);
  res.json({ ok: true, message: `Jail ${name} updated` });
});
app.listen(PORT, BIND, () => {
  console.log(`[ProxyGuardian Agent] Listening on ${BIND}:${PORT}`);
  if (!AGENT_API_KEY) console.warn("[WARN] AGENT_API_KEY not set \u2014 all requests will be rejected");
});
