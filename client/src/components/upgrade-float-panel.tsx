import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useUpgrade } from "@/contexts/upgrade-context";
import { VpsLogCard } from "@/components/vps-log-card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, Loader2, ChevronDown, ChevronUp, X, Rocket } from "lucide-react";

export function UpgradeFloatPanel() {
  const [location] = useLocation();
  const { pageState, vpsStates } = useUpgrade();
  const [minimized, setMinimized] = useState(false);
  const [closed, setClosed] = useState(false);

  // Mostra solo su pagine diverse da fleet-upgrade, durante un upgrade
  if (location === "/fleet-upgrade") return null;
  if (pageState === "idle") return null;
  if (closed) return null;

  const vpsArray = useMemo(() => Array.from(vpsStates.values()).sort((a, b) => {
    const order = { running: 0, failed: 1, success: 2, pending: 3 } as const;
    return order[a.status] - order[b.status];
  }), [vpsStates]);

  const total = vpsArray.length;
  const done = vpsArray.filter(v => v.status === "success" || v.status === "failed").length;
  const successes = vpsArray.filter(v => v.status === "success").length;
  const failures = vpsArray.filter(v => v.status === "failed").length;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;
  const isDone = pageState === "done";

  // Chiudi automaticamente solo se l'upgrade è completato e l'utente ha già visto i risultati
  // (non auto-close — l'utente chiude manualmente o torna su fleet-upgrade)

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[420px] max-w-[calc(100vw-2rem)] shadow-2xl rounded-xl border border-border bg-background/95 backdrop-blur-sm overflow-hidden">
      {/* Header */}
      <div
        className={`flex items-center gap-2 px-4 py-2.5 cursor-pointer select-none ${isDone ? "bg-green-950/50 border-b border-green-500/20" : "bg-blue-950/50 border-b border-blue-500/20"}`}
        onClick={() => setMinimized(m => !m)}
      >
        <Rocket className="w-3.5 h-3.5 text-blue-400 shrink-0" />
        <span className="text-xs font-heading font-semibold flex-1">Fleet Upgrade</span>
        {!minimized && total > 0 && (
          <div className="flex items-center gap-2 text-xs">
            <span className="flex items-center gap-1 text-green-500"><CheckCircle2 className="w-3 h-3" />{successes}</span>
            <span className="flex items-center gap-1 text-red-500"><XCircle className="w-3 h-3" />{failures}</span>
            <span className="text-muted-foreground font-mono">{done}/{total}</span>
          </div>
        )}
        {!isDone && <Loader2 className="w-3 h-3 animate-spin text-blue-400 shrink-0" />}
        {isDone && <span className="text-[10px] text-green-400 font-heading shrink-0">Completato</span>}
        <button
          className="ml-1 p-0.5 hover:bg-white/10 rounded"
          onClick={e => { e.stopPropagation(); setMinimized(m => !m); }}
        >
          {minimized ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
        </button>
        <button
          className="p-0.5 hover:bg-white/10 rounded"
          onClick={e => { e.stopPropagation(); setClosed(true); }}
          title="Chiudi pannello"
        >
          <X className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
      </div>

      {!minimized && (
        <>
          {/* Barra progresso */}
          {total > 0 && (
            <div className="px-4 py-2 border-b border-border/50">
              <Progress value={progress} className="h-1.5" />
            </div>
          )}

          {/* Log cards */}
          <div className="max-h-[50vh] overflow-y-auto p-3 space-y-2">
            {vpsArray.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">Inizializzazione...</p>
            ) : (
              vpsArray.map(vps => <VpsLogCard key={vps.vpsId} vps={vps} />)
            )}
          </div>

          {/* Footer link */}
          <div className="px-4 py-2 border-t border-border/50 flex justify-between items-center">
            <span className="text-[10px] text-muted-foreground">
              {isDone ? "Upgrade completato" : `${total - done} VPS ancora in corso`}
            </span>
            <a href="/fleet-upgrade" className="text-[10px] text-blue-400 hover:underline">
              Apri pagina completa →
            </a>
          </div>
        </>
      )}
    </div>
  );
}
