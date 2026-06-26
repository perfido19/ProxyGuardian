import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Shield, ShieldCheck, ShieldX, ShieldOff, RefreshCw, Plus, Trash2, Upload, Search, CheckCircle2, XCircle, AlertTriangle, BarChart2, Loader2 } from "lucide-react";

interface VpsSummary {
  vpsId: string;
  vpsName: string;
  installed: boolean;
  crowdsecActive: boolean;
  bouncerActive: boolean;
  activeDecisions: number;
  error: string | null;
}

interface Decision {
  id: number;
  origin: string;
  scenario: string;
  scope: string;
  value: string;
  type: string;
  duration: string;
  until?: string;
}

interface FleetDecisionGroup {
  vpsId: string;
  vpsName: string;
  decisions: Decision[];
  skipped?: boolean;
  error?: string;
}

interface Scenario {
  name: string;
  content: string;
}

interface FleetMetricsGroup {
  vpsId: string;
  vpsName: string;
  metrics: any;
  skipped?: boolean;
  error?: string;
}

const SCENARIO_TEMPLATE = `type: leaky
name: local/nuovo-scenario
description: "Descrizione dello scenario"
filter: "evt.Meta.log_type == 'http_access-log' and evt.Parsed.status == '404'"
groupby: "evt.Parsed.remote_addr"
capacity: 10
leakspeed: "30s"
blackhole: "1h"
labels:
  service: http
  type: bruteforce
  remediation: true
`;

// ─── Overview tab ─────────────────────────────────────────────────────────────

function OverviewTab() {
  const { data, isLoading, refetch } = useQuery<VpsSummary[]>({
    queryKey: ["fleet-crowdsec-summary"],
    queryFn: async () => { const r = await apiRequest("GET", "/api/fleet/crowdsec/summary"); return r.json(); },
    refetchInterval: 60000,
  });

  const installed = data ? data.filter(v => v.installed) : [];
  const totalDecisions = installed.reduce((s, v) => s + v.activeDecisions, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-4">
          <div className="text-center">
            <div className="text-2xl font-bold font-mono">{installed.length}</div>
            <div className="text-xs text-muted-foreground">VPS con CrowdSec</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold font-mono text-destructive">{totalDecisions}</div>
            <div className="text-xs text-muted-foreground">Ban attivi (fleet)</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold font-mono text-green-500">
              {installed.filter(v => v.crowdsecActive && v.bouncerActive).length}
            </div>
            <div className="text-xs text-muted-foreground">Attivi + bouncer</div>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()}>
          <RefreshCw className="w-4 h-4 mr-1" />Aggiorna
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />Caricamento...
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {(data || []).map(vps => (
            <Card key={vps.vpsId} className={`border ${vps.installed ? (vps.crowdsecActive && vps.bouncerActive ? "border-green-500/30 bg-green-500/5" : "border-orange-500/30 bg-orange-500/5") : "border-border"}`}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm font-mono">{vps.vpsName}</span>
                  {vps.installed
                    ? <ShieldCheck className={`w-4 h-4 ${vps.crowdsecActive ? "text-green-500" : "text-orange-400"}`} />
                    : <ShieldX className="w-4 h-4 text-muted-foreground" />}
                </div>
                {vps.error && <p className="text-xs text-destructive truncate">{vps.error}</p>}
                {!vps.installed && !vps.error && (
                  <p className="text-xs text-muted-foreground">Non installato</p>
                )}
                {vps.installed && (
                  <div className="flex gap-1.5 flex-wrap">
                    <Badge variant="outline" className={`text-xs ${vps.crowdsecActive ? "text-green-400 border-green-500/30" : "text-orange-400 border-orange-500/30"}`}>
                      daemon {vps.crowdsecActive ? "up" : "down"}
                    </Badge>
                    <Badge variant="outline" className={`text-xs ${vps.bouncerActive ? "text-green-400 border-green-500/30" : "text-orange-400 border-orange-500/30"}`}>
                      bouncer {vps.bouncerActive ? "up" : "down"}
                    </Badge>
                    {vps.activeDecisions > 0 && (
                      <Badge className="text-xs bg-destructive text-white">{vps.activeDecisions} ban</Badge>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Decisioni tab ────────────────────────────────────────────────────────────

function DecisioniTab() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");

  const { data, isLoading, refetch } = useQuery<FleetDecisionGroup[]>({
    queryKey: ["fleet-crowdsec-decisions"],
    queryFn: async () => { const r = await apiRequest("GET", "/api/fleet/crowdsec/decisions"); return r.json(); },
    refetchInterval: 30000,
  });

  // Deduplicate decisions by ID (all VPS share same LAPI)
  const seen = new Set<number>();
  const allDecisions: (Decision & { vpsName: string })[] = [];
  for (const group of data || []) {
    if (group.skipped || group.error) continue;
    for (const d of group.decisions) {
      if (!seen.has(d.id)) {
        seen.add(d.id);
        allDecisions.push({ ...d, vpsName: group.vpsName });
      }
    }
  }

  const filtered = allDecisions.filter(d => {
    if (!search) return true;
    const q = search.toLowerCase();
    return d.value.includes(q) || (d.scenario || "").toLowerCase().includes(q) || (d.origin || "").toLowerCase().includes(q);
  });

  const unbanMutation = useMutation({
    mutationFn: async (ip: string) => {
      const r = await apiRequest("POST", "/api/fleet/crowdsec/unban", { ip });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fleet-crowdsec-decisions"] });
      toast({ title: "IP sbloccato da CrowdSec fleet" });
    },
    onError: (e: any) => toast({ title: "Errore unban", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Cerca IP, scenario..." value={search} onChange={e => setSearch(e.target.value)} className="pl-8" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{allDecisions.length} ban totali</span>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            <RefreshCw className="w-4 h-4 mr-1" />Aggiorna
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />Caricamento decisioni...
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-center text-muted-foreground py-12">
          {allDecisions.length === 0 ? "Nessun ban CrowdSec attivo nella fleet" : "Nessun risultato per la ricerca"}
        </p>
      ) : (
        <div className="border rounded-md overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>IP / Valore</TableHead>
                <TableHead>Scenario</TableHead>
                <TableHead>Origine</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Scadenza</TableHead>
                <TableHead className="text-right">Azioni</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(d => (
                <TableRow key={d.id}>
                  <TableCell className="font-mono text-sm">{d.value}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate font-mono" title={d.scenario}>{d.scenario || "—"}</TableCell>
                  <TableCell><Badge variant="outline" className="text-xs">{d.origin}</Badge></TableCell>
                  <TableCell><Badge className="bg-destructive/80 text-white text-xs">{d.type}</Badge></TableCell>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{d.duration || d.until || "—"}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => unbanMutation.mutate(d.value)}
                      disabled={unbanMutation.isPending}
                      className="text-xs"
                    >
                      <ShieldOff className="w-3 h-3 mr-1" />Sblocca
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ─── Scenari tab ──────────────────────────────────────────────────────────────

function ScenariTab() {
  const { toast } = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const { data: scenarios, isLoading, refetch } = useQuery<Scenario[]>({
    queryKey: ["crowdsec-scenarios"],
    queryFn: async () => { const r = await apiRequest("GET", "/api/crowdsec/scenarios"); return r.json(); },
  });

  useEffect(() => {
    if (selected) {
      const s = (scenarios || []).find(sc => sc.name === selected);
      if (s) setEditContent(s.content);
    }
  }, [selected, scenarios]);

  const saveMutation = useMutation({
    mutationFn: async ({ name, content }: { name: string; content: string }) => {
      const r = await apiRequest("POST", `/api/crowdsec/scenarios/${name}`, { content });
      return r.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["crowdsec-scenarios"] });
      const deployed = (data.deploy || []).filter((d: any) => d.ok).length;
      const total = (data.deploy || []).filter((d: any) => d.reason !== "not installed").length;
      toast({ title: "Scenario salvato e deployato", description: `${deployed}/${total} VPS aggiornati` });
    },
    onError: (e: any) => toast({ title: "Errore salvataggio", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (name: string) => {
      const r = await apiRequest("DELETE", `/api/crowdsec/scenarios/${name}`);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["crowdsec-scenarios"] });
      setSelected(null);
      setEditContent("");
      toast({ title: "Scenario eliminato dalla fleet" });
    },
    onError: (e: any) => toast({ title: "Errore eliminazione", description: e.message, variant: "destructive" }),
  });

  const handleCreate = () => {
    const name = newName.trim().replace(/[^a-zA-Z0-9_-]/g, "-");
    if (!name) return;
    const content = SCENARIO_TEMPLATE.replace("local/nuovo-scenario", `local/${name}`);
    setSelected(name);
    setEditContent(content);
    setCreating(false);
    setNewName("");
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 min-h-[500px]">
      {/* Left: scenario list */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-muted-foreground">{(scenarios || []).length} scenari</span>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={() => refetch()} className="h-7 px-2">
              <RefreshCw className="w-3 h-3" />
            </Button>
            <Button size="sm" variant="outline" onClick={() => setCreating(true)} className="h-7 px-2">
              <Plus className="w-3 h-3" />
            </Button>
          </div>
        </div>

        {creating && (
          <div className="flex gap-1">
            <Input
              placeholder="nome-scenario"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setCreating(false); }}
              className="h-7 text-xs font-mono"
              autoFocus
            />
            <Button size="sm" className="h-7 px-2" onClick={handleCreate}>OK</Button>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-4 justify-center text-sm">
            <Loader2 className="w-3 h-3 animate-spin" />
          </div>
        ) : (
          <div className="space-y-0.5 border rounded-md overflow-hidden">
            {(scenarios || []).map(sc => (
              <button
                key={sc.name}
                onClick={() => { setSelected(sc.name); setEditContent(sc.content); }}
                className={`w-full text-left px-3 py-2 text-xs font-mono truncate transition-colors ${selected === sc.name ? "bg-primary/10 text-primary border-l-2 border-primary" : "hover:bg-muted/50 text-muted-foreground"}`}
              >
                {sc.name}
              </button>
            ))}
            {!(scenarios || []).length && (
              <p className="text-center text-muted-foreground text-xs py-4">Nessuno scenario</p>
            )}
          </div>
        )}
      </div>

      {/* Right: editor */}
      <div className="md:col-span-2 space-y-3">
        {selected ? (
          <>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="font-mono text-sm font-medium">{selected}.yaml</span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => { if (confirm(`Eliminare ${selected}?`)) deleteMutation.mutate(selected); }}
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 className="w-3 h-3 mr-1" />Elimina
                </Button>
                <Button
                  size="sm"
                  onClick={() => saveMutation.mutate({ name: selected, content: editContent })}
                  disabled={saveMutation.isPending}
                >
                  {saveMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Upload className="w-3 h-3 mr-1" />}
                  Salva e Deploya
                </Button>
              </div>
            </div>
            <Textarea
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              className="font-mono text-xs min-h-[420px] resize-y bg-muted/30"
              spellCheck={false}
            />
            {saveMutation.data && (
              <div className="text-xs space-y-1 border rounded-md p-3 bg-muted/20">
                <p className="font-medium mb-1">Deploy results:</p>
                {(saveMutation.data.deploy || []).map((r: any, i: number) => (
                  <div key={i} className="flex items-center gap-2">
                    {r.ok
                      ? <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />
                      : <XCircle className="w-3 h-3 text-muted-foreground shrink-0" />}
                    <span className={`font-mono ${r.ok ? "text-foreground" : "text-muted-foreground"}`}>{r.vpsName || "?"}</span>
                    {!r.ok && r.reason && <span className="text-muted-foreground">{r.reason}</span>}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-full min-h-[200px] text-muted-foreground text-sm border rounded-md border-dashed">
            Seleziona uno scenario o crea uno nuovo
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Metriche tab ─────────────────────────────────────────────────────────────

function MetricheTab() {
  const { data, isLoading, refetch } = useQuery<FleetMetricsGroup[]>({
    queryKey: ["fleet-crowdsec-metrics"],
    queryFn: async () => { const r = await apiRequest("GET", "/api/fleet/crowdsec/metrics"); return r.json(); },
    refetchInterval: 120000,
  });

  const installedVps = (data || []).filter(g => !g.skipped && g.metrics);

  // Aggregate scenario metrics across VPS (cscli metrics -o json uses key "scenarios")
  const bucketMap: Record<string, { pour: number; overflow: number; underflow: number; instantiation: number; curr_count: number; vps: string[] }> = {};
  for (const group of installedVps) {
    const scenarios = group.metrics?.scenarios || {};
    for (const [scenario, stats] of Object.entries<any>(scenarios)) {
      if (!bucketMap[scenario]) bucketMap[scenario] = { pour: 0, overflow: 0, underflow: 0, instantiation: 0, curr_count: 0, vps: [] };
      bucketMap[scenario].pour += stats.pour || 0;
      bucketMap[scenario].overflow += stats.overflow || 0;
      bucketMap[scenario].underflow += stats.underflow || 0;
      bucketMap[scenario].instantiation += stats.instantiation || 0;
      bucketMap[scenario].curr_count += stats.curr_count || 0;
      if (!bucketMap[scenario].vps.includes(group.vpsName)) bucketMap[scenario].vps.push(group.vpsName);
    }
  }
  const buckets = Object.entries(bucketMap).sort((a, b) => b[1].overflow - a[1].overflow);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">Dati da {installedVps.length} VPS con CrowdSec</span>
        <Button size="sm" variant="outline" onClick={() => refetch()}>
          <RefreshCw className="w-4 h-4 mr-1" />Aggiorna
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />Caricamento metriche...
        </div>
      ) : buckets.length === 0 ? (
        <p className="text-center text-muted-foreground py-12">Nessuna metrica disponibile — CrowdSec non installato o dati insufficienti</p>
      ) : (
        <>
          <div className="border rounded-md overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Scenario</TableHead>
                  <TableHead className="text-right">Pour</TableHead>
                  <TableHead className="text-right">Overflow (ban)</TableHead>
                  <TableHead className="text-right">Underflow</TableHead>
                  <TableHead className="text-right">Attivi</TableHead>
                  <TableHead>VPS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {buckets.map(([name, s]) => (
                  <TableRow key={name}>
                    <TableCell className="font-mono text-xs">{name}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{s.pour.toLocaleString()}</TableCell>
                    <TableCell className={`text-right font-mono text-sm font-bold ${s.overflow > 0 ? "text-red-400" : "text-muted-foreground"}`}>
                      {s.overflow.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">{s.underflow.toLocaleString()}</TableCell>
                    <TableCell className={`text-right font-mono text-sm ${s.curr_count > 0 ? "text-orange-400" : "text-muted-foreground"}`}>{s.curr_count}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{s.vps.join(", ")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Per-VPS acquisition stats */}
          {installedVps.map(group => {
            const acq = group.metrics?.acquisition || {};
            if (!Object.keys(acq).length) return null;
            return (
              <Card key={group.vpsId} className="border-border/50">
                <CardHeader className="py-3 px-4">
                  <CardTitle className="text-sm font-mono">{group.vpsName} — Acquisizione log</CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-3">
                  <div className="space-y-1">
                    {Object.entries<any>(acq).map(([src, stats]) => (
                      <div key={src} className="flex items-center gap-4 text-xs">
                        <span className="font-mono text-muted-foreground truncate max-w-[300px]" title={src}>{src}</span>
                        <span className="ml-auto text-foreground">{(stats.reads || 0).toLocaleString()} lette</span>
                        <span className="text-green-500">{(stats.parsed || 0).toLocaleString()} parsed</span>
                        <span className="text-muted-foreground">{(stats.unparsed || 0).toLocaleString()} unparsed</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function CrowdSecPage() {
  const [tab, setTab] = useState("overview");

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Shield className="w-6 h-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold font-heading">CrowdSec</h1>
          <p className="text-sm text-muted-foreground">Fleet IDS/IPS — scenari, ban e metriche</p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="decisioni">Decisioni</TabsTrigger>
          <TabsTrigger value="scenari">Scenari</TabsTrigger>
          <TabsTrigger value="metriche">Metriche</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-4">
          <OverviewTab />
        </TabsContent>

        <TabsContent value="decisioni" className="pt-4">
          <DecisioniTab />
        </TabsContent>

        <TabsContent value="scenari" className="pt-4">
          <ScenariTab />
        </TabsContent>

        <TabsContent value="metriche" className="pt-4">
          <MetricheTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
