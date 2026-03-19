import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useVpsList, useVpsHealth } from "@/hooks/use-vps";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LoadingState } from "@/components/loading-state";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle, XCircle, RotateCw, Play, Square, RefreshCw, Wifi, WifiOff, Search, Radio } from "lucide-react";

interface BulkResult { vpsId: string; vpsName: string; success: boolean; data?: any; error?: string; }
interface NetbirdStatus { running: boolean; connected: boolean; }

const SERVICES = ["nginx", "fail2ban", "mariadb"];

function useBulkServices() {
  return useQuery<BulkResult[]>({
    queryKey: ["bulk-services-page"],
    queryFn: async () => {
      const r = await apiRequest("POST", "/api/vps/bulk/get", { vpsIds: "all", path: "/api/services" });
      return r.json();
    },
    refetchInterval: 60000,
  });
}

function useBulkNetbird() {
  return useQuery<BulkResult[]>({
    queryKey: ["bulk-netbird"],
    queryFn: async () => {
      const r = await apiRequest("POST", "/api/vps/bulk/get", { vpsIds: "all", path: "/api/netbird" });
      return r.json();
    },
    refetchInterval: 60000,
  });
}

function StatusDot({ running }: { running: boolean | null }) {
  if (running === null) return <span className="w-2 h-2 rounded-full bg-muted-foreground/30 inline-block" />;
  return running
    ? <CheckCircle className="w-4 h-4 text-green-500 inline" />
    : <XCircle className="w-4 h-4 text-red-500 inline" />;
}

export default function Services() {
  const { toast } = useToast();
  const [selectedVps, setSelectedVps] = useState("all");
  const [search, setSearch] = useState("");
  const { data: vpsList, isLoading } = useVpsList();
  const { data: healthMap, refetch: refetchHealth } = useVpsHealth();
  const { data: bulkServices, refetch: refetchServices } = useBulkServices();
  const { data: bulkNetbird, refetch: refetchNetbird } = useBulkNetbird();

  const bulkActionMutation = useMutation({
    mutationFn: async ({ service, action, vpsIds }: { service: string; action: string; vpsIds: string[] | "all" }) => {
      const r = await apiRequest("POST", "/api/vps/bulk/post", {
        vpsIds,
        path: `/api/services/${service}/action`,
        body: { action },
      });
      return r.json() as Promise<BulkResult[]>;
    },
    onSuccess: (results, vars) => {
      const ok = results.filter(r => r.success).length;
      toast({
        title: `${vars.action} ${vars.service}`,
        description: `${ok}/${results.length} VPS aggiornati`,
        variant: ok === results.length ? "default" : "destructive",
      });
      setTimeout(() => { refetchServices(); refetchHealth(); refetchNetbird(); }, 2000);
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const singleActionMutation = useMutation({
    mutationFn: async ({ vpsId, service, action }: { vpsId: string; service: string; action: string }) => {
      const r = await apiRequest("POST", `/api/vps/${vpsId}/proxy/api/services/${service}/action`, { action });
      return r.json();
    },
    onSuccess: () => {
      setTimeout(() => refetchServices(), 2000);
      toast({ title: "Azione eseguita" });
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const netbirdRestartMutation = useMutation({
    mutationFn: async (vpsId: string) => {
      const r = await apiRequest("POST", `/api/vps/${vpsId}/proxy/api/netbird/restart`, {});
      return r.json();
    },
    onSuccess: () => { setTimeout(() => refetchNetbird(), 3000); toast({ title: "NetBird riavviato" }); },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const netbirdMap: Record<string, NetbirdStatus> = {};
  (bulkNetbird || []).forEach(r => {
    if (r.success && r.data) netbirdMap[r.vpsId] = r.data;
  });

  const isPending = bulkActionMutation.isPending || singleActionMutation.isPending;

  if (isLoading) return <LoadingState message="Caricamento..." />;

  const list = (selectedVps === "all" ? (vpsList || []) : (vpsList || []).filter(v => v.id === selectedVps))
    .filter(v => !search || v.name.toLowerCase().includes(search.toLowerCase()) || v.host?.toLowerCase().includes(search.toLowerCase()));

  // Build services map: vpsId → { nginx: running, fail2ban: running, mariadb: running }
  const servicesMap: Record<string, Record<string, boolean>> = {};
  (bulkServices || []).forEach(r => {
    if (r.success && Array.isArray(r.data)) {
      servicesMap[r.vpsId] = {};
      r.data.forEach((svc: any) => { servicesMap[r.vpsId][svc.name] = svc.status === "running"; });
    }
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-heading font-bold tracking-tight">Gestione Servizi</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Controlla nginx, fail2ban e mariadb su tutti i VPS</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedVps} onValueChange={setSelectedVps}>
            <SelectTrigger className="w-44 h-8 text-sm">
              <SelectValue placeholder="Tutti i VPS" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tutti i VPS</SelectItem>
              {(vpsList || []).map(v => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => { refetchServices(); refetchHealth(); }}>
            <RefreshCw className="w-4 h-4 mr-1" />Aggiorna
          </Button>
        </div>
      </div>

      {/* Azioni bulk */}
      <Card className="border-card-border">
        <CardHeader>
          <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Azioni su tutti i VPS</CardTitle>
          <CardDescription>Esegue l'azione simultaneamente su tutti i VPS online</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {SERVICES.map(svc => (
              <div key={svc} className="flex items-center gap-1.5 border border-border rounded-md p-1.5">
                <span className="text-sm font-mono font-semibold w-20">{svc}</span>
                <Button size="sm" variant="outline" disabled={isPending}
                  onClick={() => bulkActionMutation.mutate({ service: svc, action: "restart", vpsIds: "all" })}>
                  <RotateCw className="w-3 h-3 mr-1" />Restart
                </Button>
                <Button size="sm" variant="outline" disabled={isPending}
                  onClick={() => bulkActionMutation.mutate({ service: svc, action: "start", vpsIds: "all" })}>
                  <Play className="w-3 h-3 mr-1" />Start
                </Button>
                <Button size="sm" variant="outline" disabled={isPending}
                  onClick={() => bulkActionMutation.mutate({ service: svc, action: "stop", vpsIds: "all" })}>
                  <Square className="w-3 h-3 mr-1" />Stop
                </Button>
                {svc === "nginx" && (
                  <Button size="sm" variant="outline" disabled={isPending}
                    onClick={() => bulkActionMutation.mutate({ service: svc, action: "reload", vpsIds: "all" })}>
                    <RefreshCw className="w-3 h-3 mr-1" />Reload
                  </Button>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Ricerca */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input placeholder="Cerca VPS..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
      </div>

      {/* Tabella VPS × Servizi */}
      {list.length === 0 ? (
        <p className="text-center text-muted-foreground py-12">Nessun VPS configurato</p>
      ) : (
        <Card className="border-card-border">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left p-3 text-xs font-heading uppercase tracking-wide text-muted-foreground">VPS</th>
                    <th className="text-left p-3 text-xs font-heading uppercase tracking-wide text-muted-foreground">Stato</th>
                    {SERVICES.map(s => (
                      <th key={s} className="text-center p-3 text-xs font-heading uppercase tracking-wide text-muted-foreground">{s}</th>
                    ))}
                    <th className="text-center p-3 text-xs font-heading uppercase tracking-wide text-muted-foreground">NetBird</th>
                    <th className="text-right p-3 text-xs font-heading uppercase tracking-wide text-muted-foreground">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map(vps => {
                    const online = healthMap?.[vps.id] ?? false;
                    const svcs = servicesMap[vps.id];
                    const nb = netbirdMap[vps.id];
                    return (
                      <tr key={vps.id} className="border-b border-border/50 hover:bg-muted/30">
                        <td className="p-3">
                          <p className="font-medium text-sm">{vps.name}</p>
                          <p className="text-xs font-mono text-muted-foreground">{vps.host}</p>
                        </td>
                        <td className="p-3">
                          <Badge className={online ? "bg-green-600 text-white" : "bg-destructive text-white"}>
                            {online ? <><Wifi className="w-3 h-3 mr-1" />Online</> : <><WifiOff className="w-3 h-3 mr-1" />Offline</>}
                          </Badge>
                        </td>
                        {SERVICES.map(s => (
                          <td key={s} className="p-3 text-center">
                            <StatusDot running={svcs ? (svcs[s] ?? null) : null} />
                          </td>
                        ))}
                        <td className="p-3 text-center">
                          {!nb ? (
                            <span className="w-2 h-2 rounded-full bg-muted-foreground/30 inline-block" />
                          ) : (
                            <div className="flex flex-col items-center gap-0.5">
                              <div className="flex items-center gap-1 text-xs">
                                <StatusDot running={nb.running} />
                                <span className="text-muted-foreground">svc</span>
                              </div>
                              <div className="flex items-center gap-1 text-xs">
                                {nb.connected
                                  ? <Radio className="w-3 h-3 text-green-500" />
                                  : <Radio className="w-3 h-3 text-red-500" />}
                                <span className="text-muted-foreground">:8880</span>
                              </div>
                              <Button size="sm" variant="ghost" className="h-5 px-1 text-xs" disabled={!online || netbirdRestartMutation.isPending}
                                onClick={() => netbirdRestartMutation.mutate(vps.id)} title="Restart NetBird">
                                <RotateCw className="w-3 h-3" />
                              </Button>
                            </div>
                          )}
                        </td>
                        <td className="p-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {SERVICES.map(s => (
                              <Button key={s} size="sm" variant="ghost" disabled={!online || isPending}
                                onClick={() => singleActionMutation.mutate({ vpsId: vps.id, service: s, action: "restart" })}
                                title={`Restart ${s}`}>
                                <RotateCw className="w-3 h-3" />
                                <span className="ml-1 text-xs">{s}</span>
                              </Button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
