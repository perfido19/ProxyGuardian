import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { promises as dns } from "dns";
import { parseTorList, validateTorList, filterTorList, parseWhitelist } from "./tor-block-filter";
import { bulkPost, type BulkResult } from "./vps-manager";

const TORLIST_URL = "https://check.torproject.org/torbulkexitlist";
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const STATE_FILE = join(DATA_DIR, "tor-exit-list.json");
const WHITELIST_FILE = join(process.cwd(), "asn-block", "asn-whitelist.txt");

export interface TorListState {
  ips: string[];
  count: number;
  fetchedAt: string | null;
  lastError: string | null;
  removedCount: number;
}

let state: TorListState = { ips: [], count: 0, fetchedAt: null, lastError: null, removedCount: 0 };
let lastPush: BulkResult[] = [];

function loadState(): void {
  try {
    if (existsSync(STATE_FILE)) state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch { /* stato corrotto: si riparte da vuoto, il primo refresh lo ripopola */ }
}
loadState();

function saveState(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state), "utf-8");
  } catch (e: any) {
    console.error("[TorBlock] impossibile salvare lo stato:", e.message);
  }
}

async function defaultFetcher(): Promise<string> {
  const res = await fetch(TORLIST_URL, {
    headers: { "User-Agent": "ProxyGuardian-TorBlock/2.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// I domini in whitelist vengono risolti qui (I/O), non nel modulo filtro che resta puro.
async function resolveWhitelist(): Promise<string[]> {
  let content = "";
  try { content = readFileSync(WHITELIST_FILE, "utf-8"); } catch { return []; }
  const { cidrs, domains } = parseWhitelist(content);
  const resolved: string[] = [];
  await Promise.allSettled(domains.map(async d => {
    try {
      const addrs = await dns.resolve4(d);
      addrs.forEach(a => resolved.push(a + "/32"));
    } catch { /* dominio non risolvibile: si ignora, non deve bloccare il refresh */ }
  }));
  return cidrs.concat(resolved);
}

export async function refreshTorList(fetcher: () => Promise<string> = defaultFetcher): Promise<TorListState> {
  let body: string;
  try {
    body = await fetcher();
  } catch (e: any) {
    state = { ...state, lastError: `fetch fallito: ${e.message}` };
    saveState();
    return state;
  }

  const parsed = parseTorList(body);
  const validation = validateTorList(parsed, state.count);
  if (!validation.ok) {
    state = { ...state, lastError: validation.reason || "lista non valida" };
    saveState();
    return state;
  }

  const whitelist = await resolveWhitelist();
  const { ips, removed } = filterTorList(parsed, whitelist);

  if (removed.length > 10) {
    console.warn(`[TorBlock] ATTENZIONE: il guard ha rimosso ${removed.length} IP: ${removed.slice(0, 10).join(", ")}...`);
  } else if (removed.length > 0) {
    console.log(`[TorBlock] guard: rimossi ${removed.length} IP (${removed.join(", ")})`);
  }

  state = { ips, count: ips.length, fetchedAt: new Date().toISOString(), lastError: null, removedCount: removed.length };
  saveState();
  return state;
}

export function getTorListState(): TorListState {
  return state;
}

export function getLastPush(): BulkResult[] {
  return lastPush;
}

// `vpsIds` serve per il rollout canary: permette di applicare la lista a un solo
// VPS senza toccare la fleet. Con "all" aggiorna anche lo stato dell'ultimo push
// mostrato in UI; con un sottoinsieme no, per non far sembrare desincronizzati
// i VPS semplicemente non coinvolti nel test.
export async function pushTorListToFleet(vpsIds: string[] | "all" = "all"): Promise<BulkResult[]> {
  if (state.ips.length === 0) return [];
  const results = await bulkPost(vpsIds, "/api/tor-block/apply", { ips: state.ips });
  if (vpsIds === "all") lastPush = results;
  return results;
}

export function startTorBlockPoller(intervalMs = 3600000): void {
  const run = () => refreshTorList()
    .then(async s => {
      if (s.lastError) {
        console.error(`[TorBlock] refresh non applicato: ${s.lastError} (in uso lista da ${s.fetchedAt || "mai"})`);
        return;
      }
      const results = await pushTorListToFleet();
      const ok = results.filter(r => r.success).length;
      console.log(`[TorBlock] ${s.count} IP, push ok su ${ok}/${results.length} VPS`);
    })
    .catch(e => console.error("[TorBlock] error:", e));
  setTimeout(() => { run(); setInterval(run, intervalMs); }, 60000);
}

// Usato solo dai test per azzerare lo stato fra un caso e l'altro.
export function __resetTorStateForTest(): void {
  state = { ips: [], count: 0, fetchedAt: null, lastError: null, removedCount: 0 };
}
