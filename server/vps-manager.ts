import * as crypto from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { readFile } from "fs/promises";

export interface VpsConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  apiKey: string;
  enabled: boolean;
  tags: string[];
  createdAt: string;
  lastSeen?: string;
  lastStatus?: "online" | "offline" | "unknown";
}

export type SafeVpsConfig = Omit<VpsConfig, "apiKey"> & { apiKey: "***" };

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
const VPS_FILE = join(DATA_DIR, "vps.json");

export const CROWDSEC_PACKAGES_DIR = join(DATA_DIR, "crowdsec-packages");
const CROWDSEC_PACKAGES_MANIFEST = join(CROWDSEC_PACKAGES_DIR, "manifest.json");

export interface CrowdsecPackageManifest {
  version: string;
  downloadedAt: string;
}

export function getCrowdsecPackageManifest(): CrowdsecPackageManifest | null {
  if (!existsSync(CROWDSEC_PACKAGES_MANIFEST)) return null;
  try {
    return JSON.parse(readFileSync(CROWDSEC_PACKAGES_MANIFEST, "utf-8"));
  } catch {
    return null;
  }
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadVpsStore(): Map<string, VpsConfig> {
  ensureDataDir();
  try {
    if (existsSync(VPS_FILE)) {
      const raw = readFileSync(VPS_FILE, "utf-8");
      const arr: VpsConfig[] = JSON.parse(raw);
      return new Map(arr.map(v => [v.id, v]));
    }
  } catch (e) {
    console.error("[VpsManager] Failed to load vps.json:", e);
  }
  return new Map();
}

function saveVpsStore() {
  ensureDataDir();
  try {
    const arr = Array.from(vpsStore.values());
    writeFileSync(VPS_FILE, JSON.stringify(arr, null, 2), "utf-8");
  } catch (e) {
    console.error("[VpsManager] Failed to save vps.json:", e);
  }
}

const vpsStore = loadVpsStore();

function generateId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export function toSafeVps(vps: VpsConfig): SafeVpsConfig {
  return { ...vps, apiKey: "***" };
}

export function getAllVps(): SafeVpsConfig[] {
  return Array.from(vpsStore.values()).map(toSafeVps);
}

export function getVpsById(id: string): VpsConfig | undefined {
  return vpsStore.get(id);
}

export function createVps(data: { name: string; host: string; port?: number; apiKey: string; tags?: string[] }): SafeVpsConfig {
  const vps: VpsConfig = {
    id: generateId(), name: data.name, host: data.host,
    port: data.port || 3001, apiKey: data.apiKey, enabled: true,
    tags: data.tags || [], createdAt: new Date().toISOString(), lastStatus: "unknown",
  };
  vpsStore.set(vps.id, vps);
  saveVpsStore();
  return toSafeVps(vps);
}

export function updateVps(id: string, data: Partial<Pick<VpsConfig, "name" | "host" | "port" | "apiKey" | "enabled" | "tags">>): SafeVpsConfig {
  const vps = vpsStore.get(id);
  if (!vps) throw new Error("VPS non trovato");
  Object.assign(vps, data);
  saveVpsStore();
  return toSafeVps(vps);
}

export function deleteVps(id: string): void {
  if (!vpsStore.has(id)) throw new Error("VPS non trovato");
  vpsStore.delete(id);
  saveVpsStore();
}

const REQUEST_TIMEOUT = 5000;
const HEALTH_TIMEOUT = 8000;
const HEALTH_RETRY_DELAY = 4000;
const HEALTH_OFFLINE_THRESHOLD = 2;
export const SLOW_REQUEST_TIMEOUT = 120000;

const consecutiveFailures = new Map<string, number>();

export const SLOW_PATHS = [
  "/api/asn/update-lists",
  "/api/asn/update-set",
  "/api/unban-all",
  "/api/unban-jail",
  "/api/banned-ips",
  "/api/fail2ban/jails",
  "/api/system/antibrute-stats",
  "/api/crowdsec/install",
  "/api/crowdsec/metrics",
  // L'apply Tor fa restore di ~1400 IP, swap, operazioni iptables e un `ipset save`
  // che dumpa TUTTI i set (blocked_asn ha 138K-203K entry, output di svariati MB).
  // Con i 5s di default l'agent completa il lavoro ma il fetch viene abortito prima
  // della risposta, e il push risulta "fetch failed" pur essendo andato a buon fine.
  "/api/tor-block/apply",
];

async function agentFetch(vps: VpsConfig, path: string, options: RequestInit = {}, timeout = REQUEST_TIMEOUT): Promise<Response> {
  const url = `http://${vps.host}:${vps.port}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, {
      ...options, signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-api-key": vps.apiKey, ...(options.headers || {}) },
    });
  } finally { clearTimeout(timer); }
}

export async function agentGet(vps: VpsConfig, path: string, timeout?: number): Promise<any> {
  const res = await agentFetch(vps, path, {}, timeout);
  if (!res.ok) throw new Error(`Agent ${vps.name}: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function agentPost(vps: VpsConfig, path: string, body: any, timeout = REQUEST_TIMEOUT): Promise<any> {
  const res = await agentFetch(vps, path, { method: "POST", body: JSON.stringify(body) }, timeout);
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try { const parsed = JSON.parse(text); msg = parsed.error || parsed.message || text; } catch {}
    throw new Error(`${vps.name}: ${msg}`);
  }
  return res.json();
}

export async function agentDelete(vps: VpsConfig, path: string, timeout = REQUEST_TIMEOUT): Promise<any> {
  const res = await agentFetch(vps, path, { method: "DELETE" }, timeout);
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try { const parsed = JSON.parse(text); msg = parsed.error || parsed.message || text; } catch {}
    throw new Error(`${vps.name}: ${msg}`);
  }
  return res.json();
}

export async function checkVpsHealth(vps: VpsConfig): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await agentFetch(vps, "/health", {}, HEALTH_TIMEOUT);
      if (res.ok) {
        vps.lastSeen = new Date().toISOString();
        vps.lastStatus = "online";
        consecutiveFailures.set(vps.id, 0);
        return true;
      }
    } catch {}
    if (attempt === 0) await new Promise(r => setTimeout(r, HEALTH_RETRY_DELAY));
  }
  const fails = (consecutiveFailures.get(vps.id) || 0) + 1;
  consecutiveFailures.set(vps.id, fails);
  if (fails >= HEALTH_OFFLINE_THRESHOLD) {
    vps.lastStatus = "offline";
  }
  return false;
}

export async function checkAllVpsHealth(): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  const enabled = Array.from(vpsStore.values()).filter(v => v.enabled);
  await Promise.allSettled(enabled.map(async vps => {
    results.set(vps.id, await checkVpsHealth(vps));
  }));
  lastPollTime = new Date();
  saveVpsStore();
  return results;
}

let lastPollTime: Date | null = null;

export function getLastPollTime(): Date | null { return lastPollTime; }

export function getHealthFromCache(): Map<string, boolean> {
  const results = new Map<string, boolean>();
  for (const vps of vpsStore.values()) {
    if (vps.enabled) results.set(vps.id, vps.lastStatus === "online");
  }
  return results;
}

export function startHealthPoller(intervalMs = 60000): void {
  checkAllVpsHealth().catch(e => console.error("[HealthPoller] poll error:", e));
  setInterval(() => {
    checkAllVpsHealth().catch(e => console.error("[HealthPoller] poll error:", e));
  }, intervalMs);
}

export interface BanSyncResult {
  totalUniqueIps: number;
  propagated: number;
  vpsUpdated: number;
  errors: number;
  ips: string[];
}

const BANSYNC_MAX_PER_VPS = 50;

// Jail il cui ban locale viene promosso a ban fleet-wide via BanSync — solo
// quelle a basso rischio di falsi positivi CGNAT (non 404-0/sshd/block22).
// Richiesta esplicita dell'utente 2026-08-26, solo ban recenti (30 min) per
// evitare di ripropagare ogni ciclo tutto lo storico ban del jail.
const FLEET_SYNCED_JAILS = new Set(["nginx-abuse", "xtream-api"]);
const FLEET_SYNCED_JAIL_MAX_AGE_MS = 30 * 60 * 1000;

export async function syncIptvBanFleet(): Promise<BanSyncResult> {
  // Salta VPS offline per non appesantire il ciclo
  const enabled = Array.from(vpsStore.values()).filter(v => v.enabled && v.lastStatus !== "offline");

  // 1. Pull iptv_ban + ban recenti delle jail selezionate da tutti i VPS in parallelo
  const pullResults = await Promise.allSettled(
    enabled.map(async vps => {
      const ips = new Set<string>();
      try {
        const data = await agentGet(vps, "/api/ipset/iptv_ban?limit=10000", 15000);
        const members: string[] = (data.members || []).map((m: string) => m.split(" ")[0]).filter((ip: string) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
        members.forEach(ip => ips.add(ip));
      } catch { /* ipset non raggiungibile, ignora */ }
      try {
        const banned: Array<{ ip: string; jail: string; banTime: string }> = await agentGet(vps, "/api/banned-ips", 15000);
        const now = Date.now();
        for (const b of banned || []) {
          if (!FLEET_SYNCED_JAILS.has(b.jail)) continue;
          const age = now - new Date(b.banTime).getTime();
          if (age >= 0 && age <= FLEET_SYNCED_JAIL_MAX_AGE_MS) ips.add(b.ip);
        }
      } catch { /* fail2ban non raggiungibile, ignora */ }
      return { vpsId: vps.id, ips: [...ips] };
    })
  );

  // 2. Unione di tutti gli IP bannati nella fleet (esclude il range NetBird 100.64.0.0/10 —
  //    non deve mai propagarsi un self-ban della rete di gestione fleet)
  const isNetbirdRangeIp = (ip: string): boolean => {
    const octets = ip.split(".").map(Number);
    return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  };
  const allBannedIps = new Set<string>();
  const vpsBanMap = new Map<string, Set<string>>();
  for (let i = 0; i < pullResults.length; i++) {
    const r = pullResults[i];
    const vps = enabled[i];
    const ips = (r.status === "fulfilled" ? r.value.ips : []).filter(ip => !isNetbirdRangeIp(ip));
    vpsBanMap.set(vps.id, new Set(ips));
    ips.forEach(ip => allBannedIps.add(ip));
  }

  // 3. Propaga IP mancanti a ogni VPS (max BANSYNC_MAX_PER_VPS per ciclo per non saturare)
  let propagated = 0;
  let vpsUpdated = 0;
  let errors = 0;

  await Promise.allSettled(
    enabled.map(async vps => {
      const existing = vpsBanMap.get(vps.id) || new Set();
      const missing = [...allBannedIps].filter(ip => !existing.has(ip)).slice(0, BANSYNC_MAX_PER_VPS);
      if (missing.length === 0) return;
      let pushed = 0;
      for (const ip of missing) {
        try {
          await agentPost(vps, "/api/ipset/iptv_ban/add", { ip });
          pushed++;
        } catch {
          errors++;
        }
      }
      if (pushed > 0) {
        propagated += pushed;
        vpsUpdated++;
      }
    })
  );

  return { totalUniqueIps: allBannedIps.size, propagated, vpsUpdated, errors, ips: [...allBannedIps] };
}

export function startBanSyncPoller(intervalMs = 300000): void {
  // Prima sync dopo 30s dall'avvio (lascia tempo all'health poller), poi ogni intervalMs
  setTimeout(() => {
    syncIptvBanFleet().then(r => console.log(`[BanSync] ${r.totalUniqueIps} IP totali, propagati ${r.propagated} a ${r.vpsUpdated} VPS`))
      .catch(e => console.error("[BanSync] error:", e));
    setInterval(() => {
      syncIptvBanFleet().then(r => console.log(`[BanSync] ${r.totalUniqueIps} IP totali, propagati ${r.propagated} a ${r.vpsUpdated} VPS`))
        .catch(e => console.error("[BanSync] error:", e));
    }, intervalMs);
  }, 30000);
}

export interface EstablishedSyncResult {
  checked: number;
  fixed: number;
  errors: number;
  details: Array<{ vpsId: string; vpsName: string; changed: boolean; position: number | null; error?: string }>;
}

// Ri-asserisce su tutta la fleet la regola ACCEPT RELATED,ESTABLISHED generica.
// Non e' un fix una tantum: la regola viene rimossa a runtime da causa non identificata
// (39 VPS su 52 la avevano persa il 2026-08-04 pur avendola salvata in rules.v4).
export async function ensureEstablishedFleet(): Promise<EstablishedSyncResult> {
  const enabled = Array.from(vpsStore.values()).filter(v => v.enabled && v.lastStatus !== "offline");
  const details: EstablishedSyncResult["details"] = [];
  let fixed = 0;
  let errors = 0;

  await Promise.allSettled(enabled.map(async vps => {
    try {
      const r = await agentPost(vps, "/api/firewall/ensure-established", {}, 20000);
      if (r && r.changed) fixed++;
      details.push({ vpsId: vps.id, vpsName: vps.name, changed: !!(r && r.changed), position: r ? r.position : null });
    } catch (e: any) {
      errors++;
      details.push({ vpsId: vps.id, vpsName: vps.name, changed: false, position: null, error: e.message });
    }
  }));

  return { checked: enabled.length, fixed, errors, details };
}

export function startEstablishedPoller(intervalMs = 3600000): void {
  const run = () => ensureEstablishedFleet()
    .then(r => {
      if (r.fixed > 0 || r.errors > 0) {
        console.log(`[Established] controllati ${r.checked}, ripristinati ${r.fixed}, errori ${r.errors}`);
      }
    })
    .catch(e => console.error("[Established] error:", e));
  setTimeout(() => { run(); setInterval(run, intervalMs); }, 45000);
}

export interface ComplianceSyncResult {
  checked: number;
  fixed: number;
  errors: number;
  details: Array<{
    vpsId: string; vpsName: string;
    udp51820: boolean; journald: boolean; crowdsecBouncer: boolean;
    error?: string;
  }>;
}

// Ri-verifica fleet-wide 3 fix che si sono rivelati capaci di regredire nel tempo
// senza che nessun poller se ne accorgesse (scoperto 2026-08-10: UDP51820 mancante
// su 50/54, journald cap su 26/54, bouncer CrowdSec spento su 42/54). Non installa
// CrowdSec dove manca — solo riabilita il bouncer se il pacchetto e' gia' presente.
export async function ensureComplianceFleet(): Promise<ComplianceSyncResult> {
  const enabled = Array.from(vpsStore.values()).filter(v => v.enabled && v.lastStatus !== "offline");
  const details: ComplianceSyncResult["details"] = [];
  let fixed = 0;
  let errors = 0;

  await Promise.allSettled(enabled.map(async vps => {
    try {
      const r = await agentPost(vps, "/api/compliance/ensure", {}, 25000);
      const udp = !!(r && r.udp51820 && r.udp51820.changed);
      const jrn = !!(r && r.journald && r.journald.changed);
      const bnc = !!(r && r.crowdsecBouncer && r.crowdsecBouncer.changed);
      if (udp || jrn || bnc) fixed++;
      details.push({ vpsId: vps.id, vpsName: vps.name, udp51820: udp, journald: jrn, crowdsecBouncer: bnc });
    } catch (e: any) {
      errors++;
      details.push({ vpsId: vps.id, vpsName: vps.name, udp51820: false, journald: false, crowdsecBouncer: false, error: e.message });
    }
  }));

  return { checked: enabled.length, fixed, errors, details };
}

export function startCompliancePoller(intervalMs = 3600000): void {
  const run = () => ensureComplianceFleet()
    .then(r => {
      if (r.fixed > 0 || r.errors > 0) {
        console.log(`[Compliance] controllati ${r.checked}, ripristinati ${r.fixed}, errori ${r.errors}`);
      }
    })
    .catch(e => console.error("[Compliance] error:", e));
  setTimeout(() => { run(); setInterval(run, intervalMs); }, 60000);
}

export interface MultiVpsProbeResult {
  vpsChecked: number;
  suspiciousIps: Array<{ ip: string; vpsHit: number; usernames: string[] }>;
  banned: string[];
  errors: number;
}

export interface MultiVpsDetection {
  ip: string;
  vpsHit: number;
  vpsNames: string[];
  usernames: string[];
  firstSeen: string;
  lastSeen: string;
  banned: boolean;
}

// Storico in-memory delle rilevazioni (si azzera al restart, va bene: una
// minaccia ancora attiva viene ri-rilevata al ciclo successivo del poller).
const multiVpsDetections = new Map<string, MultiVpsDetection>();

export function getMultiVpsDetections(): MultiVpsDetection[] {
  return Array.from(multiVpsDetections.values()).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

export function clearMultiVpsDetection(ip: string): void {
  multiVpsDetections.delete(ip);
}

const MULTIVPS_PROBE_MIN_VPS = 3;
const MULTIVPS_PROBE_LINES_PER_VPS = 300;

// Rileva credential-stuffing distribuito: stesso IP colpisce 3+ VPS distinti
// con username DIVERSO su ognuno (nessun username condiviso tra i VPS). Un
// cliente CGNAT legittimo riusa lo stesso account su piu' IP - non username
// diverso per ogni VPS - quindi questa firma esclude quel falso positivo.
// Fail2ban/CrowdSec locali non scattano mai su questo pattern perche' ogni
// agent vede solo 1-2 richieste sul proprio VPS, sotto qualsiasi soglia
// locale sensata (vedi memoria project_multivps_correlation_todo_2026-08-24).
export async function detectMultiVpsCredentialStuffing(): Promise<MultiVpsProbeResult> {
  const enabled = Array.from(vpsStore.values()).filter(v => v.enabled && v.lastStatus !== "offline");

  // ip -> vpsId -> Set<username>
  const ipMap = new Map<string, Map<string, Set<string>>>();

  await Promise.allSettled(enabled.map(async vps => {
    try {
      const entries: Array<{ message: string }> = await agentGet(
        vps,
        `/api/logs/nginx_access?grep=${encodeURIComponent("username=")}&lines=${MULTIVPS_PROBE_LINES_PER_VPS}`,
        15000
      );
      const ipRe = /^(\d{1,3}(?:\.\d{1,3}){3})/;
      const userRe = /[?&]username=([^&\s"*]+)/;
      for (const e of entries || []) {
        const line = e.message || "";
        const ipM = ipRe.exec(line);
        const userM = userRe.exec(line);
        if (!ipM || !userM) continue;
        const ip = ipM[1];
        const user = userM[1];
        if (!ipMap.has(ip)) ipMap.set(ip, new Map());
        const perVps = ipMap.get(ip)!;
        if (!perVps.has(vps.id)) perVps.set(vps.id, new Set());
        perVps.get(vps.id)!.add(user);
      }
    } catch { /* vps irraggiungibile in questo ciclo, salta */ }
  }));

  const isNetbirdRangeIp = (ip: string): boolean => {
    const octets = ip.split(".").map(Number);
    return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  };

  const vpsNameById = new Map(enabled.map(v => [v.id, v.name]));
  const suspicious: Array<{ ip: string; vpsHit: number; usernames: string[]; vpsNames: string[] }> = [];
  for (const [ip, perVps] of ipMap) {
    if (isNetbirdRangeIp(ip)) continue;
    if (perVps.size < MULTIVPS_PROBE_MIN_VPS) continue;

    // firma: nessun username condiviso tra due VPS diversi per questo IP
    const usernameCounts = new Map<string, number>();
    for (const set of perVps.values()) {
      for (const u of set) usernameCounts.set(u, (usernameCounts.get(u) || 0) + 1);
    }
    const anyReused = [...usernameCounts.values()].some(c => c > 1);
    if (anyReused) continue;

    const usernames = [...usernameCounts.keys()];
    const vpsNames = [...perVps.keys()].map(id => vpsNameById.get(id) || id);
    suspicious.push({ ip, vpsHit: perVps.size, usernames, vpsNames });
  }

  const banned: string[] = [];
  let errors = 0;
  const now = new Date().toISOString();
  for (const s of suspicious) {
    let isBanned = false;
    try {
      const results = await Promise.allSettled(enabled.map(vps => agentPost(vps, "/api/ipset/iptv_ban/add", { ip: s.ip })));
      if (results.some(r => r.status === "fulfilled")) { banned.push(s.ip); isBanned = true; }
      else errors++;
    } catch {
      errors++;
    }
    const existing = multiVpsDetections.get(s.ip);
    multiVpsDetections.set(s.ip, {
      ip: s.ip,
      vpsHit: s.vpsHit,
      vpsNames: s.vpsNames,
      usernames: s.usernames,
      firstSeen: existing?.firstSeen || now,
      lastSeen: now,
      banned: isBanned || existing?.banned || false,
    });
  }

  return { vpsChecked: enabled.length, suspiciousIps: suspicious.map(({ ip, vpsHit, usernames }) => ({ ip, vpsHit, usernames })), banned, errors };
}

export function startMultiVpsProbePoller(intervalMs = 120000): void {
  const run = () => detectMultiVpsCredentialStuffing()
    .then(r => {
      if (r.suspiciousIps.length > 0) {
        console.log(`[MultiVpsProbe] rilevati ${r.suspiciousIps.length} IP sospetti, bannati ${r.banned.length}: ${r.banned.join(", ")}`);
      }
    })
    .catch(e => console.error("[MultiVpsProbe] error:", e));
  setTimeout(() => { run(); setInterval(run, intervalMs); }, 90000);
}

export interface BulkResult {
  vpsId: string; vpsName: string; success: boolean; data?: any; error?: string;
}

export async function bulkPost(vpsIds: string[] | "all", path: string, body: any, skipOffline = true): Promise<BulkResult[]> {
  const all = vpsIds === "all"
    ? Array.from(vpsStore.values()).filter(v => v.enabled)
    : vpsIds.map(id => vpsStore.get(id)).filter((v): v is VpsConfig => !!v && v.enabled);
  const offline = skipOffline ? all.filter(v => v.lastStatus === "offline") : [];
  const targets = skipOffline ? all.filter(v => v.lastStatus !== "offline") : all;
  const timeout = SLOW_PATHS.includes(path) ? SLOW_REQUEST_TIMEOUT : undefined;
  const results = await Promise.allSettled(targets.map(async vps => {
    try { return { vpsId: vps.id, vpsName: vps.name, success: true, data: await agentPost(vps, path, body, timeout) }; }
    catch (e: any) { return { vpsId: vps.id, vpsName: vps.name, success: false, error: e.message }; }
  }));
  const offlineResults: BulkResult[] = offline.map(v => ({ vpsId: v.id, vpsName: v.name, success: false, error: "offline (skip)" }));
  return [...results.map(r => r.status === "fulfilled" ? r.value : { vpsId: "unknown", vpsName: "unknown", success: false, error: "rejected" }), ...offlineResults];
}

export async function agentUpdate(vps: VpsConfig, bundle: Buffer): Promise<{ ok: boolean; message?: string; error?: string }> {
  const url = `http://${vps.host}:${vps.port}/api/agent/update`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/octet-stream", "x-api-key": vps.apiKey },
      body: bundle,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `${res.status} - ${text}` };
    }
    return res.json();
  } catch (e: any) {
    clearTimeout(timer);
    return { ok: false, error: e.message };
  }
}

export async function agentUploadPackage(vps: VpsConfig, name: "crowdsec" | "bouncer", buf: Buffer): Promise<void> {
  const url = `http://${vps.host}:${vps.port}/api/agent/crowdsec-package`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/octet-stream", "x-api-key": vps.apiKey, "x-package-name": name },
      body: buf,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${vps.name}: upload ${name} fallito - ${res.status} ${text}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function bulkAgentUpdate(vpsIds: string[] | "all"): Promise<BulkResult[]> {
  const bundlePath = join(process.cwd(), "agent", "agent-bundle.js");
  let bundle: Buffer;
  try {
    bundle = Buffer.from(await readFile(bundlePath));
  } catch (e: any) {
    return [{ vpsId: "all", vpsName: "all", success: false, error: `Bundle non trovato: ${e.message}` }];
  }
  const targets = vpsIds === "all"
    ? Array.from(vpsStore.values()).filter(v => v.enabled)
    : vpsIds.map(id => vpsStore.get(id)).filter((v): v is VpsConfig => !!v && v.enabled);
  const results = await Promise.allSettled(targets.map(async vps => {
    try {
      const result = await agentUpdate(vps, bundle);
      return { vpsId: vps.id, vpsName: vps.name, success: result.ok, data: result, error: result.error };
    } catch (e: any) {
      return { vpsId: vps.id, vpsName: vps.name, success: false, error: e.message };
    }
  }));
  return results.map(r => r.status === "fulfilled" ? r.value : { vpsId: "unknown", vpsName: "unknown", success: false, error: "rejected" });
}

export async function bulkGet(vpsIds: string[] | "all", path: string, skipOffline = true): Promise<BulkResult[]> {
  const all = vpsIds === "all"
    ? Array.from(vpsStore.values()).filter(v => v.enabled)
    : vpsIds.map(id => vpsStore.get(id)).filter((v): v is VpsConfig => !!v && v.enabled);
  const offline = skipOffline ? all.filter(v => v.lastStatus === "offline") : [];
  const targets = skipOffline ? all.filter(v => v.lastStatus !== "offline") : all;
  const results = await Promise.allSettled(targets.map(async vps => {
    try { return { vpsId: vps.id, vpsName: vps.name, success: true, data: await agentGet(vps, path) }; }
    catch (e: any) { return { vpsId: vps.id, vpsName: vps.name, success: false, error: e.message }; }
  }));
  const offlineResults: BulkResult[] = offline.map(v => ({ vpsId: v.id, vpsName: v.name, success: false, error: "offline (skip)" }));
  return [...results.map(r => r.status === "fulfilled" ? r.value : { vpsId: "unknown", vpsName: "unknown", success: false, error: "rejected" }), ...offlineResults];
}