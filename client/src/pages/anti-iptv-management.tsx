import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LoadingState } from "@/components/loading-state";
import { useToast } from "@/hooks/use-toast";
import { Tv, RefreshCw, Save, CheckCircle2, XCircle, Loader2 } from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

type Variant = "sh" | "py";

interface AntiIptvVpsSummary {
  vpsId: string;
  vpsName: string;
  variant: Variant | "none";
  active: boolean;
  enabled: boolean;
  maxUsername: number | null;
  error?: string;
}

interface DeployResult {
  vpsId: string;
  vpsName: string;
  success: boolean;
  data?: any;
  error?: string;
}

interface DeployResponse {
  ok: boolean;
  targeted: string[];
  skipped: string[];
  results: DeployResult[];
}

// ─── Status helpers ───────────────────────────────────────────────────────────

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

function VariantBadge({ variant }: { variant: Variant | "none" }) {
  if (variant === "none") return <span className="text-muted-foreground text-xs">—</span>;
  return <Badge variant="outline">{variant === "sh" ? "Bash" : "Python"}</Badge>;
}

// ─── Editor tab (per variant) ──────────────────────────────────────────────────

function ScriptEditorTab({
  variant,
  label,
  rows,
  selected,
}: {
  variant: Variant;
  label: string;
  rows: AntiIptvVpsSummary[];
  selected: string[];
}) {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ content: string }>({
    queryKey: [`/api/fleet/anti-iptv/script/${variant}`],
  });
  const [content, setContent] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<DeployResponse | null>(null);

  const effectiveContent = content !== null ? content : (data?.content || "");
  const variantVpsIds = useMemo(() => rows.filter(r => r.variant === variant).map(r => r.vpsId), [rows, variant]);
  const targetIds = useMemo(() => selected.filter(id => variantVpsIds.includes(id)), [selected, variantVpsIds]);

  const deployMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/fleet/anti-iptv/script/${variant}`, {
        content: effectiveContent,
        vpsIds: targetIds,
      });
      return res.json() as Promise<DeployResponse>;
    },
    onSuccess: (res) => {
      setLastResult(res);
      queryClient.invalidateQueries({ queryKey: ["/api/fleet/anti-iptv/summary"] });
      const ok = res.results.filter(r => r.success).length;
      const fail = res.results.filter(r => !r.success).length;
      toast({
        title: "Deploy completato",
        description: `${ok} successi, ${fail} errori su ${res.results.length} VPS${res.skipped.length ? ` · ${res.skipped.length} esclusi (variante non corrispondente)` : ""}`,
        variant: fail > 0 ? "destructive" : "default",
      });
    },
    onError: () => toast({ title: "Errore", description: "Deploy non riuscito", variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {targetIds.length} VPS {label} selezionati su {variantVpsIds.length} totali con questa variante.
          Il salvataggio riavvia il servizio solo sui VPS dove è già attivo.
        </div>
        <Button
          size="sm"
          onClick={() => deployMutation.mutate()}
          disabled={deployMutation.isPending || targetIds.length === 0 || isLoading}
        >
          {deployMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
          Salva & Deploy ({targetIds.length})
        </Button>
      </div>

      {isLoading ? (
        <LoadingState message="Caricamento script..." />
      ) : (
        <Textarea
          value={effectiveContent}
          onChange={e => setContent(e.target.value)}
          className="font-mono text-xs min-h-[420px]"
          spellCheck={false}
        />
      )}

      {lastResult && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Risultato ultimo deploy</CardTitle>
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
                      {r.error || r.data?.restartWarning || "—"}
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

// ─── Main page ──────────────────────────────────────────────────────────────

export default function AntiIptvManagement() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data, isLoading, refetch, isRefetching } = useQuery<AntiIptvVpsSummary[]>({
    queryKey: ["/api/fleet/anti-iptv/summary"],
    refetchInterval: 60000,
  });

  const [selected, setSelected] = useState<string[]>([]);
  const rows = data || [];
  const selectableIds = useMemo(() => rows.filter(r => r.variant !== "none").map(r => r.vpsId), [rows]);
  const allSelected = selectableIds.length > 0 && selected.length === selectableIds.length;

  const toggle = (id: string) => setSelected(prev => prev.includes(id) ? prev.filter(v => v !== id) : [...prev, id]);
  const toggleAll = () => setSelected(prev => prev.length === selectableIds.length ? [] : selectableIds);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-heading flex items-center gap-2">
            <Tv className="w-6 h-6" /> Anti-IPTV
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Gestione script anti-IPTV fleet: modifica centralizzata, deploy su tutti i VPS o su una selezione, riavvio automatico solo dove il servizio è già attivo.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isRefetching}>
          <RefreshCw className={`w-4 h-4 mr-1 ${isRefetching ? "animate-spin" : ""}`} />Aggiorna
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stato fleet</CardTitle>
          <CardDescription>
            Seleziona i VPS su cui applicare le modifiche negli editor sotto. VPS senza script installato o disabilitati non sono selezionabili in blocco.
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
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {isAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Editor script</CardTitle>
            <CardDescription>Modifiche salvate nel repo (`scripts/anti-iptv.sh` / `.py`) e deployate sui VPS selezionati con quella variante.</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="sh">
              <TabsList>
                <TabsTrigger value="sh">Script Bash</TabsTrigger>
                <TabsTrigger value="py">Script Python</TabsTrigger>
              </TabsList>
              <TabsContent value="sh" className="pt-4">
                <ScriptEditorTab variant="sh" label="bash" rows={rows} selected={selected} />
              </TabsContent>
              <TabsContent value="py" className="pt-4">
                <ScriptEditorTab variant="py" label="python" rows={rows} selected={selected} />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            Solo gli admin possono modificare e deployare gli script.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
