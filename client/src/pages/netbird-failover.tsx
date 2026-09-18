import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LoadingState } from "@/components/loading-state";
import { CheckCircle2, XCircle, AlertCircle, RefreshCw, Radio } from "lucide-react";

interface NetbirdSwapStatus {
  id: string;
  name: string;
  installed: boolean;
  state: "primary" | "backup" | null;
  timerActive: boolean;
  backupDaemonActive: boolean;
  lastEvent: string | null;
  stateSince: string | null;
  online: boolean;
  error?: string;
}

const STUCK_THRESHOLD_MINUTES = 15;

function minutesOnBackup(s: NetbirdSwapStatus): number | null {
  if (s.state !== "backup" || !s.stateSince) return null;
  return Math.floor((Date.now() - new Date(s.stateSince).getTime()) / 60_000);
}

export default function NetbirdFailover() {
  const { data: swapStatuses, isFetching: swapFetching, refetch: refetchSwap } = useQuery<NetbirdSwapStatus[]>({
    queryKey: ["/api/fleet/netbird-swap/status"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/fleet/netbird-swap/status");
      return res.json();
    },
    staleTime: 20000,
    refetchInterval: 30000,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-heading tracking-tight">Failover NetBird</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Stato del secondo demone NetBird (self-hosted, wt1) su ogni host — attivo solo se il primario (NetBird Cloud) è giù da almeno ~2 minuti.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetchSwap()} disabled={swapFetching} className="gap-1.5">
          <RefreshCw className={`w-3.5 h-3.5 ${swapFetching ? "animate-spin" : ""}`} />
          Aggiorna
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="font-heading flex items-center gap-2">
            <Radio className="w-4 h-4" />
            Stato flotta
          </CardTitle>
          <CardDescription>
            58 host totali: main, dynapannel (via SSH diretto) e i 56 VPS della flotta (via agent).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {swapStatuses && swapStatuses.some((s) => s.state === "backup") && (
            <div className="mb-4 rounded-md border border-orange-500/50 bg-orange-500/10 px-3 py-2 text-sm text-orange-600 dark:text-orange-400 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {swapStatuses.filter((s) => s.state === "backup").length} host in failover (backup attivo) in questo momento.
            </div>
          )}
          {swapStatuses && swapStatuses.some((s) => (minutesOnBackup(s) ?? 0) >= STUCK_THRESHOLD_MINUTES) && (
            <div className="mb-4 rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {swapStatuses
                .filter((s) => (minutesOnBackup(s) ?? 0) >= STUCK_THRESHOLD_MINUTES)
                .map((s) => `${s.name} (${minutesOnBackup(s)} min)`)
                .join(", ")}{" "}
              — su backup da oltre {STUCK_THRESHOLD_MINUTES} minuti senza rientro automatico. Controllo manuale consigliato.
            </div>
          )}
          {!swapStatuses ? (
            <LoadingState />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Host</TableHead>
                    <TableHead>Stato</TableHead>
                    <TableHead>Timer</TableHead>
                    <TableHead>Ultimo evento</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {swapStatuses.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">
                        {s.name}
                        {(s.id === "main" || s.id === "dynapannel") && (
                          <Badge variant="outline" className="ml-2 text-[10px]">non-flotta</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {!s.online ? (
                          <Badge variant="outline" className="gap-1 text-muted-foreground"><XCircle className="w-3 h-3" />offline</Badge>
                        ) : !s.installed ? (
                          <Badge variant="outline" className="gap-1 text-muted-foreground">non installato</Badge>
                        ) : s.state === "backup" ? (
                          <Badge className="gap-1 bg-orange-500 hover:bg-orange-500"><AlertCircle className="w-3 h-3" />backup attivo</Badge>
                        ) : (
                          <Badge className="gap-1 bg-green-600 hover:bg-green-600"><CheckCircle2 className="w-3 h-3" />primario</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {s.installed ? (
                          s.timerActive ? (
                            <span className="text-xs text-green-600">attivo</span>
                          ) : (
                            <span className="text-xs text-destructive">fermo</span>
                          )
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground font-mono max-w-md truncate">
                        {s.lastEvent || s.error || "-"}
                        {minutesOnBackup(s) !== null && (
                          <span className="ml-2 text-orange-500">({minutesOnBackup(s)} min su backup)</span>
                        )}
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
