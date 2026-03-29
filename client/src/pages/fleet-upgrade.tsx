import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Rocket,
  RotateCcw,
  Download,
  RefreshCw,
} from "lucide-react";

const TARGET_VERSION = "1.26.2";

// ─── Tipi ─────────────────────────────────────────────────────────────────────

interface SafeVps {
  id: string;
  name: string;
  host: string;
  enabled: boolean;
  lastStatus?: string;
}

type VpsStatus = "pending" | "running" | "success" | "failed";

interface VpsState {
  vpsId: string;
  vpsName: string;
  vpsHost: string;
  status: VpsStatus;
  logs: string[];
  error?: string;
}

type PageState = "idle" | "running" | "done";

// ─── Componente log per VPS ───────────────────────────────────────────────────

function VpsLogCard({ vps }: { vps: VpsState }) {
  const [open, setOpen] = useState(vps.status === "running" || vps.status === "failed");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll quando arrivano nuovi log
  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [vps.logs.length, open]);

  // Apri automaticamente se inizia o fallisce
  useEffect(() => {
    if (vps.status === "running" || vps.status === "failed") setOpen(true);
  }, [vps.status]);

  const statusIcon = {
    pending: <div className="w-3 h-3 rounded-full bg-muted-foreground/40" />,
    running: <Loader2 className="w-3 h-3 animate-spin text-blue-500" />,
    success: <CheckCircle2 className="w-3 h-3 text-green-500" />,
    failed: <XCircle className="w-3 h-3 text-red-500" />,
  }[vps.status];

  const statusBadge = {
    pending: <Badge variant="outline" className="text-[10px] h-4 px-1.5">In attesa</Badge>,
    running: <Badge variant="secondary" className="text-[10px] h-4 px-1.5 bg-blue-500/10 text-blue-600 border-blue-500/30">Upgrade...</Badge>,
    success: <Badge variant="secondary" className="text-[10px] h-4 px-1.5 bg-green-500/10 text-green-600 border-green-500/30">Completato</Badge>,
    failed: <Badge variant="destructive" className="text-[10px] h-4 px-1.5">Fallito</Badge>,
  }[vps.status];

  const downloadLog = useCallback(() => {
    const blob = new Blob([vps.logs.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `upgrade-${vps.vpsName.replace(/\s+/g, "-")}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [vps.logs, vps.vpsName]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border border-border rounded-lg overflow-hidden">
        <CollapsibleTrigger asChild>
          <div className="flex items-center justify-between px-4 py-2.5 cursor-pointer hover:bg-muted/30 transition-colors">
            <div className="flex items-center gap-2.5">
              {statusIcon}
              <span className="text-sm font-heading font-medium">{vps.vpsName}</span>
              <span className="text-xs text-muted-foreground font-mono">{vps.vpsHost}</span>
              {statusBadge}
            </div>
            <div className="flex items-center gap-2">
              {vps.logs.length > 0 && (
                <span className="text-[10px] text-muted-foreground font-mono">
                  {vps.logs.length} righe
                </span>
              )}
              {(vps.status === "success" || vps.status === "failed") && vps.logs.length > 0 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={(e) => { e.stopPropagation(); downloadLog(); }}
                  title="Scarica log"
                >
                  <Download className="w-3 h-3" />
                </Button>
              )}
              {open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
            </div>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div
            ref={scrollRef}
            className="bg-black/90 font-mono text-xs p-3 h-48 overflow-y-auto border-t border-border/50"
          >
            {vps.logs.length === 0 ? (
              <span className="text-muted-foreground">In attesa di output...</span>
            ) : (
              vps.logs.map((line, i) => (
                <div key={i} className={`leading-5 ${line.includes("ERRORE") || line.includes("ERROR") ? "text-red-400" : line.includes("COMPLETATO") || line.includes("OK") ? "text-green-400" : line.includes("STEP") ? "text-blue-300" : "text-gray-300"}`}>
                  {line}
                </div>
              ))
            )}
            {vps.status === "running" && (
              <div className="text-blue-400 animate-pulse">▌</div>
            )}
          </div>
          {vps.error && (
            <div className="bg-red-950/30 border-t border-red-500/20 px-3 py-2 text-xs text-red-400 font-mono">
              {vps.error}
            </div>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// ─── Pagina principale ────────────────────────────────────────────────────────

interface NginxVersionInfo {
  vpsId: string;
  vpsName: string;
  version: string | null;
  error: string | null;
}

export default function FleetUpgrade() {
  const { data: vpsList = [] } = useQuery<SafeVps[]>({ queryKey: ["/api/vps"] });
  const { data: nginxVersions = [], isFetching: fetchingVersions, refetch: refetchVersions } = useQuery<NginxVersionInfo[]>({
    queryKey: ["/api/fleet/nginx/versions"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/fleet/nginx/versions");
      return res.json();
    },
    staleTime: 30000,
  });

  const versionMap = new Map(nginxVersions.map(v => [v.vpsId, v.version]));

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pageState, setPageState] = useState<PageState>("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [vpsStates, setVpsStates] = useState<Map<string, VpsState>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const enabledVps = vpsList.filter((v) => v.enabled);
  const allSelected = enabledVps.length > 0 && selectedIds.size === enabledVps.length;
  const totalSelected = selectedIds.size;
  const totalVps = vpsStates.size;

  // Contatori derivati da vpsStates (no stato separato, evita doppio conteggio nel replay)
  const vpsStateArray = Array.from(vpsStates.values()).sort((a, b) => {
    const order: Record<VpsStatus, number> = { running: 0, failed: 1, success: 2, pending: 3 };
    return order[a.status] - order[b.status];
  });
  const doneCount = vpsStateArray.filter((v) => v.status === "success" || v.status === "failed").length;
  const successCount = vpsStateArray.filter((v) => v.status === "success").length;
  const failCount = vpsStateArray.filter((v) => v.status === "failed").length;
  const progress = totalVps > 0 ? Math.round((doneCount / totalVps) * 100) : 0;

  // Toggle selezione singola
  const toggleVps = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // Toggle tutto
  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(enabledVps.map((v) => v.id)));
    }
  };

  // Aggiorna stato singolo VPS
  const updateVps = useCallback((vpsId: string, patch: Partial<VpsState>) => {
    setVpsStates((prev) => {
      const next = new Map(prev);
      const cur = next.get(vpsId);
      if (cur) next.set(vpsId, { ...cur, ...patch });
      return next;
    });
  }, []);

  const appendLog = useCallback((vpsId: string, line: string) => {
    setVpsStates((prev) => {
      const next = new Map(prev);
      const cur = next.get(vpsId);
      if (cur) next.set(vpsId, { ...cur, logs: [...cur.logs, line] });
      return next;
    });
  }, []);

  // Connette SSE a un job esistente (usato sia all'avvio che al riconnect)
  const connectSse = useCallback((id: string) => {
    esRef.current?.close();
    const es = new EventSource(`/api/fleet/upgrade/${id}/events`);
    esRef.current = es;

    es.addEventListener("vps-start", (e) => {
      const { vpsId, vpsName } = JSON.parse(e.data);
      const vps = vpsList.find((v) => v.id === vpsId);
      setVpsStates((prev) => {
        const next = new Map(prev);
        // Se il VPS è già presente con stato terminale, aggiorna solo i log (replay)
        const existing = next.get(vpsId);
        next.set(vpsId, {
          vpsId,
          vpsName,
          vpsHost: existing?.vpsHost ?? vps?.host ?? "",
          status: "running",
          logs: [],
          error: undefined,
        });
        return next;
      });
    });

    es.addEventListener("vps-log", (e) => {
      const { vpsId, line } = JSON.parse(e.data);
      appendLog(vpsId, line);
    });

    es.addEventListener("vps-done", (e) => {
      const { vpsId, success, error: err } = JSON.parse(e.data);
      updateVps(vpsId, {
        status: success ? "success" : "failed",
        error: err,
      });
    });

    es.addEventListener("job-done", () => {
      es.close();
      esRef.current = null;
      setPageState("done");
    });

    es.onerror = () => {
      es.close();
      esRef.current = null;
      setPageState((s) => (s === "running" ? "done" : s));
    };
  }, [vpsList, appendLog, updateVps]);

  // Avvia upgrade
  const startUpgrade = async () => {
    if (totalSelected === 0) return;
    setError(null);
    setPageState("running");
    setVpsStates(new Map());

    try {
      const res = await apiRequest("POST", "/api/fleet/upgrade/start", {
        vpsIds: [...selectedIds],
      });
      const { jobId: id } = await res.json();
      setJobId(id);
      connectSse(id);
    } catch (e: any) {
      setError(e.message);
      setPageState("idle");
    }
  };

  // Al mount: controlla se esiste un job attivo e riconnettiti
  useEffect(() => {
    (async () => {
      try {
        const activeRes = await fetch("/api/fleet/upgrade/active");
        if (!activeRes.ok) return;
        const { jobId: activeId } = await activeRes.json();

        // Carica snapshot per inizializzare i VPS prima che arrivino gli eventi SSE
        const snapRes = await fetch(`/api/fleet/upgrade/${activeId}/status`);
        if (!snapRes.ok) return;
        const snap = await snapRes.json();

        const initStates = new Map<string, VpsState>();
        for (const vj of snap.vpsJobs) {
          initStates.set(vj.vpsId, {
            vpsId: vj.vpsId,
            vpsName: vj.vpsName,
            vpsHost: vj.vpsHost,
            status: vj.status,
            logs: [],
            error: vj.error,
          });
        }
        setVpsStates(initStates);
        setJobId(activeId);
        setPageState("running");
        connectSse(activeId);
      } catch {
        // Nessun job attivo, pagina rimane in idle
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup SSE alla smontatura
  useEffect(() => {
    return () => { esRef.current?.close(); };
  }, []);

  // Reset
  const reset = () => {
    esRef.current?.close();
    esRef.current = null;
    setPageState("idle");
    setJobId(null);
    setVpsStates(new Map());
    setError(null);
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold font-heading tracking-tight">Fleet Upgrade</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Nginx 1.26.2 + ModSecurity v3 + OWASP CRS v4
        </p>
      </div>

      {/* Selezione VPS (solo in idle) */}
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
            {enabledVps.length === 0 && (
              <p className="text-sm text-muted-foreground">Nessun VPS abilitato.</p>
            )}
            {enabledVps.map((vps) => {
              const version = versionMap.get(vps.id);
              const isUpToDate = version === TARGET_VERSION;
              return (
                <label
                  key={vps.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-muted/40 cursor-pointer transition-colors"
                >
                  <Checkbox
                    checked={selectedIds.has(vps.id)}
                    onCheckedChange={() => toggleVps(vps.id)}
                    className="h-3.5 w-3.5"
                  />
                  <span className="text-sm font-medium flex-1">{vps.name}</span>
                  <span className="text-xs text-muted-foreground font-mono">{vps.host}</span>
                  {fetchingVersions && !version ? (
                    <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                  ) : version ? (
                    <Badge
                      variant="outline"
                      className={`text-[10px] h-4 px-1.5 font-mono ${isUpToDate ? "text-green-600 border-green-500/40 bg-green-500/10" : "text-orange-500 border-orange-500/40 bg-orange-500/10"}`}
                    >
                      {isUpToDate && <CheckCircle2 className="w-2.5 h-2.5 mr-0.5" />}
                      {version}
                    </Badge>
                  ) : null}
                  <div className={`w-1.5 h-1.5 rounded-full ${vps.lastStatus === "online" ? "bg-green-500" : "bg-muted-foreground/40"}`} />
                </label>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Errore avvio */}
      {error && (
        <div className="bg-red-950/30 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-400 font-mono">
          {error}
        </div>
      )}

      {/* Avvio / Reset */}
      <div className="flex items-center gap-3">
        {pageState === "idle" && (
          <Button
            onClick={startUpgrade}
            disabled={totalSelected === 0}
            className="gap-2"
          >
            <Rocket className="w-4 h-4" />
            Avvia Upgrade ({totalSelected} VPS)
          </Button>
        )}
        {pageState === "done" && (
          <Button variant="outline" onClick={reset} className="gap-2">
            <RotateCcw className="w-4 h-4" />
            Nuovo upgrade
          </Button>
        )}
        {pageState === "running" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Upgrade in corso...</span>
          </div>
        )}
      </div>

      {/* Progress bar globale */}
      {(pageState === "running" || pageState === "done") && totalVps > 0 && (
        <Card>
          <CardContent className="pt-4 pb-4 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-heading font-medium">Progresso globale</span>
              <span className="font-mono text-muted-foreground">
                {doneCount}/{totalVps} VPS
              </span>
            </div>
            <Progress value={progress} className="h-2" />
            <div className="flex gap-4 text-xs">
              <span className="flex items-center gap-1.5 text-green-600">
                <CheckCircle2 className="w-3 h-3" />
                {successCount} successi
              </span>
              <span className="flex items-center gap-1.5 text-red-500">
                <XCircle className="w-3 h-3" />
                {failCount} falliti
              </span>
              {pageState === "running" && (
                <span className="flex items-center gap-1.5 text-blue-500">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {totalVps - doneCount} in corso
                </span>
              )}
            </div>
            {pageState === "done" && (
              <div className={`text-sm font-heading font-medium ${failCount === 0 ? "text-green-600" : failCount === totalVps ? "text-red-500" : "text-yellow-600"}`}>
                {failCount === 0
                  ? "Tutti i VPS aggiornati con successo."
                  : failCount === totalVps
                  ? "Upgrade fallito su tutti i VPS."
                  : `${successCount}/${totalVps} VPS aggiornati. ${failCount} falliti.`}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Log per VPS */}
      {vpsStateArray.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-heading font-medium text-muted-foreground uppercase tracking-wider">
            Dettaglio per VPS
          </h2>
          {vpsStateArray.map((vps) => (
            <VpsLogCard key={vps.vpsId} vps={vps} />
          ))}
        </div>
      )}
    </div>
  );
}
