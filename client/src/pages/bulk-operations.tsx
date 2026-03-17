import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useVpsList, type BulkResult } from "@/hooks/use-vps";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CheckSquare, Square, Zap, RotateCw, ShieldOff, FileText, CheckCircle, XCircle, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { LoadingState } from "@/components/loading-state";

// ─── Operazioni disponibili ───────────────────────────────────────────────────
const SERVICE_ACTIONS = [
  { value: "restart_nginx", label: "Restart nginx", path: "/api/services/action", body: { service: "nginx", action: "restart" } },
  { value: "reload_nginx", label: "Reload nginx", path: "/api/services/action", body: { service: "nginx", action: "reload" } },
  { value: "restart_fail2ban", label: "Restart fail2ban", path: "/api/services/action", body: { service: "fail2ban", action: "restart" } },
  { value: "restart_mariadb", label: "Restart MariaDB", path: "/api/services/action", body: { service: "mariadb", action: "restart" } },
];

const CONFIG_FILES = [
  { value: "country_whitelist.conf", label: "Whitelist Paesi" },
  { value: "block_asn.conf", label: "Blacklist ASN" },
  { value: "block_isp.conf", label: "Blacklist ISP" },
  { value: "useragent.rules", label: "User-Agent Rules" },
  { value: "ip_whitelist.conf", label: "IP Whitelist" },
  { value: "exclusion_ip.conf", label: "IP Exclusion" },
];

export default function BulkOperations() {
  const { toast } = useToast();
  const { data: vpsList, isLoading } = useVpsList();

  // Selezione VPS
  const [selectedVps, setSelectedVps] = useState<string[]>([]);
  const [results, setResults] = useState<BulkResult[] | null>(null);

  // Tab service actions
  const [selectedAction, setSelectedAction] = useState(SERVICE_ACTIONS[0].value);

  // Tab unban
  // (nessun parametro extra)

  // Tab config update
  const [selectedConfigFile, setSelectedConfigFile] = useState(CONFIG_FILES[0].value);
  const [configContent, setConfigContent] = useState("");

  // Tab fail2ban config
  const [fail2banConfigType, setFail2banConfigType] = useState<"jail.local" | "fail2ban.local">("jail.local");
  const [fail2banContent, setFail2banContent] = useState("");

  const bulkMutation = useMutation({
    mutationFn: async ({ path, body }: { path: string; body: any }) => {
      const vpsIds = selectedVps.length === (vpsList?.length || 0) ? "all" : selectedVps;
      const res = await apiRequest("POST", "/api/vps/bulk/post", { vpsIds, path, body });
      return res.json() as Promise<BulkResult[]>;
    },
    onSuccess: (data) => {
      setResults(data);
      const ok = data.filter(r => r.success).length;
      const fail = data.filter(r => !r.success).length;
      toast({
        title: `Operazione completata`,
        description: `${ok} successi, ${fail} errori su ${data.length} VPS`,
        variant: fail > 0 ? "destructive" : "default",
      });
    },
    onError: () => toast({ title: "Errore", description: "Impossibile eseguire l'operazione bulk", variant: "destructive" }),
  });

  const toggleVps = (id: string) => {
    setSelectedVps(prev => prev.includes(id) ? prev.filter(v => v !== id) : [...prev, id]);
  };

  const toggleAll = () => {
    const all = vpsList?.filter(v => v.enabled).map(v => v.id) || [];
    setSelectedVps(prev => prev.length === all.length ? [] : all);
  };

  const enabledVps = vpsList?.filter(v => v.enabled) || [];
  const allSelected = selectedVps.length === enabledVps.length && enabledVps.length > 0;

  const handleServiceAction = () => {
    const op = SERVICE_ACTIONS.find(a => a.value === selectedAction)!;
    bulkMutation.mutate({ path: op.path, body: op.body });
  };

  const handleUnbanAll = () => {
    bulkMutation.mutate({ path: "/api/unban-all", body: {} });
  };

  const handleConfigUpdate = () => {
    if (!configContent.trim()) return;
    bulkMutation.mutate({ path: "/api/config/update", body: { filename: selectedConfigFile, content: configContent } });
  };

  const handleFail2banConfig = () => {
    if (!fail2banContent.trim()) return;
    bulkMutation.mutate({ path: `/api/fail2ban/config/${fail2banConfigType}`, body: { content: fail2banContent } });
  };

  if (isLoading) return <LoadingState message="Caricamento VPS..." />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Operazioni Bulk</h1>
        <p className="text-muted-foreground">Esegui la stessa operazione su più VPS contemporaneamente</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* ── Selezione VPS ── */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Seleziona VPS</CardTitle>
              <Button variant="ghost" size="sm" onClick={toggleAll} className="gap-1 text-xs">
                {allSelected ? <Square className="w-3 h-3" /> : <CheckSquare className="w-3 h-3" />}
                {allSelected ? "Deseleziona tutti" : "Seleziona tutti"}
              </Button>
            </div>
            <CardDescription>{selectedVps.length} di {enabledVps.length} selezionati</CardDescription>
          </CardHeader>
          <CardContent>
            {enabledVps.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">Nessun VPS abilitato</p>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                {enabledVps.map(vps => (
                  <div
                    key={vps.id}
                    className={`flex items-center gap-3 p-2 rounded-md border cursor-pointer transition-colors ${selectedVps.includes(vps.id) ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`}
                    onClick={() => toggleVps(vps.id)}
                  >
                    <Checkbox checked={selectedVps.includes(vps.id)} onCheckedChange={() => toggleVps(vps.id)} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{vps.name}</p>
                      <p className="text-xs text-muted-foreground font-mono truncate">{vps.host}:{vps.port}</p>
                    </div>
                    <Badge
                      variant={vps.lastStatus === "online" ? "default" : vps.lastStatus === "offline" ? "destructive" : "outline"}
                      className={`text-xs flex-shrink-0 ${vps.lastStatus === "online" ? "bg-green-600" : ""}`}
                    >
                      {vps.lastStatus || "?"}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Operazioni ── */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Operazione</CardTitle>
            <CardDescription>Scegli cosa eseguire sui VPS selezionati</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="services">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="services">Servizi</TabsTrigger>
                <TabsTrigger value="unban">Unban</TabsTrigger>
                <TabsTrigger value="config">Config Nginx</TabsTrigger>
                <TabsTrigger value="fail2ban">Config F2B</TabsTrigger>
              </TabsList>

              {/* Servizi */}
              <TabsContent value="services" className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label>Azione</Label>
                  <Select value={selectedAction} onValueChange={setSelectedAction}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SERVICE_ACTIONS.map(a => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  className="w-full"
                  onClick={handleServiceAction}
                  disabled={selectedVps.length === 0 || bulkMutation.isPending}
                >
                  {bulkMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Esecuzione...</> : <><Zap className="w-4 h-4 mr-2" />Esegui su {selectedVps.length} VPS</>}
                </Button>
              </TabsContent>

              {/* Unban */}
              <TabsContent value="unban" className="space-y-4 pt-4">
                <div className="rounded-md bg-muted/50 p-4 text-sm text-muted-foreground space-y-1">
                  <p>Sblocca tutti gli IP bannati da fail2ban su tutti i VPS selezionati.</p>
                  <p>L'operazione è irreversibile.</p>
                </div>
                <Button
                  variant="destructive"
                  className="w-full"
                  onClick={handleUnbanAll}
                  disabled={selectedVps.length === 0 || bulkMutation.isPending}
                >
                  {bulkMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Esecuzione...</> : <><ShieldOff className="w-4 h-4 mr-2" />Unban All su {selectedVps.length} VPS</>}
                </Button>
              </TabsContent>

              {/* Config Nginx */}
              <TabsContent value="config" className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label>File di configurazione</Label>
                  <Select value={selectedConfigFile} onValueChange={setSelectedConfigFile}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CONFIG_FILES.map(f => <SelectItem key={f.value} value={f.value}>{f.label} ({f.value})</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Contenuto (sovrascrive il file su tutti i VPS selezionati)</Label>
                  <Textarea
                    value={configContent}
                    onChange={e => setConfigContent(e.target.value)}
                    className="font-mono text-sm min-h-[200px]"
                    placeholder={`# Contenuto per ${selectedConfigFile}\n# Questo sovrascriverà il file su tutti i VPS selezionati`}
                  />
                </div>
                <Button
                  className="w-full"
                  onClick={handleConfigUpdate}
                  disabled={selectedVps.length === 0 || !configContent.trim() || bulkMutation.isPending}
                >
                  {bulkMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Invio...</> : <><FileText className="w-4 h-4 mr-2" />Aggiorna {selectedConfigFile} su {selectedVps.length} VPS</>}
                </Button>
              </TabsContent>

              {/* Config Fail2ban */}
              <TabsContent value="fail2ban" className="space-y-4 pt-4">
                <div className="flex gap-2">
                  <Button
                    variant={fail2banConfigType === "jail.local" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setFail2banConfigType("jail.local")}
                  >jail.local</Button>
                  <Button
                    variant={fail2banConfigType === "fail2ban.local" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setFail2banConfigType("fail2ban.local")}
                  >fail2ban.local</Button>
                </div>
                <div className="space-y-2">
                  <Label>Contenuto {fail2banConfigType}</Label>
                  <Textarea
                    value={fail2banContent}
                    onChange={e => setFail2banContent(e.target.value)}
                    className="font-mono text-sm min-h-[200px]"
                    placeholder={`# Contenuto per ${fail2banConfigType}`}
                  />
                </div>
                <Button
                  className="w-full"
                  onClick={handleFail2banConfig}
                  disabled={selectedVps.length === 0 || !fail2banContent.trim() || bulkMutation.isPending}
                >
                  {bulkMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Invio...</> : <><RotateCw className="w-4 h-4 mr-2" />Aggiorna {fail2banConfigType} su {selectedVps.length} VPS</>}
                </Button>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>

      {/* ── Risultati ── */}
      {results && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Risultati</CardTitle>
              <div className="flex gap-2">
                <Badge className="bg-green-600 text-white">{results.filter(r => r.success).length} OK</Badge>
                {results.filter(r => !r.success).length > 0 && (
                  <Badge variant="destructive">{results.filter(r => !r.success).length} Errori</Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>VPS</TableHead>
                    <TableHead>Stato</TableHead>
                    <TableHead>Dettaglio</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium">{r.vpsName}</TableCell>
                      <TableCell>
                        {r.success
                          ? <span className="flex items-center gap-1 text-green-600"><CheckCircle className="w-4 h-4" />Successo</span>
                          : <span className="flex items-center gap-1 text-destructive"><XCircle className="w-4 h-4" />Errore</span>}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground font-mono">
                        {r.error || (r.data?.message || "OK")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
