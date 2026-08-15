import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { bulkPost, type BulkResult } from "./vps-manager";

// Lista statica, curata a mano: IP di internet-wide scanner (Shodan/ZoomEye/FOFA/
// Quake) che NON sono gia' coperti dalla blocklist ASN esistente. Analisi completa
// (incrocio con asn-block/asn-blocklist.txt via whois) nella memoria di sessione
// del 2026-08-15. A differenza del Tor exit block, non c'e' un fetch/poller: la
// lista non cambia abbastanza spesso da giustificarlo, si aggiorna a mano quando
// serve (stesso pattern di asn-block/asn-blocklist.txt).

const LIST_FILE = join(process.cwd(), "asn-block", "scanner-ips-blocklist.txt");

let lastPush: BulkResult[] = [];

export function loadScannerBlockIps(): string[] {
  if (!existsSync(LIST_FILE)) return [];
  const content = readFileSync(LIST_FILE, "utf-8");
  const ips: string[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const ip = line.split(/\s+/)[0];
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) ips.push(ip);
  }
  return ips;
}

export function getScannerBlockState() {
  const ips = loadScannerBlockIps();
  return { count: ips.length, push: lastPush };
}

// `vpsIds` per il rollout canary, stesso schema del Tor block.
export async function pushScannerBlockToFleet(vpsIds: string[] | "all" = "all"): Promise<BulkResult[]> {
  const ips = loadScannerBlockIps();
  if (ips.length === 0) return [];
  const results = await bulkPost(vpsIds, "/api/scanner-block/apply", { ips });
  if (vpsIds === "all") lastPush = results;
  return results;
}
