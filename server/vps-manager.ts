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

const REQUEST_TIMEOUT = 10000;
export const SLOW_REQUEST_TIMEOUT = 120000;

export const SLOW_PATHS = ["/api/asn/update-lists", "/api/asn/update-set"];

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

export async function checkVpsHealth(vps: VpsConfig): Promise<boolean> {
  try {
    const res = await agentFetch(vps, "/health");
    const online = res.ok;
    vps.lastSeen = online ? new Date().toISOString() : vps.lastSeen;
    vps.lastStatus = online ? "online" : "offline";
    return online;
  } catch { vps.lastStatus = "offline"; return false; }
}

export async function checkAllVpsHealth(): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  const enabled = Array.from(vpsStore.values()).filter(v => v.enabled);
  await Promise.allSettled(enabled.map(async vps => {
    results.set(vps.id, await checkVpsHealth(vps));
  }));
  return results;
}

export interface BulkResult {
  vpsId: string; vpsName: string; success: boolean; data?: any; error?: string;
}

export async function bulkPost(vpsIds: string[] | "all", path: string, body: any): Promise<BulkResult[]> {
  const targets = vpsIds === "all"
    ? Array.from(vpsStore.values()).filter(v => v.enabled)
    : vpsIds.map(id => vpsStore.get(id)).filter((v): v is VpsConfig => !!v && v.enabled);
  const results = await Promise.allSettled(targets.map(async vps => {
    try { return { vpsId: vps.id, vpsName: vps.name, success: true, data: await agentPost(vps, path, body) }; }
    catch (e: any) { return { vpsId: vps.id, vpsName: vps.name, success: false, error: e.message }; }
  }));
  return results.map(r => r.status === "fulfilled" ? r.value : { vpsId: "unknown", vpsName: "unknown", success: false, error: "rejected" });
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

export async function bulkGet(vpsIds: string[] | "all", path: string): Promise<BulkResult[]> {
  const targets = vpsIds === "all"
    ? Array.from(vpsStore.values()).filter(v => v.enabled)
    : vpsIds.map(id => vpsStore.get(id)).filter((v): v is VpsConfig => !!v && v.enabled);
  const results = await Promise.allSettled(targets.map(async vps => {
    try { return { vpsId: vps.id, vpsName: vps.name, success: true, data: await agentGet(vps, path) }; }
    catch (e: any) { return { vpsId: vps.id, vpsName: vps.name, success: false, error: e.message }; }
  }));
  return results.map(r => r.status === "fulfilled" ? r.value : { vpsId: "unknown", vpsName: "unknown", success: false, error: "rejected" });
}
