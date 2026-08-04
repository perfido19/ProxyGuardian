// Validazione e filtro della lista Tor exit-node.
// Funzioni pure: nessun I/O, nessuna risoluzione DNS, testabili in isolamento.

const MIN_VALID_IPS = 50;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isValidIpv4(s: string): boolean {
  const m = IPV4_RE.exec(s);
  if (!m) return false;
  return [m[1], m[2], m[3], m[4]].every(o => {
    const n = Number(o);
    return n >= 0 && n <= 255 && String(n) === o;
  });
}

export function parseTorList(body: string): string[] {
  return body
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith("#"))
    .filter(isValidIpv4);
}

export function validateTorList(ips: string[], previousCount: number): { ok: boolean; reason?: string } {
  if (ips.length < MIN_VALID_IPS) {
    return { ok: false, reason: `lista sospetta: ${ips.length} IP validi, minimo ${MIN_VALID_IPS}` };
  }
  if (previousCount > 0 && ips.length < Math.floor(previousCount / 2)) {
    return { ok: false, reason: `lista sospetta: ${ips.length} IP contro ${previousCount} precedenti (calo oltre il 50%)` };
  }
  return { ok: true };
}

export function parseWhitelist(content: string): { cidrs: string[]; domains: string[] } {
  const cidrs: string[] = [];
  const domains: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    if (line.startsWith("domain:")) {
      const d = line.slice("domain:".length).trim();
      if (d && !d.startsWith("*.")) domains.push(d);
    } else {
      cidrs.push(line);
    }
  }
  return { cidrs, domains };
}

interface Cidr { base: number; mask: number; }

function ipToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

function parseCidr(entry: string): Cidr | null {
  const [addr, bitsRaw] = entry.split("/");
  if (!isValidIpv4(addr)) return null;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (ipToInt(addr) & mask) >>> 0, mask };
}

// Reti che non devono MAI finire in tor_exit, a prescindere da cosa dice l'upstream.
// Un exit node Tor non dovrebbe mai essere uno di questi IP, ma il 2026-07-08 l'IP
// della dashboard e' finito nell'ipset iptv_ban su 52 VPS su 54 e ha causato mesi di
// instabilita' NetBird attribuita ad altro: il filtro va messo comunque.
export const HARD_GUARD_NETS = [
  "100.64.0.0/10",      // intera mesh NetBird (dashboard, tutti i VPS, main backend)
  "185.229.236.50/32",  // dashboard, IP pubblico
  "80.244.4.35/32",     // main backend xtreamcodes
];

export function filterTorList(ips: string[], extraWhitelist: string[] = []): { ips: string[]; removed: string[] } {
  const nets = HARD_GUARD_NETS.concat(extraWhitelist)
    .map(parseCidr)
    .filter((c): c is Cidr => c !== null);
  const kept: string[] = [];
  const removed: string[] = [];
  for (const ip of ips) {
    if (nets.some(n => ((ipToInt(ip) & n.mask) >>> 0) === n.base)) removed.push(ip);
    else kept.push(ip);
  }
  return { ips: kept, removed };
}
