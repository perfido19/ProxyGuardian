import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useUpgrade, type VpsStatus } from "@/contexts/upgrade-context";
import { VpsLogCard } from "@/components/vps-log-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { CheckCircle2, XCircle, Loader2, Rocket, RotateCcw, RefreshCw } from "lucide-react";

const TARGET_VERSION = "1.26.2";

interface SafeVps { id: string; name: string; host: string; enabled: boolean; lastStatus?: string; }
interface NginxVersionInfo { vpsId: string; vpsName: string; version: string | null; error: string | null; }

export default function FleetUpgrade() {
  const { pageState, vpsStates, error, startUpgrade, reset } = useUpgrade();

  const { data: vpsList = [] } = useQuery<SafeVps[]>({ queryKey: ["/api/vps"] });
  const { data: nginxVersions = [], isFetching: fetchingVersions, refetch: refetchVersions } = useQuery<NginxVersionInfo[]>({
    queryKey: ["/api/fleet/nginx/versions"],
    queryFn: async () => { const res = await apiRequest("GET", "/api/fleet/nginx/versions"); return res.json(); },
    staleTime: 30000,
  });

  const versionMap = new Map(nginxVersions.map(v => [v.vpsId, v.version]));
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const enabledVps = vpsList.filter(v => v.enabled);
  const allSelected = enabledVps.length > 0 && selectedIds.size === enabledVps.length;
  const totalSelected = selectedIds.size;

  const toggleVps = (id: string) => setSelectedIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const toggleAll = () => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(enabledVps.map(v => v.id)));
  };

  const vpsStateArray = useMemo(() => Array.from(vpsStates.values()).sort((a, b) => {
    const order: Record<VpsStatus, number> = { running: 0, failed: 1, success: 2, pending: 3 };
    return order[a.status] - order[b.status];
  }), [vpsStates]);

  const totalVps = vpsStateArray.length;
  const doneCount = useMemo(() => vpsStateArray.filter(v => v.status === "success" || v.status === "failed").length, [vpsStateArray]);
  const successCount = useMemo(() => vpsStateArray.filter(v => v.status === "success").length, [vpsStateArray]);
  const failCount = useMemo(() => vpsStateArray.filter(v => v.status === "failed").length, [vpsStateArray]);
  const progress = totalVps > 0 ? Math.round((doneCount / totalVps) * 100) : 0;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold font-heading tracking-tight">Fleet Upgrade</h1>
        <p className="text-sm text-muted-foreground mt-1">Nginx 1.26.2 + ModSecurity v3 + OWASP CRS v4</p>
      </div>

      {pageState === "idle" && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm font-heading">Seleziona VPS da aggiornare</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">Target: nginx <span className="font-mono text-primary">{TARGET_VERSION}</span></p>
              </div>
              <div className="flex items-center gap-3">
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => refetchVersions()} disabled={fetchingVersions} title="Aggiorna versioni">
                  <RefreshCw className={`w-3.5 h-3.5 ${fetchingVersions ? "animate-spin" : ""}`} />
                </Button>
                <label className="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors">
                  <Checkbox checked={allSelected} onCheckedChange={toggleAll} className="h-3.5 w-3.5" />
                  Tutti ({enabledVps.length})
                </label>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {enabledVps.length === 0 && <p className="text-sm text-muted-foreground">Nessun VPS abilitato.</p>}
            {enabledVps.map(vps => {
              const version = versionMap.get(vps.id);
              const isUpToDate = version === TARGET_VERSION;
              return (
                <label key={vps.id} className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-muted/40 cursor-pointer transition-colors">
                  <Checkbox checked={selectedIds.has(vps.id)} onCheckedChange={() => toggleVps(vps.id)} className="h-3.5 w-3.5" />
                  <span className="text-sm font-medium flex-1">{vps.name}</span>
                  <span className="text-xs text-muted-foreground font-mono">{vps.host}</span>
                  {fetchingVersions && !version ? (
                    <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                  ) : version ? (
                    <Badge variant="outline" className={`text-[10px] h-4 px-1.5 font-mono ${isUpToDate ? "text-green-600 border-green-500/40 bg-green-500/10" : "text-orange-500 border-orange-500/40 bg-orange-500/10"}`}>
                      {isUpToDate && <CheckCircle2 className="w-2.5 h-2.5 mr-0.5" />}{version}
                    </Badge>
                  ) : null}
                  <div className={`w-1.5 h-1.5 rounded-full ${vps.lastStatus === "online" ? "bg-green-500" : "bg-muted-foreground/40"}`} />
                </label>
              );
            })}
          </CardContent>
        </Card>
      )}

      {error && (
        <div className="bg-red-950/30 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-400 font-mono">{error}</div>
      )}

      <div className="flex items-center gap-3">
        {pageState === "idle" && (
          <Button onClick={() => startUpgrade([...selectedIds])} disabled={totalSelected === 0} className="gap-2">
            <Rocket className="w-4 h-4" />Avvia Upgrade ({totalSelected} VPS)
          </Button>
        )}
        {pageState === "done" && (
          <Button variant="outline" onClick={reset} className="gap-2">
            <RotateCcw className="w-4 h-4" />Nuovo upgrade
          </Button>
        )}
        {pageState === "running" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /><span>Upgrade in corso...</span>
          </div>
        )}
      </div>

      {(pageState === "running" || pageState === "done") && totalVps > 0 && (
        <Card>
          <CardContent className="pt-4 pb-4 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-heading font-medium">Progresso globale</span>
              <span className="font-mono text-muted-foreground">{doneCount}/{totalVps} VPS</span>
            </div>
            <Progress value={progress} className="h-2" />
            <div className="flex gap-4 text-xs">
              <span className="flex items-center gap-1.5 text-green-600"><CheckCircle2 className="w-3 h-3" />{successCount} successi</span>
              <span className="flex items-center gap-1.5 text-red-500"><XCircle className="w-3 h-3" />{failCount} falliti</span>
              {pageState === "running" && (
                <span className="flex items-center gap-1.5 text-blue-500"><Loader2 className="w-3 h-3 animate-spin" />{totalVps - doneCount} in corso</span>
              )}
            </div>
            {pageState === "done" && (
              <div className={`text-sm font-heading font-medium ${failCount === 0 ? "text-green-600" : failCount === totalVps ? "text-red-500" : "text-yellow-600"}`}>
                {failCount === 0 ? "Tutti i VPS aggiornati con successo." : failCount === totalVps ? "Upgrade fallito su tutti i VPS." : `${successCount}/${totalVps} VPS aggiornati. ${failCount} falliti.`}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {vpsStateArray.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-heading font-medium text-muted-foreground uppercase tracking-wider">Dettaglio per VPS</h2>
          {vpsStateArray.map(vps => <VpsLogCard key={vps.vpsId} vps={vps} />)}
        </div>
      )}
    </div>
  );
}
