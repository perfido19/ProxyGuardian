import { useState } from "react";
import { Link } from "wouter";
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
import { Plus, Pencil, Trash2, Server, Wifi, WifiOff, RefreshCw, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { LoadingState } from "@/components/loading-state";
import { apiRequest, queryClient } from "@/lib/queryClient";

export default function VpsManager() {
  const { toast } = useToast();
  const { data: vpsList, isLoading } = useVpsList();
  const { data: healthMap, refetch: refetchHealth } = useVpsHealth();
  const createVps = useCreateVps();
  const updateVps = useUpdateVps();
  const deleteVps = useDeleteVps();

  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selected, setSelected] = useState<VpsConfig | null>(null);
  const [checkingHealth, setCheckingHealth] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", host: "", port: "3001", apiKey: "", tags: "" });
  const [editForm, setEditForm] = useState({ name: "", host: "", port: "3001", apiKey: "", tags: "", enabled: true });

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
                    <TableHead>Stato</TableHead><TableHead>Tag</TableHead><TableHead>Ultimo contatto</TableHead>
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
                      <TableCell><div className="flex gap-1 flex-wrap">{vps.tags.map(t => <Badge key={t} variant="outline" className="text-xs">{t}</Badge>)}</div></TableCell>
                      <TableCell className="text-sm text-muted-foreground">{vps.lastSeen ? new Date(vps.lastSeen).toLocaleString("it-IT") : "Mai"}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" onClick={() => handleCheckHealth(vps)} disabled={checkingHealth === vps.id} title="Verifica connessione">
                            {checkingHealth === vps.id ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
                          </Button>
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

      <Card>
        <CardHeader><CardTitle className="text-sm">Come aggiungere un VPS</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-1">
          <p>1. Copia <code className="bg-muted px-1 rounded font-mono text-xs">agent/</code> sul VPS remoto</p>
          <p>2. Esegui: <code className="bg-muted px-1 rounded font-mono text-xs">bash install-agent.sh</code></p>
          <p>3. Lo script mostra IP NetBird e API Key generata</p>
          <p>4. Inseriscili qui e clicca "Verifica connessione"</p>
        </CardContent>
      </Card>

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
