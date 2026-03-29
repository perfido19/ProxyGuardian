import { useState, useEffect, useRef, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CheckCircle2, XCircle, Loader2, ChevronDown, ChevronRight, Download } from "lucide-react";
import type { VpsState } from "@/contexts/upgrade-context";

export function VpsLogCard({ vps }: { vps: VpsState }) {
  const [open, setOpen] = useState(vps.status === "running" || vps.status === "failed");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [vps.logs.length, open]);

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
                <span className="text-[10px] text-muted-foreground font-mono">{vps.logs.length} righe</span>
              )}
              {(vps.status === "success" || vps.status === "failed") && vps.logs.length > 0 && (
                <Button variant="ghost" size="icon" className="h-6 w-6"
                  onClick={(e) => { e.stopPropagation(); downloadLog(); }} title="Scarica log">
                  <Download className="w-3 h-3" />
                </Button>
              )}
              {open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
            </div>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div ref={scrollRef}
            className="bg-black/90 font-mono text-xs p-3 h-48 overflow-y-auto border-t border-border/50">
            {vps.logs.length === 0 ? (
              <span className="text-muted-foreground">In attesa di output...</span>
            ) : (
              vps.logs.map((line, i) => (
                <div key={i} className={`leading-5 ${
                  line.includes("ERRORE") || line.includes("ERROR") ? "text-red-400" :
                  line.includes("COMPLETATO") || line.includes("OK") ? "text-green-400" :
                  line.includes("STEP") ? "text-blue-300" : "text-gray-300"
                }`}>{line}</div>
              ))
            )}
            {vps.status === "running" && <div className="text-blue-400 animate-pulse">▌</div>}
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
