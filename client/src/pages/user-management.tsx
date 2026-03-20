import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth, type AuthUser } from "@/hooks/use-auth";
import { useVpsList } from "@/hooks/use-vps";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2, Users, Server } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { LoadingState } from "@/components/loading-state";

type UserRole = "admin" | "operator";

const roleLabels: Record<UserRole, string> = {
  admin: "Admin",
  operator: "Operator",
};

const roleBadgeVariant: Record<UserRole, "default" | "secondary"> = {
  admin: "default",
  operator: "secondary",
};

function VpsAssignPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { data: vpsList } = useVpsList();
  const list = vpsList || [];

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
  };

  if (list.length === 0) return <p className="text-xs text-muted-foreground">Nessun VPS disponibile</p>;

  return (
    <div className="space-y-2 max-h-40 overflow-y-auto border rounded-md p-2">
      {list.map(v => (
        <div key={v.id} className="flex items-center gap-2">
          <Checkbox
            id={`vps-${v.id}`}
            checked={selected.includes(v.id)}
            onCheckedChange={() => toggle(v.id)}
          />
          <label htmlFor={`vps-${v.id}`} className="text-sm font-mono cursor-pointer select-none">
            {v.name}
          </label>
        </div>
      ))}
    </div>
  );
}

export default function UserManagement() {
  const { user: currentUser } = useAuth();
  const { data: vpsList } = useVpsList();
  const { toast } = useToast();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<AuthUser | null>(null);

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("operator");
  const [newAssignedVps, setNewAssignedVps] = useState<string[]>([]);

  const [editPassword, setEditPassword] = useState("");
  const [editRole, setEditRole] = useState<UserRole>("operator");
  const [editEnabled, setEditEnabled] = useState(true);
  const [editAssignedVps, setEditAssignedVps] = useState<string[]>([]);

  const { data: users, isLoading } = useQuery<AuthUser[]>({
    queryKey: ["/api/users"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: { username: string; password: string; role: UserRole; assignedVps?: string[] }) => {
      const res = await apiRequest("POST", "/api/users", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setCreateDialogOpen(false);
      setNewUsername(""); setNewPassword(""); setNewRole("operator"); setNewAssignedVps([]);
      toast({ title: "Utente creato", description: "Nuovo utente aggiunto con successo" });
    },
    onError: (e: any) => {
      toast({ title: "Errore", description: e.message || "Impossibile creare utente", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: string; password?: string; role?: UserRole; enabled?: boolean; assignedVps?: string[] }) => {
      const res = await apiRequest("PUT", `/api/users/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      setEditDialogOpen(false);
      toast({ title: "Utente aggiornato", description: "Modifiche salvate con successo" });
    },
    onError: (e: any) => {
      toast({ title: "Errore", description: e.message || "Impossibile aggiornare utente", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/users/${id}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setDeleteDialogOpen(false);
      toast({ title: "Utente eliminato" });
    },
    onError: (e: any) => {
      toast({ title: "Errore", description: e.message || "Impossibile eliminare utente", variant: "destructive" });
    },
  });

  const handleEditOpen = (user: AuthUser) => {
    setSelectedUser(user);
    setEditRole(user.role);
    setEditEnabled(user.enabled);
    setEditPassword("");
    setEditAssignedVps(user.assignedVps ?? []);
    setEditDialogOpen(true);
  };

  const handleDeleteOpen = (user: AuthUser) => {
    setSelectedUser(user);
    setDeleteDialogOpen(true);
  };

  const handleCreate = () => {
    if (!newUsername || !newPassword) return;
    createMutation.mutate({
      username: newUsername,
      password: newPassword,
      role: newRole,
      ...(newRole === "operator" ? { assignedVps: newAssignedVps } : {}),
    });
  };

  const handleEdit = () => {
    if (!selectedUser) return;
    updateMutation.mutate({
      id: selectedUser.id,
      ...(editPassword ? { password: editPassword } : {}),
      role: editRole,
      enabled: editEnabled,
      ...(editRole === "operator" ? { assignedVps: editAssignedVps } : {}),
    });
  };

  const vpsNameMap = new Map((vpsList || []).map(v => [v.id, v.name]));

  if (isLoading) return <LoadingState message="Caricamento utenti..." />;

  const displayUsers = users || [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Gestione Utenti</h1>
        <p className="text-muted-foreground">Amministra gli accessi alla dashboard</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Users className="w-5 h-5" />
                Utenti
              </CardTitle>
              <CardDescription>{displayUsers.length} utenti configurati</CardDescription>
            </div>
            <Button onClick={() => setCreateDialogOpen(true)}>
              <Plus className="w-4 h-4 mr-1" />
              Nuovo Utente
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Username</TableHead>
                  <TableHead>Ruolo</TableHead>
                  <TableHead>VPS Assegnati</TableHead>
                  <TableHead>Stato</TableHead>
                  <TableHead>Ultimo Accesso</TableHead>
                  <TableHead className="text-right">Azioni</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayUsers.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-mono font-medium">
                      {u.username}
                      {u.id === currentUser?.id && (
                        <Badge variant="outline" className="ml-2 text-xs">Tu</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={roleBadgeVariant[u.role]}>
                        {roleLabels[u.role]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {u.role === "admin" ? (
                        <span className="text-xs text-muted-foreground">Tutti</span>
                      ) : u.assignedVps && u.assignedVps.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {u.assignedVps.map(id => (
                            <Badge key={id} variant="outline" className="text-xs font-mono">
                              <Server className="w-2.5 h-2.5 mr-1" />
                              {vpsNameMap.get(id) ?? id}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">Nessuno</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={u.enabled ? "default" : "secondary"}>
                        {u.enabled ? "Attivo" : "Disabilitato"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {u.lastLogin ? new Date(u.lastLogin).toLocaleString("it-IT") : "Mai"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="icon" onClick={() => handleEditOpen(u)}>
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDeleteOpen(u)}
                          disabled={u.id === currentUser?.id}
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Info ruoli */}
      <Card>
        <CardHeader><CardTitle className="text-sm">Permessi per Ruolo</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p><Badge variant="default" className="mr-2">Admin</Badge>Accesso completo a tutti i VPS: lettura, scrittura, configurazioni, gestione utenti</p>
          <p><Badge variant="secondary" className="mr-2">Operator</Badge>Accesso solo ai VPS assegnati — lettura, azioni su servizi, ban/unban. Configurazioni in sola lettura.</p>
        </CardContent>
      </Card>

      {/* Dialog crea utente */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nuovo Utente</DialogTitle>
            <DialogDescription>Crea un nuovo account per la dashboard</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Username</Label>
              <Input
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder="es. mario.rossi"
              />
            </div>
            <div className="space-y-2">
              <Label>Password</Label>
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Minimo 6 caratteri"
              />
            </div>
            <div className="space-y-2">
              <Label>Ruolo</Label>
              <Select value={newRole} onValueChange={(v) => setNewRole(v as UserRole)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="operator">Operator</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {newRole === "operator" && (
              <div className="space-y-2">
                <Label>VPS Assegnati</Label>
                <VpsAssignPicker selected={newAssignedVps} onChange={setNewAssignedVps} />
                <p className="text-xs text-muted-foreground">L'operator vedrà solo i VPS selezionati</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>Annulla</Button>
            <Button
              onClick={handleCreate}
              disabled={!newUsername || !newPassword || createMutation.isPending}
            >
              {createMutation.isPending ? "Creazione..." : "Crea Utente"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog modifica utente */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modifica: {selectedUser?.username}</DialogTitle>
            <DialogDescription>Aggiorna ruolo, password, stato e VPS assegnati</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Nuova Password <span className="text-muted-foreground">(opzionale)</span></Label>
              <Input
                type="password"
                value={editPassword}
                onChange={(e) => setEditPassword(e.target.value)}
                placeholder="Lascia vuoto per non cambiare"
              />
            </div>
            <div className="space-y-2">
              <Label>Ruolo</Label>
              <Select value={editRole} onValueChange={(v) => setEditRole(v as UserRole)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="operator">Operator</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {editRole === "operator" && (
              <div className="space-y-2">
                <Label>VPS Assegnati</Label>
                <VpsAssignPicker selected={editAssignedVps} onChange={setEditAssignedVps} />
                <p className="text-xs text-muted-foreground">L'operator vedrà solo i VPS selezionati</p>
              </div>
            )}
            <div className="flex items-center justify-between">
              <Label>Account abilitato</Label>
              <Switch
                checked={editEnabled}
                onCheckedChange={setEditEnabled}
                disabled={selectedUser?.id === currentUser?.id}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>Annulla</Button>
            <Button onClick={handleEdit} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? "Salvataggio..." : "Salva Modifiche"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog elimina utente */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Elimina Utente</AlertDialogTitle>
            <AlertDialogDescription>
              Sei sicuro di voler eliminare <strong>{selectedUser?.username}</strong>? Questa azione non può essere annullata.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => selectedUser && deleteMutation.mutate(selectedUser.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Elimina
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
