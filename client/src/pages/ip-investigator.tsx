import { useState, useEffect } from "react";
import { useSearch } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Search, ShieldBan, ShieldCheck, AlertTriangle, Globe, User, Server, RefreshCw, XCircle, CheckCircle2, Shield, Unlock } from "lucide-react";

interface VpsHit {
  vpsId: string;
  vpsName: string;
  count: number;
  usernames: string[];
  paths: string[];
  statuses: string[];
  ua: string | null;
  banned: boolean;
  sample: string[];
  usernameStats: Record<string, Record<string, number>>;
}

interface InvestigateResult {
  ip: string;
  totalVps: number;
  totalRequests: number;
  allUsernames: string[];
  allUsernameStats: Record<string, Record<string, number>>;
  geoInfo: { asn?: string; org?: string; countryCode?: string } | null;
  vpsResults: VpsHit[];
}

function statusColor(s: string) {
  if (s === "200") return "text-green-500";
  if (s === "400") return "text-orange-400";
  return "text-yellow-400";
}

function statusBadgeClass(s: string) {
  if (s === "200") return "bg-green-500/20 text-green-400 border-green-500/30";
  if (s === "503") return "bg-red-500/20 text-red-400 border-red-500/30";
  if (s === "403") return "bg-orange-500/20 text-orange-400 border-orange-500/30";
  if (s.startsWith("2")) return "bg-green-500/10 text-green-400 border-green-500/20";
  if (s.startsWith("5")) return "bg-red-500/10 text-red-400 border-red-500/20";
  return "bg-muted text-muted-foreground border-border";
}

function isExfiltrated(stats: Record<string, number>) {
  return Object.keys(stats).some(s => s.startsWith("2"));
}

function UsernameStatsTable({ stats }: { stats: Record<string, Record<string, number>> }) {
  const entries = Object.entries(stats).sort((a, b) => {
    const aEx = isExfiltrated(a[1]);
    const bEx = isExfiltrated(b[1]);
    if (aEx && !bEx) return -1;
    if (!aEx && bEx) return 1;
    const aTotal = Object.values(a[1]).reduce((s, n) => s + n, 0);
    const bTotal = Object.values(b[1]).reduce((s, n) => s + n, 0);
    return bTotal - aTotal;
  });

  const allStatuses = [...new Set(entries.flatMap(([, s]) => Object.keys(s)))].sort();

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-1 pr-3 font-medium text-muted-foreground">Username</th>
            {allStatuses.map(s => (
              <th key={s} className={`text-center px-2 py-1 font-mono font-medium ${statusColor(s)}`}>{s}</th>
            ))}
            <th className="text-center px-2 py-1 font-medium text-muted-foreground">Tot</th>
            <th className="text-left px-2 py-1 font-medium text-muted-foreground">Stato</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([username, counts]) => {
            const exfil = isExfiltrated(counts);
            const total = Object.values(counts).reduce((s, n) => s + n, 0);
            return (
              <tr
                key={username}
                className={`border-b border-border/50 ${exfil ? "bg-red-500/5" : ""}`}
              >
                <td className={`py-1.5 pr-3 font-mono ${exfil ? "text-red-400 font-semibold" : "text-foreground"}`}>
                  {username}
                </td>
                {allStatuses.map(s => (
                  <td key={s} className={`text-center px-2 py-1.5 font-mono ${statusColor(s)}`}>
                    {counts[s] ?? "-"}
                  </td>
                ))}
                <td className="text-center px-2 py-1.5 text-muted-foreground">{total}</td>
                <td className="px-2 py-1.5">
                  {exfil ? (
                    <span className="text-red-400 font-semibold">⚠ esfiltrató</span>
                  ) : (
                    <span className="text-muted-foreground">bloccato</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface MainJail {
  name: string;
  ips: string[];
  type: "f2b" | "iptables-chain" | "iptables-manual" | "iptv_ban" | "crowdsec";
  jailKey?: string;
}

interface MainBansResult {
  jails: MainJail[];
  updatedAt: string;
}

function MainBansSection() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [unbanning, setUnbanning] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const { data, isLoading, isFetching, refetch } = useQuery<MainBansResult>({
    queryKey: ["main-bans"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/main/bans");
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled,
    refetchInterval: false,
    staleTime: 60000,
  });

  const load = () => { setEnabled(true); refetch(); };

  const unban = async (ip: string, jail: MainJail) => {
    const key = `${ip}:${jail.name}`;
    setUnbanning(key);
    try {
      const res = await apiRequest("POST", "/api/main/unban", {
        ip,
        jail: jail.jailKey || jail.name,
        type: jail.type,
      });
      if (!res.ok) throw new Error(await res.text());
      toast({ title: `Unbanned ${ip}`, description: `Rimosso da ${jail.name}` });
      refetch();
    } catch (e: any) {
      toast({ title: "Errore unban", description: e.message, variant: "destructive" });
    } finally {
      setUnbanning(null);
    }
  };

  const q = search.trim().toLowerCase();
  const filteredJails = (data?.jails ?? [])
    .map(j => ({ ...j, ips: j.ips.filter(ip => !q || ip.includes(q) || j.name.includes(q)) }))
    .filter(j => j.ips.length > 0);

  const totalBans = (data?.jails ?? []).reduce((s, j) => s + j.ips.length, 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Shield className="w-4 h-4 text-orange-400" />
              Main Backend — IP Bannati
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Fail2ban + iptables + CrowdSec su main backend
              {data?.updatedAt && (
                <span className="ml-2 opacity-60">
                  Aggiornato: {new Date(data.updatedAt).toLocaleTimeString("it-IT")}
                </span>
              )}
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={load} disabled={isFetching} className="gap-1.5">
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Aggiorna
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Cerca IP o jail…"
              className="pl-8 text-sm font-mono h-9"
            />
          </div>
          {data && (
            <span className="text-sm text-muted-foreground">
              {totalBans} IP bannati in {data.jails.length} jail
            </span>
          )}
        </div>

        {!enabled && !data && (
          <div className="text-sm text-muted-foreground py-4 text-center opacity-60">
            Clicca Aggiorna per caricare i ban dal main backend
          </div>
        )}

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <RefreshCw className="w-4 h-4 animate-spin" /> Caricamento ban in corso…
          </div>
        )}

        {!isLoading && filteredJails.length === 0 && (
          <div className="text-sm text-muted-foreground py-4 text-center">
            {q ? "Nessun IP trovato per questa ricerca" : "Nessun IP bannato al momento"}
          </div>
        )}

        {filteredJails.map(jail => (
          <div key={jail.name} className="border border-border rounded-lg overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/30 border-b border-border">
              <ShieldBan className="w-3.5 h-3.5 text-orange-400 shrink-0" />
              <span className="font-mono text-sm font-medium">{jail.name}</span>
              <Badge variant="secondary" className="text-xs ml-auto">{jail.ips.length}</Badge>
            </div>
            <div className="divide-y divide-border/50">
              {jail.ips.map(ip => {
                const key = `${ip}:${jail.name}`;
                return (
                  <div key={ip} className="flex items-center justify-between px-4 py-2 hover:bg-muted/20 transition-colors">
                    <span className="font-mono text-sm">{ip}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1.5 text-xs h-7 text-muted-foreground hover:text-foreground"
                      disabled={unbanning === key}
                      onClick={() => unban(ip, jail)}
                    >
                      {unbanning === key ? (
                        <RefreshCw className="w-3 h-3 animate-spin" />
                      ) : (
                        <Unlock className="w-3 h-3" />
                      )}
                      Unban
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

interface MultiVpsDetection {
  ip: string;
  vpsHit: number;
  vpsNames: string[];
  usernames: string[];
  firstSeen: string;
  lastSeen: string;
  banned: boolean;
  geoInfo: { asn?: string; org?: string; countryCode?: string } | null;
}

function MultiVpsProbeCard() {
  const { toast } = useToast();
  const [unbanningIp, setUnbanningIp] = useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery<MultiVpsDetection[]>({
    queryKey: ["/api/fleet/multivps-probe/detections"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/fleet/multivps-probe/detections");
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    refetchInterval: 30000,
  });

  const unban = async (ip: string) => {
    setUnbanningIp(ip);
    try {
      const res = await apiRequest("POST", "/api/fleet/ip-unban", { ip });
      if (!res.ok) throw new Error(await res.text());
      const result = await res.json();
      await apiRequest("POST", "/api/fleet/multivps-probe/dismiss", { ip });
      toast({ title: `Sbannato su ${result.ok} VPS`, description: result.fail > 0 ? `${result.fail} VPS falliti` : "IP rimosso da tutta la fleet" });
      refetch();
    } catch (e: any) {
      toast({ title: "Errore sblocco", description: e.message, variant: "destructive" });
    } finally {
      setUnbanningIp(null);
    }
  };

  const detections = data || [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Shield className="w-4 h-4 text-red-400" />
          Credential-stuffing multi-VPS
        </CardTitle>
        <CardDescription className="text-xs">
          IP rilevati su 3+ VPS con username diverso su ognuno (poller automatico ogni 2 minuti) — banna prima che serva un controllo manuale
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Caricamento…
          </div>
        )}
        {!isLoading && detections.length === 0 && (
          <p className="text-sm text-muted-foreground">Nessuna rilevazione attiva al momento.</p>
        )}
        {detections.map(d => (
          <div key={d.ip} className={`rounded-md border p-3 ${d.banned ? "border-red-500/40 bg-red-500/5" : "border-border"}`}>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm">{d.ip}</span>
                {d.banned ? (
                  <Badge variant="destructive" className="gap-1"><ShieldBan className="w-3 h-3" />Bannato</Badge>
                ) : (
                  <Badge variant="outline" className="gap-1 text-yellow-400 border-yellow-500/30"><AlertTriangle className="w-3 h-3" />Non bannato</Badge>
                )}
                {d.geoInfo?.asn && (
                  <span className="text-xs text-muted-foreground font-mono">
                    {d.geoInfo.asn}{d.geoInfo.org ? ` — ${d.geoInfo.org}` : ""}
                  </span>
                )}
              </div>
              {d.banned && (
                <Button
                  size="sm" variant="outline"
                  disabled={unbanningIp === d.ip}
                  onClick={() => unban(d.ip)}
                  className="gap-1.5 border-orange-500/40 text-orange-400 hover:bg-orange-500/10"
                >
                  {unbanningIp === d.ip ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Unlock className="w-3.5 h-3.5" />}
                  Sbanna
                </Button>
              )}
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              <span className="font-medium">{d.vpsHit} VPS colpiti:</span> {d.vpsNames.join(", ")}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              <span className="font-medium">Username usati:</span> <span className="font-mono">{d.usernames.join(", ")}</span>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground/70">
              Prima rilevazione {new Date(d.firstSeen).toLocaleString("it-IT")} — ultima {new Date(d.lastSeen).toLocaleString("it-IT")}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function QuickUnbanCard() {
  const { toast } = useToast();
  const [ip, setIp] = useState("");
  const [state, setState] = useState<"idle" | "running" | "ok" | "error">("idle");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = ip.trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) {
      toast({ title: "IP non valido", variant: "destructive" });
      return;
    }
    setState("running");
    try {
      const res = await apiRequest("POST", "/api/fleet/ip-unban", { ip: target });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setState("ok");
      toast({ title: `Unbannato su ${data.ok} VPS`, description: data.fail > 0 ? `${data.fail} VPS falliti` : "IP rimosso da tutta la fleet" });
    } catch (e: any) {
      setState("error");
      toast({ title: "Errore unban", description: e.message, variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Unlock className="w-4 h-4 text-orange-400" />
          Sblocco rapido fleet
        </CardTitle>
        <CardDescription className="text-xs">
          Sbanna un IP su tutti i VPS (iptv_ban, jail fail2ban, CrowdSec) senza dover prima analizzare
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex gap-3">
          <Input
            value={ip}
            onChange={e => { setIp(e.target.value); setState("idle"); }}
            placeholder="Es. 64.94.85.248"
            className="font-mono text-sm max-w-xs"
          />
          <Button type="submit" variant="outline" disabled={state === "running"} className="gap-1.5 border-orange-500/40 text-orange-400 hover:bg-orange-500/10">
            {state === "running" ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : state === "ok" ? (
              <CheckCircle2 className="w-4 h-4" />
            ) : (
              <Unlock className="w-4 h-4" />
            )}
            Sbanna su tutta la fleet
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ── Ricerca per username ─────────────────────────────────────────────────────

interface UsernameIpHit {
  ip: string;
  totalCount: number;
  banned: boolean;
  vpsHits: Array<{ vpsId: string; vpsName: string; count: number; statuses: Record<string, number> }>;
  geoInfo: { asn?: string; org?: string; countryCode?: string } | null;
}
interface UsernameBan { ip: string; jail: string; banTime: string; vpsId: string; vpsName: string; }
interface UsernameAsnTorBan { ip: string; vpsId: string; vpsName: string; }
interface UsernameCrowdsecBan { ip: string; scenario: string; duration: string | null; vpsId: string; vpsName: string; }
interface UsernameInvestigateResult {
  username: string;
  ips: UsernameIpHit[];
  bans: UsernameBan[];
  asnBans: UsernameAsnTorBan[];
  torBans: UsernameAsnTorBan[];
  crowdsecBans: UsernameCrowdsecBan[];
  totalVpsWithActivity: number;
}

function UsernameInvestigateCard() {
  const { toast } = useToast();
  const [username, setUsername] = useState("");
  const [result, setResult] = useState<UsernameInvestigateResult | null>(null);
  const [unbanningIp, setUnbanningIp] = useState<string | null>(null);

  const investigate = useMutation({
    mutationFn: async (u: string) => {
      const res = await apiRequest("POST", "/api/fleet/username-investigate", { username: u });
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<UsernameInvestigateResult>;
    },
    onSuccess: setResult,
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const u = username.trim();
    if (!u) { toast({ title: "Inserisci uno username", variant: "destructive" }); return; }
    setResult(null);
    investigate.mutate(u);
  };

  const unbanIp = async (ip: string) => {
    setUnbanningIp(ip);
    try {
      const res = await apiRequest("POST", "/api/fleet/ip-unban", { ip });
      const data = await res.json();
      toast({ title: `Sbannato su ${data.ok} VPS`, description: data.fail > 0 ? `${data.fail} VPS falliti` : "IP rimosso da tutta la fleet" });
      investigate.mutate(username.trim());
    } catch (e: any) {
      toast({ title: "Errore sblocco", description: e.message, variant: "destructive" });
    } finally {
      setUnbanningIp(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <User className="w-4 h-4 text-blue-400" />
          Cerca per username cliente
        </CardTitle>
        <CardDescription className="text-xs">
          Trova gli IP usati da un account su tutta la fleet e controlla se sono bannati (jail fail2ban reali, non solo iptv_ban)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={submit} className="flex gap-3">
          <Input
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder="Es. 2amicmas"
            className="font-mono text-sm max-w-xs"
          />
          <Button type="submit" disabled={investigate.isPending} className="gap-1.5">
            {investigate.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            Cerca
          </Button>
        </form>

        {investigate.isPending && (
          <div className="flex items-center gap-3 text-muted-foreground text-sm">
            <RefreshCw className="w-4 h-4 animate-spin" />
            Scansione di tutta la fleet in corso…
          </div>
        )}

        {result && result.ips.length === 0 && (
          <p className="text-sm text-muted-foreground">Nessuna attività trovata per <span className="font-mono">{result.username}</span> su nessun VPS (log attuali).</p>
        )}

        {result && result.ips.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {result.ips.length} IP distinti su {result.totalVpsWithActivity} VPS con attività
              {result.bans.length > 0 && <span className="text-red-400 font-medium"> — {result.bans.length} ban attivi trovati</span>}
            </p>
            {result.ips.map(ipHit => {
              const ipBans = result.bans.filter(b => b.ip === ipHit.ip);
              return (
                <div key={ipHit.ip} className={`rounded-md border p-3 ${ipHit.banned ? "border-red-500/40 bg-red-500/5" : "border-border"}`}>
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm">{ipHit.ip}</span>
                      {ipHit.banned ? (
                        <Badge variant="destructive" className="gap-1"><ShieldBan className="w-3 h-3" />Bannato</Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1 text-green-400 border-green-500/30"><ShieldCheck className="w-3 h-3" />Libero</Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {ipHit.totalCount} richieste su {ipHit.vpsHits.map(v => v.vpsName).join(", ")}
                      </span>
                      {ipHit.geoInfo?.asn && (
                        <span className="text-xs text-muted-foreground font-mono">
                          {ipHit.geoInfo.asn}{ipHit.geoInfo.org ? ` — ${ipHit.geoInfo.org}` : ""}
                        </span>
                      )}
                    </div>
                    {ipHit.banned && (
                      <Button
                        size="sm" variant="outline"
                        disabled={unbanningIp === ipHit.ip}
                        onClick={() => unbanIp(ipHit.ip)}
                        className="gap-1.5 border-orange-500/40 text-orange-400 hover:bg-orange-500/10"
                      >
                        {unbanningIp === ipHit.ip ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Unlock className="w-3.5 h-3.5" />}
                        Sbanna su tutta la fleet
                      </Button>
                    )}
                  </div>
                  {(() => {
                    const asn = result!.asnBans.filter(b => b.ip === ipHit.ip);
                    const tor = result!.torBans.filter(b => b.ip === ipHit.ip);
                    const cs = result!.crowdsecBans.filter(b => b.ip === ipHit.ip);
                    if (ipBans.length === 0 && asn.length === 0 && tor.length === 0 && cs.length === 0) {
                      return <p className="mt-2 text-xs text-muted-foreground">Nessun blocco attivo in Fail2ban, ipset, CrowdSec, ASN o Tor.</p>;
                    }
                    return (
                      <div className="mt-2 space-y-1">
                        {ipBans.map((b, i) => (
                          <div key={"f2b" + i} className="text-xs text-red-400/90 flex items-center gap-2">
                            <ShieldBan className="w-3 h-3" />
                            Fail2ban — <span className="font-mono">{b.vpsName}</span> — jail <span className="font-mono">{b.jail}</span> — {new Date(b.banTime).toLocaleString("it-IT")}
                          </div>
                        ))}
                        {asn.map((b, i) => (
                          <div key={"asn" + i} className="text-xs text-red-400/90 flex items-center gap-2">
                            <ShieldBan className="w-3 h-3" />
                            Blocklist ASN — <span className="font-mono">{b.vpsName}</span>
                          </div>
                        ))}
                        {tor.map((b, i) => (
                          <div key={"tor" + i} className="text-xs text-red-400/90 flex items-center gap-2">
                            <ShieldBan className="w-3 h-3" />
                            Tor exit-node — <span className="font-mono">{b.vpsName}</span>
                          </div>
                        ))}
                        {cs.map((b, i) => (
                          <div key={"cs" + i} className="text-xs text-red-400/90 flex items-center gap-2">
                            <ShieldBan className="w-3 h-3" />
                            CrowdSec — <span className="font-mono">{b.vpsName}</span> — scenario <span className="font-mono">{b.scenario}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function IpInvestigator() {
  const { toast } = useToast();
  const search = useSearch();
  const [ipInput, setIpInput] = useState("");
  const [result, setResult] = useState<InvestigateResult | null>(null);
  const [expandedVps, setExpandedVps] = useState<string | null>(null);
  const [banState, setBanState] = useState<"idle" | "running" | "ok" | "error">("idle");
  const [unbanState, setUnbanState] = useState<"idle" | "running" | "ok" | "error">("idle");

  const investigate = useMutation({
    mutationFn: async (ip: string) => {
      const res = await apiRequest("POST", "/api/fleet/ip-investigate", { ip });
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<InvestigateResult>;
    },
    onSuccess: (data) => {
      setResult(data);
      setBanState("idle");
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  useEffect(() => {
    const params = new URLSearchParams(search);
    const ip = params.get("ip");
    if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      setIpInput(ip);
      investigate.mutate(ip);
    }
  }, []);

  const banFleet = async (ip: string) => {
    setBanState("running");
    try {
      const res = await apiRequest("POST", "/api/fleet/ip-ban", { ip });
      const data = await res.json();
      setBanState("ok");
      toast({ title: `Bannato su ${data.ok} VPS`, description: data.fail > 0 ? `${data.fail} VPS falliti` : "Tutta la fleet aggiornata" });
      investigate.mutate(ip);
    } catch (e: any) {
      setBanState("error");
      toast({ title: "Errore ban", description: e.message, variant: "destructive" });
    }
  };

  const unbanFleet = async (ip: string) => {
    setUnbanState("running");
    try {
      const res = await apiRequest("POST", "/api/fleet/ip-unban", { ip });
      const data = await res.json();
      setUnbanState("ok");
      toast({ title: `Unbannato su ${data.ok} VPS`, description: data.fail > 0 ? `${data.fail} VPS falliti` : "IP rimosso da tutta la fleet" });
      investigate.mutate(ip);
    } catch (e: any) {
      setUnbanState("error");
      toast({ title: "Errore unban", description: e.message, variant: "destructive" });
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const ip = ipInput.trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      toast({ title: "IP non valido", variant: "destructive" });
      return;
    }
    investigate.mutate(ip);
  };

  const bannedVpsCount = result?.vpsResults.filter(v => v.banned).length ?? 0;
  const isFullyBanned = result && bannedVpsCount === result.totalVps && result.totalVps > 0;

  const exfiltratedUsernames = result
    ? Object.entries(result.allUsernameStats || {})
        .filter(([, stats]) => isExfiltrated(stats))
        .map(([u]) => u)
    : [];

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold font-heading">IP Investigator</h1>
        <p className="text-sm text-muted-foreground mt-1">Analisi cross-fleet di un IP — log, username, ban status</p>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="pt-5">
          <form onSubmit={submit} className="flex gap-3">
            <Input
              value={ipInput}
              onChange={e => setIpInput(e.target.value)}
              placeholder="Es. 64.94.85.248"
              className="font-mono text-sm max-w-xs"
            />
            <Button type="submit" disabled={investigate.isPending} className="gap-1.5">
              {investigate.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Analizza
            </Button>
          </form>
        </CardContent>
      </Card>

      <MultiVpsProbeCard />

      <QuickUnbanCard />

      <UsernameInvestigateCard />

      {investigate.isPending && (
        <div className="flex items-center gap-3 text-muted-foreground text-sm">
          <RefreshCw className="w-4 h-4 animate-spin" />
          Scansione di tutta la fleet in corso…
        </div>
      )}

      {result && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="text-2xl font-bold font-heading">{result.vpsResults.filter(v => v.count > 0).length}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                  <Server className="w-3 h-3" /> VPS con log
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="text-2xl font-bold font-heading">{result.totalRequests}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                  <Globe className="w-3 h-3" /> Richieste totali
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className={`text-2xl font-bold font-heading ${exfiltratedUsernames.length > 0 ? "text-red-400" : ""}`}>
                  {exfiltratedUsernames.length}/{result.allUsernames.length}
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                  <User className="w-3 h-3" /> Esfiltrató/Tot username
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="text-2xl font-bold font-heading">{bannedVpsCount}/{result.totalVps}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                  <ShieldBan className="w-3 h-3" /> VPS bannati
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Geo + actions */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Informazioni IP</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="font-mono text-lg font-bold">{result.ip}</div>
                {result.geoInfo ? (
                  <div className="text-sm space-y-1 text-muted-foreground">
                    <div>ASN: <span className="text-foreground font-mono">{result.geoInfo.asn}</span></div>
                    <div>ISP: <span className="text-foreground">{result.geoInfo.org}</span></div>
                    <div>Paese: <span className="text-foreground">{result.geoInfo.countryCode}</span></div>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">Geo info non disponibile</div>
                )}
                {result.totalVps === 0 ? (
                  <Badge variant="outline" className="text-green-500 border-green-500/30 mt-2">
                    Nessuna attività rilevata
                  </Badge>
                ) : isFullyBanned ? (
                  <Badge variant="outline" className="text-green-500 border-green-500/30 mt-2">
                    <ShieldCheck className="w-3 h-3 mr-1" /> Bannato su tutta la fleet
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-orange-500 border-orange-500/30 mt-2">
                    <AlertTriangle className="w-3 h-3 mr-1" /> Attività rilevata — non completamente bannato
                  </Badge>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  Azioni
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {result.totalVps > 0 && (
                  <div className="flex flex-wrap gap-3">
                    <Button
                      variant="destructive"
                      disabled={banState === "running" || unbanState === "running" || isFullyBanned === true}
                      onClick={() => banFleet(result.ip)}
                      className="gap-1.5"
                    >
                      {banState === "running" ? (
                        <RefreshCw className="w-4 h-4 animate-spin" />
                      ) : banState === "ok" ? (
                        <CheckCircle2 className="w-4 h-4" />
                      ) : (
                        <ShieldBan className="w-4 h-4" />
                      )}
                      {isFullyBanned ? "Già bannato" : "Banna fleet"}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={unbanState === "running" || banState === "running" || bannedVpsCount === 0}
                      onClick={() => unbanFleet(result.ip)}
                      className="gap-1.5 border-orange-500/40 text-orange-400 hover:bg-orange-500/10"
                    >
                      {unbanState === "running" ? (
                        <RefreshCw className="w-4 h-4 animate-spin" />
                      ) : unbanState === "ok" ? (
                        <CheckCircle2 className="w-4 h-4" />
                      ) : (
                        <Unlock className="w-4 h-4" />
                      )}
                      Unban fleet
                    </Button>
                    <Button variant="outline" onClick={() => investigate.mutate(result.ip)} disabled={investigate.isPending} className="gap-1.5">
                      <RefreshCw className={`w-4 h-4 ${investigate.isPending ? "animate-spin" : ""}`} />
                      Rianalizza
                    </Button>
                  </div>
                )}
                {exfiltratedUsernames.length > 0 && (
                  <div className="text-xs text-red-400 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    {exfiltratedUsernames.length} username con risposta 2xx (credenziali esposte)
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Username stats aggregati fleet */}
          {result.allUsernames.length > 0 && result.allUsernameStats && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Username — analisi cross-fleet ({result.allUsernames.length})</CardTitle>
                <CardDescription className="text-xs">
                  Rosso = ha ricevuto risposta 2xx (credenziali confermate). Arancio/grigio = bloccato prima dell'auth.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <UsernameStatsTable stats={result.allUsernameStats} />
              </CardContent>
            </Card>
          )}

          {/* Per-VPS breakdown */}
          {result.totalVps > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Dettaglio per VPS</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {result.vpsResults.sort((a, b) => b.count - a.count).map(vps => (
                  <div key={vps.vpsId} className="border border-border rounded-lg overflow-hidden">
                    <button
                      className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-muted/40 transition-colors text-left"
                      onClick={() => setExpandedVps(expandedVps === vps.vpsId ? null : vps.vpsId)}
                    >
                      <div className="flex items-center gap-3">
                        {vps.banned ? (
                          <ShieldCheck className="w-4 h-4 text-green-500 shrink-0" />
                        ) : (
                          <XCircle className="w-4 h-4 text-orange-400 shrink-0" />
                        )}
                        <span className="text-sm font-medium">{vps.vpsName}</span>
                        {vps.count > 0 ? (
                          <Badge variant="secondary" className="text-xs">{vps.count} req</Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs text-muted-foreground">solo ban</Badge>
                        )}
                        {vps.usernames.length > 0 && (
                          <span className="text-xs text-muted-foreground">{vps.usernames.length} username</span>
                        )}
                      </div>
                      <div className="flex gap-1.5 items-center">
                        {[...new Set(vps.statuses)].sort().map(s => {
                          const cnt = vps.statuses.filter(x => x === s).length;
                          return (
                            <span key={s} className={`text-xs font-mono border rounded px-1 ${statusBadgeClass(s)}`}>
                              {s}×{cnt}
                            </span>
                          );
                        })}
                      </div>
                    </button>

                    {expandedVps === vps.vpsId && (
                      <div className="border-t border-border px-4 py-3 bg-muted/20 space-y-4">
                        {vps.ua && (
                          <div className="text-xs text-muted-foreground">
                            User-Agent: <span className="font-mono text-foreground">{vps.ua}</span>
                          </div>
                        )}

                        {vps.usernameStats && Object.keys(vps.usernameStats).length > 0 && (
                          <div>
                            <div className="text-xs text-muted-foreground mb-2">Username per stato:</div>
                            <UsernameStatsTable stats={vps.usernameStats} />
                          </div>
                        )}

                        {vps.sample.length > 0 && (
                          <div>
                            <div className="text-xs text-muted-foreground mb-1">Righe log ({vps.sample.length}):</div>
                            <div className="bg-black/40 rounded p-2 space-y-0.5 max-h-96 overflow-y-auto">
                              {vps.sample.map((line, i) => {
                                const has200 = /"\s+2\d{2}\s+/.test(line);
                                return (
                                  <div
                                    key={i}
                                    className={`text-[10px] font-mono break-all ${has200 ? "text-red-400/90" : "text-green-400/80"}`}
                                  >
                                    {line}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {result.totalVps === 0 && (
            <Card>
              <CardContent className="pt-8 pb-8 text-center text-muted-foreground">
                <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-green-500" />
                <div className="text-sm">Nessuna attività rilevata per <span className="font-mono">{result.ip}</span></div>
                <div className="text-xs mt-1 opacity-60">Nessun log recente e non presente in iptv_ban</div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      <MainBansSection />
    </div>
  );
}
