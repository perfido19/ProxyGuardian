import * as crypto from "crypto";

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

const vpsStore = new Map<string, VpsConfig>();

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
  return toSafeVps(vps);
}

export function updateVps(id: string, data: Partial<Pick<VpsConfig, "name" | "host" | "port" | "apiKey" | "enabled" | "tags">>): SafeVpsConfig {
  const vps = vpsStore.get(id);
  if (!vps) throw new Error("VPS non trovato");
  Object.assign(vps, data);
  return toSafeVps(vps);
}

export function deleteVps(id: string): void {
  if (!vpsStore.has(id)) throw new Error("VPS non trovato");
  vpsStore.delete(id);
}

const REQUEST_TIMEOUT = 10000;

async function agentFetch(vps: VpsConfig, path: string, options: RequestInit = {}): Promise<Response> {
  const url = `http://${vps.host}:${vps.port}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    return await fetch(url, {
      ...options, signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-api-key": vps.apiKey, ...(options.headers || {}) },
    });
  } finally { clearTimeout(timer); }
}

export async function agentGet(vps: VpsConfig, path: string): Promise<any> {
  const res = await agentFetch(vps, path);
  if (!res.ok) throw new Error(`Agent ${vps.name}: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function agentPost(vps: VpsConfig, path: string, body: any): Promise<any> {
  const res = await agentFetch(vps, path, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) { const text = await res.text(); throw new Error(`Agent ${vps.name}: ${res.status} - ${text}`); }
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
