import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { LoadingState } from "@/components/loading-state";
import {
  CheckCircle2, XCircle, AlertCircle, RefreshCw, Upload,
  Key, ShieldCheck, Server, HardDrive, Zap, Network, FileCode, Flame, RotateCw
} from "lucide-react";

interface NginxCheck {
  streamCacheValid: boolean;
  modsecurityActive: boolean;
  reuseport: boolean;
  upstreamKeepalive: boolean;
  openFileCache: boolean;
  largeProxyBuffers: boolean;
}

interface VpsNginxStatus {
  vpsId: string;
  vpsName: string;
  optimized: boolean;
  checks: NginxCheck;
  cacheSize?: string;
  error: string | null;
}

interface VpsCleanupStatus {
  vpsId: string;
  vpsName: string;
  ready: boolean;
  checks: { dropinInstalled: boolean; scriptInstalled: boolean; serviceInstalled: boolean; serviceEnabled: boolean; ready: boolean } | null;
  error: string | null;
}

interface VpsLogrotateStatus {
  vpsId: string;
  vpsName: string;
  ready: boolean;
  checks: { installed: boolean; upToDate: boolean; ready: boolean } | null;
  error: string | null;
}

const CHECK_LABELS: Record<keyof NginxCheck, { label: string; icon: React.ReactNode }> = {
  streamCacheValid:   { label: "Cache streaming",       icon: <HardDrive className="w-3.5 h-3.5" /> },
  modsecurityActive:  { label: "ModSecurity attivo",    icon: <ShieldCheck className="w-3.5 h-3.5" /> },
  reuseport:          { label: "reuseport",             icon: <Zap className="w-3.5 h-3.5" /> },
  upstreamKeepalive:  { label: "Upstream keepalive",    icon: <Network className="w-3.5 h-3.5" /> },
  openFileCache:      { label: "Open file cache",       icon: <FileCode className="w-3.5 h-3.5" /> },
  largeProxyBuffers:  { label: "Proxy buffers 512k",    icon: <Server className="w-3.5 h-3.5" /> },
};

export default function FleetConfig() {
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState<Record<string, "idle" | "running" | "ok" | "error">>({});
  const [installing, setInstalling] = useState<Record<string, "idle" | "running" | "ok" | "error">>({});
  const [cleanupApplying, setCleanupApplying] = useState<Record<string, "idle" | "running" | "ok" | "error">>({});
  const [logrotateApplying, setLogrotateApplying] = useState<Record<string, "idle" | "running" | "ok" | "error">>({});
  const [templateOpen, setTemplateOpen] = useState(false);

  const { data: statuses, isLoading, refetch, isFetching } = useQuery<VpsNginxStatus[]>({
    queryKey: ["/api/fleet/nginx/status"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/fleet/nginx/status");
      return res.json();
    },
    staleTime: 30000,
  });

  const { data: templateData } = useQuery<{ content: string }>({
    queryKey: ["/api/fleet/nginx/template"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/fleet/nginx/template");
      return res.json();
    },
    enabled: templateOpen,
  });

  const { data: cleanupStatuses, refetch: refetchCleanup } = useQuery<VpsCleanupStatus[]>({
    queryKey: ["/api/fleet/netbird/cleanup-status"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/fleet/netbird/cleanup-status");
      return res.json();
    },
    staleTime: 30000,
  });

  const { data: logrotateStatuses, refetch: refetchLogrotate } = useQuery<VpsLogrotateStatus[]>({
    queryKey: ["/api/fleet/logrotate/status"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/fleet/logrotate/status");
      return res.json();
    },
    staleTime: 30000,
  });

  const { data: sshKeyData } = useQuery<{ key: string }>({
    queryKey: ["/api/fleet/ssh-key"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/fleet/ssh-key");
      return res.json();
    },
  });

  const toggleAll = () => {
    if (!statuses) return;
    const nonOptimized = statuses.filter(s => !s.optimized && !s.error).map(s => s.vpsId);
    if (selected.size === nonOptimized.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(nonOptimized));
    }
  };

  const toggleVps = (vpsId: string) => {
    const next = new Set(selected);
    if (next.has(vpsId)) next.delete(vpsId);
    else next.add(vpsId);
    setSelected(next);
  };

  const applyConfig = async (vpsIds: string[]) => {
    const next: Record<string, "idle" | "running" | "ok" | "error"> = { ...applying };
    vpsIds.forEach(id => { next[id] = "running"; });
    setApplying(next);
    try {
      const res = await apiRequest("POST", "/api/fleet/nginx/apply", { vpsIds });
      const results: Array<{ vpsId: string; vpsName: string; ok: boolean; error?: string }> = await res.json();
      const updated: Record<string, "idle" | "running" | "ok" | "error"> = { ...applying };
      results.forEach(r => { updated[r.vpsId] = r.ok ? "ok" : "error"; });
      setApplying(updated);
      const failed = results.filter(r => !r.ok);
      if (failed.length === 0) {
        toast({ title: "Config applicata", description: `${results.length} VPS aggiornati con successo` });
      } else {
        toast({ title: "Applicazione parziale", description: `${failed.length} VPS falliti: ${failed.map(f => f.vpsName).join(", ")}`, variant: "destructive" });
      }
      setSelected(new Set());
      setTimeout(() => refetch(), 1500);
    } catch (e: any) {
      vpsIds.forEach(id => { next[id] = "error"; });
      setApplying({ ...next });
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  const applyCleanup = async (vpsIds: string[]) => {
    const next: Record<string, "idle" | "running" | "ok" | "error"> = { ...cleanupApplying };
    vpsIds.forEach(id => { next[id] = "running"; });
    setCleanupApplying(next);
    try {
      const res = await apiRequest("POST", "/api/fleet/netbird/setup-cleanup", { vpsIds });
      const results: Array<{ vpsId: string; vpsName: string; ok: boolean; error?: string }> = await res.json();
      const updated: Record<string, "idle" | "running" | "ok" | "error"> = { ...cleanupApplying };
      results.forEach(r => { updated[r.vpsId] = r.ok ? "ok" : "error"; });
      setCleanupApplying(updated);
      const failed = results.filter(r => !r.ok);
      if (failed.length === 0) {
        toast({ title: "IPSet Cleanup installato", description: `${results.length} VPS aggiornati` });
      } else {
        toast({ title: "Setup parziale", description: `${failed.length} VPS falliti: ${failed.map(f => f.vpsName).join(", ")}`, variant: "destructive" });
      }
      setTimeout(() => refetchCleanup(), 1500);
    } catch (e: any) {
      vpsIds.forEach(id => { next[id] = "error"; });
      setCleanupApplying({ ...next });
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  const applyLogrotate = async (vpsIds: string[]) => {
    const next: Record<string, "idle" | "running" | "ok" | "error"> = { ...logrotateApplying };
    vpsIds.forEach(id => { next[id] = "running"; });
    setLogrotateApplying(next);
    try {
      const res = await apiRequest("POST", "/api/fleet/logrotate/setup", { vpsIds });
      const results: Array<{ vpsId: string; vpsName: string; ok: boolean; error?: string }> = await res.json();
      const updated: Record<string, "idle" | "running" | "ok" | "error"> = { ...logrotateApplying };
      results.forEach(r => { updated[r.vpsId] = r.ok ? "ok" : "error"; });
      setLogrotateApplying(updated);
      const failed = results.filter(r => !r.ok);
      if (failed.length === 0) {
        toast({ title: "Logrotate configurato", description: `${results.length} VPS aggiornati` });
      } else {
        toast({ title: "Setup parziale", description: `${failed.length} VPS falliti: ${failed.map(f => f.vpsName).join(", ")}`, variant: "destructive" });
      }
      setTimeout(() => refetchLogrotate(), 1500);
    } catch (e: any) {
      vpsIds.forEach(id => { next[id] = "error"; });
      setLogrotateApplying({ ...next });
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  const installSshKey = async (vpsId: string) => {
    setInstalling(prev => ({ ...prev, [vpsId]: "running" }));
    try {
      const res = await apiRequest("POST", `/api/fleet/ssh-key/install/${vpsId}`);
      const data = await res.json();
      setInstalling(prev => ({ ...prev, [vpsId]: data.ok ? "ok" : "error" }));
      toast({
        title: data.ok ? "Chiave SSH installata" : "Errore installazione",
        description: data.message || data.error,
        variant: data.ok ? "default" : "destructive",
      });
    } catch (e: any) {
      setInstalling(prev => ({ ...prev, [vpsId]: "error" }));
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  const nonOptimizedIds = (statuses || []).filter(s => !s.optimized && !s.error).map(s => s.vpsId);
  const optimizedCount = (statuses || []).filter(s => s.optimized).length;
  const totalCount = (statuses || []).length;

  if (isLoading) return <LoadingState message="Controllo configurazioni nginx..." />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-heading tracking-tight">Fleet Config</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Gestione e deploy configurazione nginx ottimizzata su tutti i VPS
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="gap-1.5">
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Aggiorna
          </Button>
          <Button variant="outline" size="sm" onClick={() => setTemplateOpen(true)} className="gap-1.5">
            <FileCode className="w-3.5 h-3.5" />
            Vedi template
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              const allIds = (statuses || []).filter(s => !s.error).map(s => s.vpsId);
              if (allIds.length > 0) applyConfig(allIds);
            }}
            disabled={!statuses || statuses.filter(s => !s.error).length === 0}
            className="gap-1.5"
          >
            <Upload className="w-3.5 h-3.5" />
            Forza applica nginx
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              const notReady = (cleanupStatuses || []).filter(c => !c.ready && !c.error).map(c => c.vpsId);
              const allIds = notReady.length > 0 ? notReady : (cleanupStatuses || []).filter(c => !c.error).map(c => c.vpsId);
              if (allIds.length > 0) applyCleanup(allIds);
            }}
            disabled={!cleanupStatuses || cleanupStatuses.filter(c => !c.error).length === 0}
            className="gap-1.5"
          >
            <Flame className="w-3.5 h-3.5" />
            Applica cleanup
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              const notReady = (logrotateStatuses || []).filter(l => !l.ready && !l.error).map(l => l.vpsId);
              const allIds = notReady.length > 0 ? notReady : (logrotateStatuses || []).filter(l => !l.error).map(l => l.vpsId);
              if (allIds.length > 0) applyLogrotate(allIds);
            }}
            disabled={!logrotateStatuses || logrotateStatuses.filter(l => !l.error).length === 0}
            className="gap-1.5"
          >
            <RotateCw className="w-3.5 h-3.5" />
            Applica logrotate
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-green-500/10 flex items-center justify-center">
                <CheckCircle2 className="w-5 h-5 text-green-500" />
              </div>
              <div>
                <div className="text-2xl font-bold font-heading">{optimizedCount}/{totalCount}</div>
                <div className="text-xs text-muted-foreground">VPS ottimizzati</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-orange-500/10 flex items-center justify-center">
                <AlertCircle className="w-5 h-5 text-orange-500" />
              </div>
              <div>
                <div className="text-2xl font-bold font-heading">{totalCount - optimizedCount}</div>
                <div className="text-xs text-muted-foreground">Da aggiornare</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <Key className="w-5 h-5 text-blue-500" />
              </div>
              <div>
                <div className="text-xs font-mono text-muted-foreground truncate max-w-[160px]">
                  {sshKeyData?.key ? sshKeyData.key.split(" ").slice(0, 2).join(" ").slice(0, 40) + "…" : "—"}
                </div>
                <div className="text-xs text-muted-foreground">Chiave SSH dashboard</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base font-heading">Stato nginx per VPS</CardTitle>
              <CardDescription className="text-xs mt-0.5">
                Seleziona i VPS non ottimizzati e applica la config standard
              </CardDescription>
            </div>
            {selected.size > 0 && (
              <Button
                size="sm"
                onClick={() => applyConfig(Array.from(selected))}
                className="gap-1.5"
              >
                <Upload className="w-3.5 h-3.5" />
                Applica config ({selected.size})
              </Button>
            )}
            {nonOptimizedIds.length > 0 && selected.size === 0 && (
              <Button variant="outline" size="sm" onClick={toggleAll} className="gap-1.5">
                Seleziona tutti da aggiornare
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 pl-4">
                  <Checkbox
                    checked={nonOptimizedIds.length > 0 && selected.size === nonOptimizedIds.length}
                    onCheckedChange={toggleAll}
                  />
                </TableHead>
                <TableHead>VPS</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Cache</TableHead>
                <TableHead>ModSec</TableHead>
                <TableHead>Reuseport</TableHead>
                <TableHead>Keepalive</TableHead>
                <TableHead>File cache</TableHead>
                <TableHead>Buffers</TableHead>
                <TableHead>IPSet Cleanup</TableHead>
                <TableHead>Logrotate</TableHead>
                <TableHead>SSH Key</TableHead>
                <TableHead className="text-right pr-4">Azioni</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(statuses || []).map(vps => {
                const applyState = applying[vps.vpsId] || "idle";
                const sshState = installing[vps.vpsId] || "idle";
                const cleanupState = cleanupApplying[vps.vpsId] || "idle";
                const cleanupVps = cleanupStatuses?.find(c => c.vpsId === vps.vpsId);
                const logrotateState = logrotateApplying[vps.vpsId] || "idle";
                const logrotateVps = logrotateStatuses?.find(l => l.vpsId === vps.vpsId);
                const isSelectable = !vps.optimized && !vps.error;
                return (
                  <TableRow key={vps.vpsId} className={selected.has(vps.vpsId) ? "bg-muted/30" : ""}>
                    <TableCell className="pl-4">
                      <Checkbox
                        checked={selected.has(vps.vpsId)}
                        onCheckedChange={() => isSelectable && toggleVps(vps.vpsId)}
                        disabled={!isSelectable}
                      />
                    </TableCell>
                    <TableCell className="font-medium font-heading">{vps.vpsName}</TableCell>
                    <TableCell>
                      {vps.error ? (
                        <Badge variant="destructive" className="text-[10px] gap-1">
                          <XCircle className="w-3 h-3" /> Errore
                        </Badge>
                      ) : vps.optimized ? (
                        <Badge className="text-[10px] gap-1 bg-green-500/15 text-green-600 border-green-500/30 hover:bg-green-500/20">
                          <CheckCircle2 className="w-3 h-3" /> Ottimizzato
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] gap-1 text-orange-500 border-orange-500/30">
                          <AlertCircle className="w-3 h-3" /> Da aggiornare
                        </Badge>
                      )}
                    </TableCell>
                    {(["streamCacheValid", "modsecurityActive", "reuseport", "upstreamKeepalive", "openFileCache", "largeProxyBuffers"] as (keyof NginxCheck)[]).map(key => (
                      <TableCell key={key}>
                        {vps.error ? (
                          <span className="text-muted-foreground">—</span>
                        ) : vps.checks[key] ? (
                          <div className="flex items-center gap-1">
                            <CheckCircle2 className="w-4 h-4 text-green-500" />
                            {key === "streamCacheValid" && vps.cacheSize && (
                              <span className="text-[10px] text-muted-foreground font-mono">{vps.cacheSize}</span>
                            )}
                          </div>
                        ) : (
                          <XCircle className="w-4 h-4 text-red-400" />
                        )}
                      </TableCell>
                    ))}
                    <TableCell>
                      {cleanupState === "running" ? (
                        <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />
                      ) : cleanupState === "ok" || cleanupVps?.ready ? (
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                      ) : cleanupState === "error" ? (
                        <XCircle className="w-4 h-4 text-red-400" />
                      ) : cleanupVps?.error ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <XCircle className="w-4 h-4 text-red-400" />
                      )}
                    </TableCell>
                    <TableCell>
                      {logrotateState === "running" ? (
                        <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />
                      ) : logrotateState === "ok" || logrotateVps?.ready ? (
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                      ) : logrotateState === "error" ? (
                        <XCircle className="w-4 h-4 text-red-400" />
                      ) : logrotateVps?.error ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <XCircle className="w-4 h-4 text-red-400" />
                      )}
                    </TableCell>
                    <TableCell>
                      {sshState === "ok" ? (
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                      ) : sshState === "error" ? (
                        <XCircle className="w-4 h-4 text-red-400" />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right pr-4">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs gap-1"
                          disabled={sshState === "running"}
                          onClick={() => installSshKey(vps.vpsId)}
                          title="Installa chiave SSH per Fleet Upgrade"
                        >
                          {sshState === "running" ? (
                            <RefreshCw className="w-3 h-3 animate-spin" />
                          ) : (
                            <Key className="w-3 h-3" />
                          )}
                          SSH
                        </Button>
                        {!vps.optimized && !vps.error && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs gap-1"
                            disabled={applyState === "running"}
                            onClick={() => applyConfig([vps.vpsId])}
                          >
                            {applyState === "running" ? (
                              <RefreshCw className="w-3 h-3 animate-spin" />
                            ) : applyState === "ok" ? (
                              <CheckCircle2 className="w-3 h-3 text-green-500" />
                            ) : applyState === "error" ? (
                              <XCircle className="w-3 h-3 text-red-400" />
                            ) : (
                              <Upload className="w-3 h-3" />
                            )}
                            Applica
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Template dialog */}
      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="font-heading">nginx-template.conf</DialogTitle>
          </DialogHeader>
          <div className="overflow-auto flex-1">
            <pre className="text-xs font-mono bg-muted/50 rounded-lg p-4 whitespace-pre overflow-x-auto">
              {templateData?.content || "Caricamento..."}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
