import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVpsList, useVpsHealth } from "@/hooks/use-vps";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LoadingState } from "@/components/loading-state";
import { Search, Shield, FileText, AlertTriangle, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { IpCell } from "@/components/ip-cell";
import { useIpBatch } from "@/hooks/use-ip-batch";

interface BulkResult { vpsId: string; vpsName: string; success: boolean; data?: any; error?: string; }
interface BannedIp { ip: string; jail: string; banTime?: string; }

const LOG_TYPES = [
  { value: "nginx_access", label: "Nginx Access" },
  { value: "nginx_error", label: "Nginx Error" },
  { value: "fail2ban", label: "Fail2ban" },
  { value: "system", label: "Syslog" },
  { value: "anti_iptv", label: "Anti-IPTV Bans" },
];

const PAGE_SIZE = 100;

function BannedIpsTab() {
  const { toast } = useToast();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState(""); // debounced
  const [selectedVps, setSelectedVps] = useState("all");
  const [unbanning, setUnbanning] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const { data: vpsList } = useVpsList();
  const { data: healthMap } = useVpsHealth();
  const onlineVps = (vpsList || []).filter(v => healthMap?.[v.id]);

  // Debounce ricerca: aggiorna `search` solo dopo 300ms di inattività
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = (val: string) => {
    setSearchInput(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { setSearch(val); setPage(0); }, 300);
  };

  // Stato streaming — buffer in ref, flush ogni 300ms per ridurre i re-render
  const [results, setResults] = useState<BulkResult[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(0);
  const [done, setDone] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const bufferRef = useRef<BulkResult[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startStream = useCallback(() => {
    esRef.current?.close();
    if (flushTimerRef.current) clearInterval(flushTimerRef.current);
    bufferRef.current = [];
    setResults([]);
    setTotal(0);
    setLoaded(0);
    setDone(false);
    setPage(0);

    const es = new EventSource("/api/fleet/banned-ips/stream");
    esRef.current = es;

    // Flush buffer → state ogni 300ms
    flushTimerRef.current = setInterval(() => {
      if (bufferRef.current.length === 0) return;
      const batch = bufferRef.current.splice(0);
      setResults(prev => [...prev, ...batch]);
      setLoaded(n => n + batch.length);
    }, 300);

    es.addEventListener("total", (e) => {
      setTotal(JSON.parse(e.data).total);
    });

    es.addEventListener("result", (e) => {
      bufferRef.current.push(JSON.parse(e.data));
    });

    es.addEventListener("done", () => {
      // Flush finale
      const remaining = bufferRef.current.splice(0);
      if (remaining.length > 0) {
        setResults(prev => [...prev, ...remaining]);
        setLoaded(n => n + remaining.length);
      }
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
      es.close();
      esRef.current = null;
      setDone(true);
    });

    es.onerror = () => {
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
      es.close();
      esRef.current = null;
      setDone(true);
    };
  }, []);

  useEffect(() => {
    if (selectedVps === "all") {
      startStream();
    } else {
      esRef.current?.close();
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
    }
    return () => {
      esRef.current?.close();
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
    };
  }, [selectedVps, startStream]);

  const { data: singleResult, isLoading: singleLoading, refetch: refetchSingle } = useQuery<BulkResult[]>({
    queryKey: ["search-banned-ips-single", selectedVps],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/vps/${selectedVps}/proxy/api/banned-ips`);
      const data = await r.json();
      const vps = vpsList?.find(v => v.id === selectedVps);
      return [{ vpsId: selectedVps, vpsName: vps?.name ?? selectedVps, success: true, data }];
    },
    enabled: selectedVps !== "all",
  });

  const activeResults = selectedVps === "all" ? results : (singleResult ?? []);
  const isLoading = selectedVps === "all" ? (!done && loaded === 0) : singleLoading;

  // Memoizza flatten + filtro per evitare ricalcoli su ogni re-render
  const allBanned = useMemo(() => {
    const out: Array<{ vpsId: string; vpsName: string; ip: string; jail: string; banTime?: string }> = [];
    for (const r of activeResults) {
      if (r.success && Array.isArray(r.data)) {
        for (const b of r.data as BannedIp[]) {
          out.push({ vpsId: r.vpsId, vpsName: r.vpsName, ip: b.ip, jail: b.jail, banTime: b.banTime });
        }
      }
    }
    return out;
  }, [activeResults]);

  useIpBatch(allBanned.map(b => b.ip));

  const filtered = useMemo(() => {
    if (!search) return allBanned;
    const q = search.toLowerCase();
    return allBanned.filter(b =>
      b.ip.includes(search) ||
      b.jail.toLowerCase().includes(q) ||
      b.vpsName.toLowerCase().includes(q)
    );
  }, [allBanned, search]);

  // Paginazione: mai più di PAGE_SIZE righe nel DOM
  const pageCount = Math.ceil(filtered.length / PAGE_SIZE);
  const pageRows = useMemo(() => filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [filtered, page]);

  const byVps = useMemo(() => activeResults.reduce((acc, r) => {
    acc[r.vpsName] = r.success ? (Array.isArray(r.data) ? r.data.length : 0) : -1;
    return acc;
  }, {} as Record<string, number>), [activeResults]);

  const handleUnban = async (vpsId: string, ip: string, jail: string) => {
    setUnbanning(`${vpsId}-${ip}`);
    try {
      await apiRequest("POST", `/api/vps/${vpsId}/proxy/api/unban`, { ip, jail });
      toast({ title: `${ip} sbloccato` });
      if (selectedVps === "all") startStream(); else refetchSingle();
    } catch (e: any) {
      toast({ title: "Errore unban", description: e.message, variant: "destructive" });
    } finally {
      setUnbanning(null);
    }
  };

  const onlineCount = useMemo(() => activeResults.filter(r => r.success).length, [activeResults]);
  const streamProgress = total > 0 ? Math.round((loaded / total) * 100) : 0;

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-2 text-xs text-muted-foreground">
          {selectedVps === "all" && !done && total > 0 && (
            <span className="text-blue-400">{loaded}/{total} VPS caricati...</span>
          )}
          {(done || selectedVps !== "all") && (
            <span>{onlineCount}/{activeResults.length} VPS risposto</span>
          )}
          <span>·</span>
          <span className="font-semibold text-foreground">{allBanned.length} IP bannati totali</span>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <Select value={selectedVps} onValueChange={v => { setSelectedVps(v); setPage(0); }}>
            <SelectTrigger className="w-44 h-8 text-sm">
              <SelectValue placeholder="Tutti i VPS" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tutti i VPS</SelectItem>
              {onlineVps.map(v => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => selectedVps === "all" ? startStream() : refetchSingle()} disabled={isLoading}>
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {selectedVps === "all" && !done && total > 0 && (
        <div className="w-full bg-muted rounded-full h-1.5">
          <div className="bg-blue-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${streamProgress}%` }} />
        </div>
      )}

      {Object.keys(byVps).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(byVps).map(([name, count]) => (
            <Badge key={name} variant={count >= 0 ? "outline" : "destructive"} className="font-mono text-xs">
              {name}: {count >= 0 ? count : "offline"}
            </Badge>
          ))}
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          value={searchInput}
          onChange={e => handleSearchChange(e.target.value)}
          placeholder="Cerca per IP, jail o VPS..."
          className="pl-9 font-mono"
        />
      </div>

      {search && <p className="text-xs text-muted-foreground">{filtered.length} risultati</p>}

      {isLoading ? (
        <LoadingState message="Connessione ai VPS..." />
      ) : (
        <>
          <Card className="border-card-border">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>IP</TableHead>
                      <TableHead>Jail</TableHead>
                      <TableHead>VPS</TableHead>
                      <TableHead className="text-right">Azioni</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                          {search ? "Nessun risultato" : allBanned.length === 0 && !done ? "Caricamento..." : "Nessun IP bannato"}
                        </TableCell>
                      </TableRow>
                    ) : pageRows.map((b, i) => (
                      <TableRow key={i}>
                        <TableCell><IpCell ip={b.ip} className="text-red-400 font-semibold" /></TableCell>
                        <TableCell><Badge variant="outline" className="font-mono text-xs">{b.jail}</Badge></TableCell>
                        <TableCell className="text-sm text-muted-foreground">{b.vpsName}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm" variant="outline"
                            disabled={unbanning === `${b.vpsId}-${b.ip}`}
                            onClick={() => handleUnban(b.vpsId, b.ip, b.jail)}
                          >
                            {unbanning === `${b.vpsId}-${b.ip}` ? "..." : "Unban"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {pageCount > 1 && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Pagina {page + 1} di {pageCount} ({filtered.length} totali)</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prec</Button>
                <Button variant="outline" size="sm" disabled={page >= pageCount - 1} onClick={() => setPage(p => p + 1)}>Succ →</Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Log Search tab ─────────────────────────────────────────────────────────────

interface GrepResult { query: string; logType: string; count: number; entries: Array<{ id: number; message: string; level: string }> }

function LogSearchTab() {
  const { data: vpsList } = useVpsList();
  const { data: healthMap } = useVpsHealth();
  const [query, setQuery] = useState("");
  const [logType, setLogType] = useState("nginx_access");
  const [targetVps, setTargetVps] = useState("all");
  const [submitted, setSubmitted] = useState(false);
  const [searchKey, setSearchKey] = useState(0);

  const onlineVps = (vpsList || []).filter(v => healthMap?.[v.id]);

  const { data: results, isLoading } = useQuery<BulkResult[]>({
    queryKey: ["log-search", searchKey, query, logType, targetVps],
    queryFn: async () => {
      const path = `/api/grep?q=${encodeURIComponent(query)}&type=${logType}`;
      if (targetVps === "all") {
        const r = await apiRequest("POST", "/api/vps/bulk/get", { vpsIds: "all", path });
        return r.json();
      } else {
        const r = await apiRequest("GET", `/api/vps/${targetVps}/proxy${path}`);
        const data: GrepResult = await r.json();
        const vps = vpsList?.find(v => v.id === targetVps);
        return [{ vpsId: targetVps, vpsName: vps?.name ?? targetVps, success: true, data }];
      }
    },
    enabled: submitted && query.length >= 2,
  });

  const handleSearch = () => {
    if (query.length < 2) return;
    setSearchKey(k => k + 1);
    setSubmitted(true);
  };

  const totalMatches = (results || []).reduce((sum, r) => {
    const d = r.data as GrepResult | undefined;
    return sum + (r.success && d ? d.count : 0);
  }, 0);

  return (
    <div className="space-y-4 pt-4">
      <Card className="border-card-border">
        <CardHeader>
          <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Parametri ricerca</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="md:col-span-2 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleSearch()}
                placeholder="IP, user agent, pattern..."
                className="pl-9 font-mono"
              />
            </div>
            <Select value={logType} onValueChange={setLogType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {LOG_TYPES.map(l => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={targetVps} onValueChange={setTargetVps}>
              <SelectTrigger><SelectValue placeholder="VPS" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tutti i VPS</SelectItem>
                {onlineVps.map(v => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between mt-3">
            <p className="text-xs text-muted-foreground">Cerca nelle ultime 500 righe di log</p>
            <Button onClick={handleSearch} disabled={query.length < 2 || isLoading}>
              <Search className="w-4 h-4 mr-2" />{isLoading ? "Ricerca..." : "Cerca"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading && <LoadingState message={`Ricerca "${query}" su tutti i VPS...`} />}

      {submitted && !isLoading && results && (
        <>
          <p className="text-sm text-muted-foreground">
            Trovate <strong className="text-foreground">{totalMatches}</strong> corrispondenze per <code className="bg-muted px-1 rounded font-mono text-xs">"{query}"</code> in {logType}
          </p>

          <div className="space-y-4">
            {(results || []).map(r => {
              const d = r.data as GrepResult | undefined;
              if (!r.success) return (
                <Card key={r.vpsId} className="border-card-border border-destructive/30">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-mono flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-destructive" />{r.vpsName}
                      <Badge variant="destructive" className="ml-auto text-xs">Offline</Badge>
                    </CardTitle>
                  </CardHeader>
                </Card>
              );
              return (
                <Card key={r.vpsId} className="border-card-border">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm font-mono">{r.vpsName}</CardTitle>
                      <Badge variant={d && d.count > 0 ? "default" : "secondary"} className="text-xs">
                        {d?.count ?? 0} risultati
                      </Badge>
                    </div>
                  </CardHeader>
                  {d && d.entries.length > 0 && (
                    <CardContent>
                      <div className="bg-muted rounded-md p-3 font-mono text-xs max-h-72 overflow-y-auto space-y-0.5">
                        {d.entries.map((e, i) => (
                          <div key={i} className={e.level === "error" ? "text-red-400" : e.level === "warn" ? "text-yellow-400" : "text-muted-foreground"}>
                            <HighlightMatch text={e.message} query={query} />
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  )}
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function HighlightMatch({ text, query }: { text: string; query: string }) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-400/30 text-yellow-200 rounded-sm px-0.5">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function Ricerca() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-heading font-bold tracking-tight">Ricerca</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Cerca IP bannati e pattern nei log su tutti i VPS</p>
      </div>
      <Tabs defaultValue="banned">
        <TabsList>
          <TabsTrigger value="banned"><Shield className="w-3.5 h-3.5 mr-1.5" />IP Bannati</TabsTrigger>
          <TabsTrigger value="logs"><FileText className="w-3.5 h-3.5 mr-1.5" />Ricerca Log</TabsTrigger>
        </TabsList>
        <TabsContent value="banned"><BannedIpsTab /></TabsContent>
        <TabsContent value="logs"><LogSearchTab /></TabsContent>
      </Tabs>
    </div>
  );
}
