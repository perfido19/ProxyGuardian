import { useState, useMemo } from "react";
import { copyToClipboard } from "@/lib/clipboard";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useVpsList, useVpsHealth, useCreateVps, useUpdateVps, useDeleteVps, type VpsConfig } from "@/hooks/use-vps";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2, Server, Wifi, WifiOff, RefreshCw, ExternalLink, Copy, Check, Download, Upload, HardDrive } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { LoadingState } from "@/components/loading-state";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useQuery } from "@tanstack/react-query";

const INSTALL_CMD = "curl -fsSL https://raw.githubusercontent.com/perfido19/ProxyGuardian/main/agent/install.sh | sudo bash";

export default function VpsManager() {
  const { toast } = useToast();
  const { user } = useAuth();
  const { data: vpsList, isLoading } = useVpsList();
  const { data: healthMap, refetch: refetchHealth } = useVpsHealth();
  const createVps = useCreateVps();
  const updateVps = useUpdateVps();
  const deleteVps = useDeleteVps();

  const [copied, setCopied] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selected, setSelected] = useState<VpsConfig | null>(null);
  const [checkingHealth, setCheckingHealth] = useState<string | null>(null);
  const [updatingAgent, setUpdatingAgent] = useState<string | null>(null); // vpsId | "all"
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [form, setForm] = useState({ name: "", host: "", port: "3001", apiKey: "", tags: "" });
  const [editForm, setEditForm] = useState({ name: "", host: "", port: "3001", apiKey: "", tags: "", enabled: true });

  const { data: agentVersions, refetch: refetchVersions } = useQuery<Array<{ vpsId: string; vpsName: string; version: string | null; online: boolean }>>({
    queryKey: ["/api/vps/agents/versions"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/vps/agents/versions");
      return res.json();
    },
    staleTime: 30000,
  });

  const versionMap = useMemo(() => {
    const m: Record<string, string | null> = {};
    if (agentVersions) agentVersions.forEach(v => { m[v.vpsId] = v.version; });
    return m;
  }, [agentVersions]);

  const handleCreate = () => {
    if (!form.name || !form.host || !form.apiKey) return;
    createVps.mutate(
      { name: form.name, host: form.host, port: parseInt(form.port) || 3001, apiKey: form.apiKey, tags: form.tags ? form.tags.split(",").map(t => t.trim()) : [] },
      {
        onSuccess: () => { setCreateOpen(false); setForm({ name: "", host: "", port: "3001", apiKey: "", tags: "" }); toast({ title: "VPS aggiunto", description: `${form.name} aggiunto con successo` }); },
        onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
      }
    );
  };

  const handleEditOpen = (vps: VpsConfig) => {
    setSelected(vps);
    setEditForm({ name: vps.name, host: vps.host, port: String(vps.port), apiKey: "", tags: vps.tags.join(", "), enabled: vps.enabled });
    setEditOpen(true);
  };

  const handleEdit = () => {
    if (!selected) return;
    updateVps.mutate(
      { id: selected.id, name: editForm.name, host: editForm.host, port: parseInt(editForm.port) || 3001, ...(editForm.apiKey ? { apiKey: editForm.apiKey } : {}), tags: editForm.tags ? editForm.tags.split(",").map(t => t.trim()) : [], enabled: editForm.enabled },
      { onSuccess: () => { setEditOpen(false); toast({ title: "VPS aggiornato" }); }, onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }) }
    );
  };

  const handleDelete = () => {
    if (!selected) return;
    deleteVps.mutate(selected.id, {
      onSuccess: () => { setDeleteOpen(false); toast({ title: "VPS eliminato" }); },
      onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
    });
  };

  const handleCheckHealth = async (vps: VpsConfig) => {
    setCheckingHealth(vps.id);
    try {
      const res = await apiRequest("GET", `/api/vps/${vps.id}/health`);
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/vps"] });
      toast({ title: data.online ? "VPS Online" : "VPS Offline", description: `${vps.name}: ${data.online ? "raggiungibile" : "non raggiungibile"}`, variant: data.online ? "default" : "destructive" });
    } catch { toast({ title: "Errore", description: "Impossibile contattare il VPS", variant: "destructive" }); }
    finally { setCheckingHealth(null); }
  };

  const handleUpdateAgent = async (vps: VpsConfig) => {
    setUpdatingAgent(vps.id);
    try {
      const res = await apiRequest("POST", `/api/vps/${vps.id}/agent/update`);
      const data = await res.json();
      if (data.ok) {
        toast({ title: "Agent aggiornato", description: `${vps.name}: riavvio in corso...` });
        setTimeout(() => refetchVersions(), 4000);
      } else {
        toast({ title: "Errore update", description: data.error || "Errore sconosciuto", variant: "destructive" });
      }
    } catch {
      toast({ title: "Errore", description: "Impossibile contattare il VPS", variant: "destructive" });
    } finally { setUpdatingAgent(null); }
  };

  const handleUpdateAllAgents = async () => {
    setUpdatingAgent("all");
    try {
      const res = await apiRequest("POST", "/api/vps/bulk/agent/update");
      const results: Array<{ vpsName: string; success: boolean; error?: string }> = await res.json();
      const ok = results.filter(r => r.success).length;
      const fail = results.filter(r => !r.success).length;
      toast({
        title: `Agent aggiornati: ${ok}/${results.length}`,
        description: fail > 0 ? `${fail} falliti` : "Tutti i VPS stanno riavviando...",
        variant: fail > 0 ? "destructive" : "default",
      });
      setTimeout(() => refetchVersions(), 5000);
    } catch {
      toast({ title: "Errore", description: "Errore durante l'aggiornamento", variant: "destructive" });
    } finally { setUpdatingAgent(null); }
  };

  const handleBackup = async () => {
    setBackingUp(true);
    try {
      const res = await apiRequest("GET", "/api/admin/backup");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const today = new Date().toISOString().slice(0, 10);
      a.href = url; a.download = `pg-backup-${today}.json`;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
      toast({ title: "Backup scaricato", description: `pg-backup-${today}.json` });
    } catch { toast({ title: "Errore backup", variant: "destructive" }); }
    finally { setBackingUp(false); }
  };

  const handleRestore = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (data.version !== 1) { toast({ title: "File non valido", description: "Versione backup non supportata", variant: "destructive" }); return; }
        setRestoring(true);
        const res = await apiRequest("POST", "/api/admin/restore", data);
        const result = await res.json();
        if (result.ok) {
          toast({ title: "Ripristino completato", description: "Il server si sta riavviando..." });
          setTimeout(() => window.location.reload(), 5000);
        } else {
          toast({ title: "Errore ripristino", description: result.error, variant: "destructive" });
          setRestoring(false);
        }
      } catch { toast({ title: "Errore", description: "File JSON non valido", variant: "destructive" }); setRestoring(false); }
    };
    reader.readAsText(file);
  };

  const getStatusBadge = (vps: VpsConfig) => {
    if (!vps.enabled) return <Badge variant="secondary">Disabilitato</Badge>;
    const health = healthMap?.[vps.id];
    const status = health === true ? "online" : health === false ? "offline" : vps.lastStatus || "unknown";
    if (status === "online") return <Badge className="bg-green-600 text-white"><Wifi className="w-3 h-3 mr-1" />Online</Badge>;
    if (status === "offline") return <Badge variant="destructive"><WifiOff className="w-3 h-3 mr-1" />Offline</Badge>;
    return <Badge variant="outline">Sconosciuto</Badge>;
  };

  if (isLoading) return <LoadingState message="Caricamento VPS..." />;
  const list = vpsList || [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-heading font-bold tracking-tight">Gestione VPS</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Aggiungi e monitora i tuoi VPS sulla rete NetBird</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2"><Server className="w-5 h-5" />VPS Configurati</CardTitle>
              <CardDescription>{list.length} VPS • {list.filter(v => v.enabled).length} abilitati</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => refetchHealth()}><RefreshCw className="w-4 h-4 mr-1" />Aggiorna stato</Button>
              {user?.role === "admin" && (
                <Button variant="outline" size="sm" onClick={handleUpdateAllAgents} disabled={updatingAgent === "all"}>
                  {updatingAgent === "all" ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <Download className="w-4 h-4 mr-1" />}
                  Aggiorna tutti gli agent
                </Button>
              )}
              <Button onClick={() => setCreateOpen(true)} data-testid="button-add-vps"><Plus className="w-4 h-4 mr-1" />Aggiungi VPS</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {list.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Server className="w-12 h-12 mx-auto mb-4 opacity-30" />
              <p className="font-medium">Nessun VPS configurato</p>
              <p className="text-sm mt-1">Aggiungi il primo VPS per iniziare</p>
            </div>
          ) : (
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nome</TableHead><TableHead>Host (NetBird)</TableHead><TableHead>Porta</TableHead>
                    <TableHead>Stato</TableHead><TableHead>Agent</TableHead><TableHead>Tag</TableHead><TableHead>Ultimo contatto</TableHead>
                    <TableHead className="text-right">Azioni</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map(vps => (
                    <TableRow key={vps.id}>
                      <TableCell className="font-medium">{vps.name}</TableCell>
                      <TableCell className="font-mono text-sm">{vps.host}</TableCell>
                      <TableCell className="font-mono text-sm">{vps.port}</TableCell>
                      <TableCell>{getStatusBadge(vps)}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {versionMap[vps.id] ? <Badge variant="outline" className="text-xs font-mono">v{versionMap[vps.id]}</Badge> : <span className="text-xs text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell><div className="flex gap-1 flex-wrap">{vps.tags.map(t => <Badge key={t} variant="outline" className="text-xs">{t}</Badge>)}</div></TableCell>
                      <TableCell className="text-sm text-muted-foreground">{vps.lastSeen ? new Date(vps.lastSeen).toLocaleString("it-IT") : "Mai"}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" onClick={() => handleCheckHealth(vps)} disabled={checkingHealth === vps.id} title="Verifica connessione">
                            {checkingHealth === vps.id ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
                          </Button>
                          {user?.role === "admin" && (
                            <Button variant="ghost" size="icon" onClick={() => handleUpdateAgent(vps)} disabled={updatingAgent === vps.id || updatingAgent === "all"} title="Aggiorna agent">
                              {updatingAgent === vps.id ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                            </Button>
                          )}
                          <Link href={`/vps/${vps.id}`}>
                            <Button variant="ghost" size="icon" title="Dettagli"><ExternalLink className="w-4 h-4" /></Button>
                          </Link>
                          <Button variant="outline" size="icon" onClick={() => handleEditOpen(vps)}><Pencil className="w-4 h-4" /></Button>
                          <Button variant="ghost" size="icon" onClick={() => { setSelected(vps); setDeleteOpen(true); }}><Trash2 className="w-4 h-4 text-destructive" /></Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {user?.role === "admin" && (
        <Card className="border-card-border">
          <CardHeader>
            <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Installa Agent su nuovo VPS</CardTitle>
            <CardDescription>Esegui questo comando sul VPS remoto come root. Lo script installa l'agent, genera l'API Key e mostra l'IP NetBird da inserire qui.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-muted px-3 py-2 rounded font-mono text-xs break-all">{INSTALL_CMD}</code>
              <Button size="sm" variant="outline" className="shrink-0"
                onClick={() => {
                  copyToClipboard(INSTALL_CMD);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}>
                {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
            <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
              <li>Esegui il comando sul VPS remoto</li>
              <li>Lo script mostra l'IP NetBird (100.x.x.x) e l'API Key generata</li>
              <li>Clicca <strong>"Aggiungi VPS"</strong> e inserisci i valori</li>
              <li>Clicca "Verifica connessione" per confermare</li>
            </ol>
          </CardContent>
        </Card>
      )}

      {user?.role === "admin" && (
        <Card className="border-card-border">
          <CardHeader>
            <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground flex items-center gap-2">
              <HardDrive className="w-4 h-4" />Backup & Ripristino
            </CardTitle>
            <CardDescription>
              Esporta la configurazione completa (VPS, utenti, ASN fleet) o ripristinala su un nuovo host.
              Il ripristino sovrascrive i dati attuali e riavvia il server.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              <Button variant="outline" onClick={handleBackup} disabled={backingUp}>
                {backingUp ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
                Scarica Backup
              </Button>
              <label>
                <Button variant="outline" asChild disabled={restoring}>
                  <span className={restoring ? "pointer-events-none opacity-50" : "cursor-pointer"}>
                    {restoring ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                    {restoring ? "Ripristino in corso..." : "Ripristina da Backup"}
                  </span>
                </Button>
                <input type="file" accept=".json" className="hidden" onChange={handleRestore} disabled={restoring} />
              </label>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Contiene: VPS + API Keys, utenti, blocklist/whitelist ASN. Non include sessioni attive.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Dialog crea */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Aggiungi VPS</DialogTitle><DialogDescription>Configura la connessione tramite agent NetBird</DialogDescription></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2"><Label>Nome</Label><Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="es. VPS Milano 01" /></div>
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2 space-y-2"><Label>IP / Hostname NetBird</Label><Input value={form.host} onChange={e => setForm({ ...form, host: e.target.value })} placeholder="100.64.0.1" /></div>
              <div className="space-y-2"><Label>Porta</Label><Input value={form.port} onChange={e => setForm({ ...form, port: e.target.value })} placeholder="3001" /></div>
            </div>
            <div className="space-y-2"><Label>API Key</Label><Input value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} type="password" placeholder="Da install-agent.sh" /></div>
            <div className="space-y-2"><Label>Tag <span className="text-muted-foreground">(separati da virgola)</span></Label><Input value={form.tags} onChange={e => setForm({ ...form, tags: e.target.value })} placeholder="production, milan" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Annulla</Button>
            <Button onClick={handleCreate} disabled={!form.name || !form.host || !form.apiKey || createVps.isPending}>{createVps.isPending ? "Aggiunta..." : "Aggiungi VPS"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog modifica */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Modifica: {selected?.name}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2"><Label>Nome</Label><Input value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} /></div>
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2 space-y-2"><Label>IP / Hostname</Label><Input value={editForm.host} onChange={e => setEditForm({ ...editForm, host: e.target.value })} /></div>
              <div className="space-y-2"><Label>Porta</Label><Input value={editForm.port} onChange={e => setEditForm({ ...editForm, port: e.target.value })} /></div>
            </div>
            <div className="space-y-2"><Label>Nuova API Key <span className="text-muted-foreground">(opzionale)</span></Label><Input value={editForm.apiKey} onChange={e => setEditForm({ ...editForm, apiKey: e.target.value })} type="password" placeholder="Lascia vuoto per non cambiare" /></div>
            <div className="space-y-2"><Label>Tag</Label><Input value={editForm.tags} onChange={e => setEditForm({ ...editForm, tags: e.target.value })} /></div>
            <div className="flex items-center justify-between"><Label>Abilitato</Label><Switch checked={editForm.enabled} onCheckedChange={v => setEditForm({ ...editForm, enabled: v })} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Annulla</Button>
            <Button onClick={handleEdit} disabled={updateVps.isPending}>{updateVps.isPending ? "Salvataggio..." : "Salva"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog elimina */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Elimina VPS</AlertDialogTitle>
            <AlertDialogDescription>Rimuovere <strong>{selected?.name}</strong> dalla dashboard? L'agent sul VPS non verrà disinstallato.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Elimina</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
