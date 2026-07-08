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

export async function syncIptvBanFleet(): Promise<BanSyncResult> {
  // Salta VPS offline per non appesantire il ciclo
  const enabled = Array.from(vpsStore.values()).filter(v => v.enabled && v.lastStatus !== "offline");

  // 1. Pull iptv_ban da tutti i VPS in parallelo
  const pullResults = await Promise.allSettled(
    enabled.map(async vps => {
      try {
        const data = await agentGet(vps, "/api/ipset/iptv_ban?limit=10000", 15000);
        const members: string[] = (data.members || []).map((m: string) => m.split(" ")[0]).filter((ip: string) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
        return { vpsId: vps.id, ips: members };
      } catch {
        return { vpsId: vps.id, ips: [] };
      }
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