import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useVpsList, useVpsHealth } from "@/hooks/use-vps";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LoadingState } from "@/components/loading-state";
import { useToast } from "@/hooks/use-toast";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import {
  Plus, Trash2, Search, RefreshCw, CheckCircle, XCircle,
  Shield, Activity, Settings, FileText, AlertTriangle, Play, Database,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AsnEntry { asn: string; description?: string; }
interface BulkResult { vpsId: string; vpsName: string; success: boolean; data?: any; error?: string; }
interface AsnStat { asn: string; org: string; country: string; countryCode: string; packets: number; bytes: number; }
interface AsnStats { updatedAt: string; totalPrefixes: number; top: AsnStat[]; }
interface AsnStatus { ipsetRestore: string; whitelistWatcher: string; totalPrefixes: number; lastUpdate: string; }
interface WhitelistEntry { value: string; comment: string; type: "cidr" | "domain"; }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseAsnConfig(content: string): AsnEntry[] {
  return content.split("\n").map(line => {
    const t = line.trim();
    if (t.startsWith("#") || !t || !/^\S+\s+\S+;/.test(t)) return null;
    const parts = t.split(/\s+/);
    const comment = t.includes("#") ? t.split("#").slice(1).join("#").trim() : undefined;
    return { asn: parts[0], description: comment };
  }).filter(Boolean) as AsnEntry[];
}

function buildAsnConfig(entries: AsnEntry[]): string {
  return entries.map(({ asn, description }) => `${asn} 1;${description ? ` # ${description}` : ""}`).join("\n") + "\n";
}

function ServiceBadge({ state }: { state: string }) {
  const active = state === "active";
  return (
    <Badge className={active ? "bg-green-600 text-white" : "bg-destructive text-white"}>
      {active ? <CheckCircle className="w-3 h-3 mr-1 inline" /> : <XCircle className="w-3 h-3 mr-1 inline" />}
      {state || "unknown"}
    </Badge>
  );
}

const COUNTRY_COLORS = ["#dc2626", "#ea580c", "#d97706", "#ca8a04", "#65a30d"];

function countryColor(index: number, total: number) {
  const pct = index / Math.max(total - 1, 1);
  if (pct < 0.25) return COUNTRY_COLORS[0];
  if (pct < 0.5) return COUNTRY_COLORS[1];
  if (pct < 0.75) return COUNTRY_COLORS[2];
  return COUNTRY_COLORS[4];
}

// ─── Panoramica Tab ───────────────────────────────────────────────────────────

function TabPanoramica({ vpsId }: { vpsId: string }) {
  const proxy = (path: string) => `/api/vps/${vpsId}/proxy${path}`;

  const { data: status, isLoading: statusLoading, refetch: refetchStatus } = useQuery<AsnStatus>({
    queryKey: [`asn-status-${vpsId}`],
    queryFn: async () => { const r = await apiRequest("GET", proxy("/api/asn/status")); return r.json(); },
    refetchInterval: 60000,
  });

  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useQuery<AsnStats>({
    queryKey: [`asn-stats-${vpsId}`],
    queryFn: async () => { const r = await apiRequest("GET", proxy("/api/asn/stats")); return r.json(); },
    refetchInterval: 300000,
  });

  const countryMap = new Map<string, { country: string; packets: number }>();
  (stats?.top || []).forEach(s => {
    const prev = countryMap.get(s.countryCode) || { country: s.country, packets: 0 };
    countryMap.set(s.countryCode, { country: s.country, packets: prev.packets + s.packets });
  });
  const topCountries = Array.from(countryMap.entries())
    .map(([code, v]) => ({ code, ...v }))
    .sort((a, b) => b.packets - a.packets)
    .slice(0, 15);

  const maxPackets = stats?.top?.[0]?.packets || 1;

  return (
    <div className="space-y-4">
      {/* Status cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">ipset-restore</p>
            {statusLoading ? <div className="h-6 bg-muted rounded animate-pulse" /> : <ServiceBadge state={status?.ipsetRestore ?? "unknown"} />}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">whitelist-watcher</p>
            {statusLoading ? <div className="h-6 bg-muted rounded animate-pulse" /> : <ServiceBadge state={status?.whitelistWatcher ?? "unknown"} />}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Prefissi bloccati</p>
            <p className="text-4xl font-bold font-heading text-foreground leading-none">
              {statusLoading ? "…" : (status?.totalPrefixes ?? 0).toLocaleString()}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Ultimo aggiornamento</p>
            <p className="text-xs font-mono text-foreground leading-snug break-all">
              {statusLoading ? "…" : (status?.lastUpdate || "—")}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Top ASN + Country chart */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Top paesi */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Top Paesi</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => { refetchStats(); queryClient.invalidateQueries({ queryKey: [`asn-stats-${vpsId}`] }); }}>
                <RefreshCw className="w-3.5 h-3.5" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {statsLoading ? <LoadingState message="Caricamento..." /> : topCountries.length === 0 ? (
              <p className="text-center text-muted-foreground py-8 text-sm">Nessun dato disponibile</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={topCountries} layout="vertical" margin={{ left: 8, right: 8 }}>
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="code" width={32} tick={{ fontSize: 11 }} />
                  <Tooltip
                    formatter={(v: number) => [v.toLocaleString(), "Pacchetti"]}
                    labelFormatter={(l) => topCountries.find(c => c.code === l)?.country ?? l}
                  />
                  <Bar dataKey="packets" radius={[0, 3, 3, 0]}>
                    {topCountries.map((_, i) => (
                      <Cell key={i} fill={countryColor(i, topCountries.length)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Top ASN */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Top ASN</CardTitle>
              {stats?.updatedAt && (
                <span className="text-xs text-muted-foreground">{new Date(stats.updatedAt).toLocaleTimeString("it-IT")}</span>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {statsLoading ? <LoadingState message="Caricamento..." /> : !stats?.top?.length ? (
              <p className="text-center text-muted-foreground py-8 text-sm">Nessun dato disponibile</p>
            ) : (
              <div className="max-h-64 overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8">#</TableHead>
                      <TableHead>ASN / Org</TableHead>
                      <TableHead>Paese</TableHead>
                      <TableHead className="text-right">Pacchetti</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stats.top.slice(0, 20).map((s, i) => (
                      <TableRow key={s.asn}>
                        <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                        <TableCell>
                          <p className="font-mono text-xs font-semibold">{s.asn}</p>
                          <p className="text-xs text-muted-foreground truncate max-w-36">{s.org}</p>
                          <div className="mt-1 h-1 rounded bg-muted overflow-hidden">
                            <div className="h-full bg-orange-500 rounded" style={{ width: `${Math.round((s.packets / maxPackets) * 100)}%` }} />
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">{s.country}</TableCell>
                        <TableCell className="text-right text-xs font-mono">{s.packets.toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Gestione Tab ─────────────────────────────────────────────────────────────

function TabGestione({ vpsId, canWrite }: { vpsId: string; canWrite: boolean }) {
  const { toast } = useToast();
  const proxy = (path: string) => `/api/vps/${vpsId}/proxy${path}`;
  const [testIp, setTestIp] = useState("");
  const [testResult, setTestResult] = useState<boolean | null>(null);
  const [updateListsOutput, setUpdateListsOutput] = useState("");
  const [updateSetOutput, setUpdateSetOutput] = useState("");

  const updateListsMutation = useMutation({
    mutationFn: async () => { const r = await apiRequest("POST", proxy("/api/asn/update-lists"), {}); return r.json(); },
    onSuccess: (data: any) => {
      setUpdateListsOutput(data.output || "");
      toast({ title: data.success ? "Liste aggiornate" : "Errore aggiornamento liste", variant: data.success ? "default" : "destructive" });
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const updateSetMutation = useMutation({
    mutationFn: async () => { const r = await apiRequest("POST", proxy("/api/asn/update-set"), {}); return r.json(); },
    onSuccess: (data: any) => {
      setUpdateSetOutput(data.output || "");
      toast({ title: data.success ? "Set rigenerato" : "Errore rigenerazione set", variant: data.success ? "default" : "destructive" });
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const testIpMutation = useMutation({
    mutationFn: async () => { const r = await apiRequest("POST", proxy("/api/asn/test-ip"), { ip: testIp }); return r.json(); },
    onSuccess: (data: any) => setTestResult(data.blocked),
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      {/* Test IP */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Testa IP</CardTitle>
          <CardDescription>Verifica se un IP è bloccato nell'ipset blocked_asn</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 flex-wrap items-center">
            <Input
              placeholder="es. 8.8.8.8"
              value={testIp}
              onChange={e => { setTestIp(e.target.value); setTestResult(null); }}
              className="w-48 font-mono"
              onKeyDown={e => e.key === "Enter" && testIp && testIpMutation.mutate()}
            />
            <Button size="sm" onClick={() => testIpMutation.mutate()} disabled={!testIp || testIpMutation.isPending}>
              <Search className="w-4 h-4 mr-1" />Testa
            </Button>
            {testResult !== null && (
              <Badge className={testResult ? "bg-destructive text-white text-sm px-3 py-1" : "bg-green-600 text-white text-sm px-3 py-1"}>
                {testResult ? "BLOCCATO" : "LIBERO"}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Aggiorna liste */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Aggiorna liste da GitHub</CardTitle>
              <CardDescription>Scarica i file di configurazione aggiornati dal repository</CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite || updateListsMutation.isPending}
              onClick={() => {
                if (!confirm("Aggiornare le liste da GitHub?")) return;
                setUpdateListsOutput("");
                updateListsMutation.mutate();
              }}
            >
              <RefreshCw className={`w-4 h-4 mr-1 ${updateListsMutation.isPending ? "animate-spin" : ""}`} />
              {updateListsMutation.isPending ? "Aggiornamento..." : "Aggiorna liste"}
            </Button>
          </div>
        </CardHeader>
        {updateListsOutput && (
          <CardContent>
            <pre className="bg-zinc-950 text-zinc-200 text-xs font-mono p-3 rounded-md overflow-auto max-h-48 whitespace-pre-wrap">
              {updateListsOutput}
            </pre>
          </CardContent>
        )}
      </Card>

      {/* Rigenera set */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Rigenera set ipset</CardTitle>
              <CardDescription className="flex items-center gap-1">
                <AlertTriangle className="w-3 h-3 text-yellow-500" />
                Operazione lenta — rigenera l'intero set blocked_asn (può richiedere 1–2 minuti)
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite || updateSetMutation.isPending}
              onClick={() => {
                if (!confirm("Rigenerare l'intero set ipset? L'operazione può richiedere 1-2 minuti.")) return;
                setUpdateSetOutput("");
                updateSetMutation.mutate();
              }}
            >
              <Database className={`w-4 h-4 mr-1 ${updateSetMutation.isPending ? "animate-spin" : ""}`} />
              {updateSetMutation.isPending ? "Rigenerazione..." : "Rigenera set"}
            </Button>
          </div>
        </CardHeader>
        {updateSetOutput && (
          <CardContent>
            <pre className="bg-zinc-950 text-zinc-200 text-xs font-mono p-3 rounded-md overflow-auto max-h-64 whitespace-pre-wrap">
              {updateSetOutput}
            </pre>
          </CardContent>
        )}
      </Card>
    </div>
  );
}

// ─── Whitelist Tab ────────────────────────────────────────────────────────────

function TabWhitelist({ vpsId, canWrite }: { vpsId: string; canWrite: boolean }) {
  const { toast } = useToast();
  const proxy = (path: string) => `/api/vps/${vpsId}/proxy${path}`;
  const [newValue, setNewValue] = useState("");
  const [newComment, setNewComment] = useState("");

  const { data: entries, isLoading, refetch } = useQuery<WhitelistEntry[]>({
    queryKey: [`asn-whitelist-${vpsId}`],
    queryFn: async () => { const r = await apiRequest("GET", proxy("/api/asn/whitelist")); return r.json(); },
    refetchInterval: 60000,
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", proxy("/api/asn/whitelist"), { value: newValue, comment: newComment });
      return r.json();
    },
    onSuccess: (data: any) => {
      if (data.success) {
        refetch();
        setNewValue(""); setNewComment("");
        toast({ title: "Voce aggiunta alla whitelist" });
      } else {
        toast({ title: "Errore", description: data.error, variant: "destructive" });
      }
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (value: string) => {
      const r = await apiRequest("DELETE", proxy("/api/asn/whitelist"), { value });
      return r.json();
    },
    onSuccess: () => { refetch(); toast({ title: "Voce rimossa dalla whitelist" }); },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <Card className="border-blue-500/20 bg-blue-500/5">
        <CardContent className="pt-4">
          <p className="text-sm text-muted-foreground">
            Il set si aggiorna automaticamente entro pochi secondi grazie al watcher inotify. Aggiungi CIDR (es. <code className="font-mono text-xs bg-muted px-1 rounded">1.2.3.0/24</code>) o domini.
          </p>
        </CardContent>
      </Card>

      {canWrite && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Aggiungi alla whitelist</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2 flex-wrap">
              <Input
                placeholder="CIDR o dominio (es. 1.2.3.0/24)"
                value={newValue}
                onChange={e => setNewValue(e.target.value)}
                className="w-52 font-mono"
                onKeyDown={e => e.key === "Enter" && newValue && addMutation.mutate()}
              />
              <Input
                placeholder="Commento (opzionale)"
                value={newComment}
                onChange={e => setNewComment(e.target.value)}
                className="flex-1 min-w-40"
              />
              <Button size="sm" onClick={() => addMutation.mutate()} disabled={!newValue || addMutation.isPending}>
                <Plus className="w-4 h-4 mr-1" />Aggiungi
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Whitelist attuale</CardTitle>
              <CardDescription>{entries?.length ?? 0} voci</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => refetch()}><RefreshCw className="w-4 h-4" /></Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? <LoadingState message="Caricamento..." /> : !entries?.length ? (
            <p className="text-center text-muted-foreground py-8">Whitelist vuota</p>
          ) : (
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Valore</TableHead>
                    <TableHead>Commento</TableHead>
                    {canWrite && <TableHead className="text-right">Azioni</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <Badge variant="outline" className={entry.type === "cidr" ? "border-blue-500 text-blue-400" : "border-purple-500 text-purple-400"}>
                          {entry.type.toUpperCase()}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{entry.value}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{entry.comment || "—"}</TableCell>
                      {canWrite && (
                        <TableCell className="text-right">
                          <Button size="icon" variant="ghost" disabled={deleteMutation.isPending}
                            onClick={() => deleteMutation.mutate(entry.value)}>
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Log Tab ──────────────────────────────────────────────────────────────────

function TabLog({ vpsId }: { vpsId: string }) {
  const proxy = (path: string) => `/api/vps/${vpsId}/proxy${path}`;
  const { data, isLoading, refetch } = useQuery<{ lines: string[] }>({
    queryKey: [`asn-log-${vpsId}`],
    queryFn: async () => { const r = await apiRequest("GET", proxy("/api/asn/log")); return r.json(); },
    refetchInterval: 60000,
  });

  function lineColor(line: string) {
    if (/error|fail|ERR/i.test(line)) return "text-red-400";
    if (/ok|success|done|complet/i.test(line)) return "text-green-400";
    if (/warn/i.test(line)) return "text-yellow-400";
    return "text-zinc-400";
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Log aggiornamenti</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => refetch()}>
            <RefreshCw className="w-4 h-4 mr-1" />Aggiorna
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? <LoadingState message="Caricamento log..." /> : (
          <div className="bg-zinc-950 rounded-md p-3 font-mono text-xs h-96 overflow-y-auto space-y-0.5">
            {(data?.lines || []).length === 0 ? (
              <p className="text-zinc-500 py-4 text-center">Nessun log disponibile</p>
            ) : (
              [...(data?.lines || [])].reverse().map((line, i) => (
                <div key={i} className={lineColor(line)}>{line}</div>
              ))
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Blocklist Tab (existing functionality) ───────────────────────────────────

function TabBlocklist({ selectedVps, setSelectedVps, vpsList, onlineVps }: {
  selectedVps: string;
  setSelectedVps: (v: string) => void;
  vpsList: any[];
  onlineVps: any[];
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [newAsn, setNewAsn] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const { data: bulkResults, isLoading, refetch } = useQuery<BulkResult[]>({
    queryKey: ["asn-block-all", selectedVps],
    queryFn: async () => {
      const r = await apiRequest("POST", "/api/vps/bulk/get", {
        vpsIds: onlineVps.map(v => v.id),
        path: "/api/config/block_asn.conf",
      });
      return r.json();
    },
    enabled: onlineVps.length > 0,
    refetchInterval: 120000,
  });

  const asnMap = new Map<string, { description?: string; presentIn: Set<string> }>();
  const vpsConfigMap = new Map<string, AsnEntry[]>();
  (bulkResults || []).filter(r => r.success && r.data?.content).forEach(r => {
    const entries = parseAsnConfig(r.data.content);
    vpsConfigMap.set(r.vpsId, entries);
    entries.forEach(({ asn, description }) => {
      if (!asnMap.has(asn)) asnMap.set(asn, { description, presentIn: new Set() });
      asnMap.get(asn)!.presentIn.add(r.vpsId);
      if (description && !asnMap.get(asn)!.description) asnMap.get(asn)!.description = description;
    });
  });

  const allAsns = Array.from(asnMap.entries()).map(([asn, data]) => ({ asn, ...data }));
  const filtered = search
    ? allAsns.filter(e => e.asn.includes(search) || (e.description ?? "").toLowerCase().includes(search.toLowerCase()))
    : allAsns;

  const saveAllMutation = useMutation({
    mutationFn: async ({ asn, remove }: { asn: string; remove: boolean }) => {
      return Promise.all(onlineVps.map(async vps => {
        const current = vpsConfigMap.get(vps.id) || [];
        let updated: AsnEntry[];
        if (remove) {
          updated = current.filter(e => e.asn !== asn);
        } else {
          if (current.find(e => e.asn === asn)) return { vpsId: vps.id, vpsName: vps.name, success: true };
          updated = [...current, { asn, description: newDesc || undefined }];
        }
        const r = await apiRequest("POST", `/api/vps/${vps.id}/proxy/api/config/block_asn.conf`, { content: buildAsnConfig(updated) });
        return r.json();
      }));
    },
    onSuccess: (_, vars) => {
      refetch();
      const target = selectedVps === "all" ? "tutti i VPS" : onlineVps[0]?.name ?? "VPS selezionato";
      toast({ title: vars.remove ? `ASN ${vars.asn} rimosso da ${target}` : `ASN ${vars.asn} aggiunto a ${target}` });
      if (!vars.remove) { setNewAsn(""); setNewDesc(""); }
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Aggiungi ASN</CardTitle>
          <CardDescription>{selectedVps === "all" ? "Aggiunge su tutti i VPS online" : `Solo su ${onlineVps[0]?.name ?? "VPS selezionato"}`}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 flex-wrap">
            <Input placeholder="Numero ASN (es. 15169)" value={newAsn} onChange={e => setNewAsn(e.target.value)}
              className="w-48 font-mono" onKeyDown={e => e.key === "Enter" && newAsn && !asnMap.has(newAsn) && saveAllMutation.mutate({ asn: newAsn, remove: false })} />
            <Input placeholder="Descrizione (opzionale)" value={newDesc} onChange={e => setNewDesc(e.target.value)} className="flex-1" />
            <Button onClick={() => saveAllMutation.mutate({ asn: newAsn, remove: false })} disabled={!newAsn || asnMap.has(newAsn) || saveAllMutation.isPending}>
              <Plus className="w-4 h-4 mr-1" />Aggiungi
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle>ASN Bloccati</CardTitle>
              <CardDescription>{allAsns.length} ASN — {selectedVps === "all" ? `${onlineVps.length} VPS online` : onlineVps[0]?.name}</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
              <RefreshCw className="w-4 h-4 mr-1" />Aggiorna
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Cerca ASN o descrizione..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
          </div>
          {search && <p className="text-xs text-muted-foreground">{filtered.length} / {allAsns.length} risultati</p>}
          {isLoading ? <LoadingState message="Caricamento ASN da tutti i VPS..." /> : (
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ASN</TableHead>
                    <TableHead>Descrizione</TableHead>
                    <TableHead>Copertura VPS</TableHead>
                    {onlineVps.map(v => <TableHead key={v.id} className="text-center text-xs">{v.name}</TableHead>)}
                    <TableHead className="text-right">Azioni</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableRow><TableCell colSpan={4 + onlineVps.length} className="text-center py-8 text-muted-foreground">{search ? "Nessun risultato" : "Nessun ASN bloccato"}</TableCell></TableRow>
                  ) : filtered.map(({ asn, description, presentIn }) => (
                    <TableRow key={asn}>
                      <TableCell className="font-mono font-semibold">{asn}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{description || "—"}</TableCell>
                      <TableCell>
                        <Badge variant={presentIn.size === onlineVps.length ? "destructive" : "outline"}>{presentIn.size}/{onlineVps.length} VPS</Badge>
                      </TableCell>
                      {onlineVps.map(v => (
                        <TableCell key={v.id} className="text-center">
                          {presentIn.has(v.id) ? <CheckCircle className="w-4 h-4 text-green-500 inline" /> : <XCircle className="w-4 h-4 text-muted-foreground/30 inline" />}
                        </TableCell>
                      ))}
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" disabled={saveAllMutation.isPending}
                          onClick={() => saveAllMutation.mutate({ asn, remove: true })}>
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AsnBlock() {
  const { user } = useAuth();
  const { data: vpsList } = useVpsList();
  const { data: healthMap } = useVpsHealth();
  const [selectedVps, setSelectedVps] = useState("all");

  const canWrite = user?.role === "admin" || user?.role === "operator";

  const allOnlineVps = (vpsList || []).filter(v => healthMap?.[v.id]);
  const onlineVps = selectedVps === "all" ? allOnlineVps : allOnlineVps.filter(v => v.id === selectedVps);

  // For per-VPS tabs: use the first online VPS or selected one
  const activeVpsId = selectedVps !== "all"
    ? selectedVps
    : allOnlineVps[0]?.id ?? "";

  const activeVpsName = (vpsList || []).find(v => v.id === activeVpsId)?.name ?? "";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-heading font-bold tracking-tight">ASN Block</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Gestione blocco ASN — script ipset su VPS</p>
        </div>
        <Select value={selectedVps} onValueChange={setSelectedVps}>
          <SelectTrigger className="w-44 h-8 text-sm">
            <SelectValue placeholder="Seleziona VPS" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutti i VPS</SelectItem>
            {(vpsList || []).map(v => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Tabs defaultValue="panoramica">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="panoramica"><Activity className="w-3.5 h-3.5 mr-1.5" />Panoramica</TabsTrigger>
          <TabsTrigger value="gestione"><Settings className="w-3.5 h-3.5 mr-1.5" />Gestione</TabsTrigger>
          <TabsTrigger value="whitelist"><Shield className="w-3.5 h-3.5 mr-1.5" />Whitelist</TabsTrigger>
          <TabsTrigger value="log"><FileText className="w-3.5 h-3.5 mr-1.5" />Log</TabsTrigger>
          <TabsTrigger value="blocklist"><Database className="w-3.5 h-3.5 mr-1.5" />Blocklist ASN</TabsTrigger>
        </TabsList>

        {/* Per-VPS banner */}
        {activeVpsId ? (
          <>
            <TabsContent value="panoramica" className="pt-4">
              {activeVpsName && <p className="text-xs text-muted-foreground mb-3 font-mono">VPS: {activeVpsName}</p>}
              <TabPanoramica vpsId={activeVpsId} />
            </TabsContent>
            <TabsContent value="gestione" className="pt-4">
              {activeVpsName && <p className="text-xs text-muted-foreground mb-3 font-mono">VPS: {activeVpsName}</p>}
              <TabGestione vpsId={activeVpsId} canWrite={canWrite} />
            </TabsContent>
            <TabsContent value="whitelist" className="pt-4">
              {activeVpsName && <p className="text-xs text-muted-foreground mb-3 font-mono">VPS: {activeVpsName}</p>}
              <TabWhitelist vpsId={activeVpsId} canWrite={canWrite} />
            </TabsContent>
            <TabsContent value="log" className="pt-4">
              {activeVpsName && <p className="text-xs text-muted-foreground mb-3 font-mono">VPS: {activeVpsName}</p>}
              <TabLog vpsId={activeVpsId} />
            </TabsContent>
          </>
        ) : (
          <>
            {["panoramica", "gestione", "whitelist", "log"].map(tab => (
              <TabsContent key={tab} value={tab} className="pt-4">
                <p className="text-center text-muted-foreground py-12">Nessun VPS online disponibile</p>
              </TabsContent>
            ))}
          </>
        )}

        <TabsContent value="blocklist" className="pt-4">
          <TabBlocklist
            selectedVps={selectedVps}
            setSelectedVps={setSelectedVps}
            vpsList={vpsList || []}
            onlineVps={onlineVps}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
