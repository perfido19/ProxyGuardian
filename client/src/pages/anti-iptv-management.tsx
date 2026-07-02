import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LoadingState } from "@/components/loading-state";
import { useToast } from "@/hooks/use-toast";
import { Tv, RefreshCw, Save, CheckCircle2, XCircle, Loader2 } from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AntiIptvVpsSummary {
  vpsId: string;
  vpsName: string;
  variant: "sh" | "py" | "none";
  active: boolean;
  enabled: boolean;
  maxUsername: number | null;
  windowSeconds: number | null;
  banSeconds: number | null;
  error?: string;
}

interface ParamsResult {
  vpsId: string;
  vpsName: string;
  success: boolean;
  data?: any;
  error?: string;
}

interface ParamsResponse {
  ok: boolean;
  results: ParamsResult[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds % 86400 === 0) return `${seconds / 86400}g`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function StatusBadge({ row }: { row: AntiIptvVpsSummary }) {
  if (row.variant === "none") {
    return <Badge variant="outline" className="text-muted-foreground">Non installato</Badge>;
  }
  if (!row.active && !row.enabled) {
    return <Badge className="bg-orange-600 text-white">Disabilitato</Badge>;
  }
  return row.active
    ? <Badge className="bg-green-600 text-white"><CheckCircle2 className="w-3 h-3 mr-1 inline" />Attivo</Badge>
    : <Badge className="bg-destructive text-white"><XCircle className="w-3 h-3 mr-1 inline" />Inattivo</Badge>;
}

function VariantBadge({ variant }: { variant: "sh" | "py" | "none" }) {
  if (variant === "none") return <span className="text-muted-foreground text-xs">—</span>;
  return <Badge variant="outline">{variant === "sh" ? "Bash" : "Python"}</Badge>;
}

// ─── Main page ──────────────────────────────────────────────────────────────

export default function AntiIptvManagement() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin";
  const { data, isLoading, refetch, isRefetching } = useQuery<AntiIptvVpsSummary[]>({
    queryKey: ["/api/fleet/anti-iptv/summary"],
    refetchInterval: 60000,
  });

  const [selected, setSelected] = useState<string[]>([]);
  const [maxUsername, setMaxUsername] = useState("");
  const [windowSeconds, setWindowSeconds] = useState("");
  const [banSeconds, setBanSeconds] = useState("");
  const [lastResult, setLastResult] = useState<ParamsResponse | null>(null);

  const rows = data || [];
  const selectableIds = useMemo(() => rows.filter(r => r.variant !== "none").map(r => r.vpsId), [rows]);
  const allSelected = selectableIds.length > 0 && selected.length === selectableIds.length;

  const toggle = (id: string) => setSelected(prev => prev.includes(id) ? prev.filter(v => v !== id) : [...prev, id]);
  const toggleAll = () => setSelected(prev => prev.length === selectableIds.length ? [] : selectableIds);

  const applyMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/fleet/anti-iptv/params", {
        vpsIds: selected,
        maxUsername: maxUsername || undefined,
        windowSeconds: windowSeconds || undefined,
        banSeconds: banSeconds || undefined,
      });
      return res.json() as Promise<ParamsResponse>;
    },
    onSuccess: (res) => {
      setLastResult(res);
      queryClient.invalidateQueries({ queryKey: ["/api/fleet/anti-iptv/summary"] });
      const ok = res.results.filter(r => r.success).length;
      const fail = res.results.filter(r => !r.success).length;
      toast({
        title: "Parametri applicati",
        description: `${ok} successi, ${fail} errori su ${res.results.length} VPS`,
        variant: fail > 0 ? "destructive" : "default",
      });
    },
    onError: () => toast({ title: "Errore", description: "Applicazione parametri non riuscita", variant: "destructive" }),
  });

  const noFieldFilled = !maxUsername && !windowSeconds && !banSeconds;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-heading flex items-center gap-2">
            <Tv className="w-6 h-6" /> Anti-IPTV
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Modifica i parametri dello script anti-IPTV (soglia username, finestra, durata ban) e applicali su tutta la fleet o su una selezione. Il riavvio scatta solo dove il servizio è già attivo.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isRefetching}>
          <RefreshCw className={`w-4 h-4 mr-1 ${isRefetching ? "animate-spin" : ""}`} />Aggiorna
        </Button>
      </div>

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Modifica parametri</CardTitle>
            <CardDescription>
              Compila solo i campi da cambiare — quelli vuoti restano invariati. Viene patchato in-place solo il valore sullo script già live su ciascun VPS selezionato (bash o python), nient'altro.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="maxUsername">MAX_USERNAME (soglia)</Label>
                <Input id="maxUsername" type="number" min={1} placeholder="es. 4" value={maxUsername} onChange={e => setMaxUsername(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="windowSeconds">WINDOW_SECONDS (finestra, sec.)</Label>
                <Input id="windowSeconds" type="number" min={1} placeholder="es. 21600 = 6h" value={windowSeconds} onChange={e => setWindowSeconds(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="banSeconds">BAN_SECONDS (durata ban, sec.)</Label>
                <Input id="banSeconds" type="number" min={1} placeholder="es. 604800 = 7g" value={banSeconds} onChange={e => setBanSeconds(e.target.value)} />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-sm text-muted-foreground">{selected.length} VPS selezionati</div>
              <Button
                size="sm"
                onClick={() => applyMutation.mutate()}
                disabled={applyMutation.isPending || selected.length === 0 || noFieldFilled}
              >
                {applyMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
                Applica alla selezione ({selected.length})
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stato fleet</CardTitle>
          <CardDescription>
            Seleziona i VPS su cui applicare le modifiche. VPS senza script installato o disabilitati non sono selezionabili in blocco.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingState message="Caricamento stato fleet..." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox checked={allSelected} onCheckedChange={toggleAll} disabled={!isAdmin || selectableIds.length === 0} />
                  </TableHead>
                  <TableHead>VPS</TableHead>
                  <TableHead>Variante</TableHead>
                  <TableHead>Stato</TableHead>
                  <TableHead>MAX_USERNAME</TableHead>
                  <TableHead>Finestra</TableHead>
                  <TableHead>Ban</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(row => (
                  <TableRow key={row.vpsId} className={row.variant === "none" ? "opacity-50" : ""}>
                    <TableCell>
                      <Checkbox
                        checked={selected.includes(row.vpsId)}
                        onCheckedChange={() => toggle(row.vpsId)}
                        disabled={!isAdmin || row.variant === "none"}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-sm">{row.vpsName}</TableCell>
                    <TableCell><VariantBadge variant={row.variant} /></TableCell>
                    <TableCell><StatusBadge row={row} /></TableCell>
                    <TableCell className="font-mono text-sm">{row.maxUsername ?? "—"}</TableCell>
                    <TableCell className="font-mono text-sm">{formatDuration(row.windowSeconds)}</TableCell>
                    <TableCell className="font-mono text-sm">{formatDuration(row.banSeconds)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {lastResult && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Risultato ultima applicazione</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>VPS</TableHead>
                  <TableHead>Esito</TableHead>
                  <TableHead>Dettaglio</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lastResult.results.map(r => (
                  <TableRow key={r.vpsId}>
                    <TableCell className="font-mono text-xs">{r.vpsName}</TableCell>
                    <TableCell>
                      {r.success
                        ? <Badge className="bg-green-600 text-white">OK</Badge>
                        : <Badge className="bg-destructive text-white">Errore</Badge>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.error || r.data?.restartWarning || (r.data?.skipped?.length ? `campi non riconosciuti: ${r.data.skipped.join(", ")}` : "—")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
