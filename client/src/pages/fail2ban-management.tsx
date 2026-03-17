import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Save } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { JailConfig, Fail2banFilter, ConfigFile } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { LoadingState } from "@/components/loading-state";

export default function Fail2banManagement() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Gestione Fail2ban</h1>
        <p className="text-muted-foreground">
          Configura jail, filtri e impostazioni fail2ban
        </p>
      </div>

      <Tabs defaultValue="jails">
        <TabsList className="grid w-full grid-cols-3" data-testid="tabs-fail2ban">
          <TabsTrigger value="jails" data-testid="tab-jails">Jail</TabsTrigger>
          <TabsTrigger value="filters" data-testid="tab-filters">Filtri</TabsTrigger>
          <TabsTrigger value="configs" data-testid="tab-configs">Configurazioni</TabsTrigger>
        </TabsList>

        <TabsContent value="jails" className="space-y-4">
          <JailsTab />
        </TabsContent>

        <TabsContent value="filters" className="space-y-4">
          <FiltersTab />
        </TabsContent>

        <TabsContent value="configs" className="space-y-4">
          <ConfigsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function JailsTab() {
  const { toast } = useToast();
  const [selectedJail, setSelectedJail] = useState<JailConfig | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data: jails, isLoading } = useQuery<JailConfig[]>({
    queryKey: ['/api/fail2ban/jails'],
    refetchInterval: 10000,
  });

  const updateJailMutation = useMutation({
    mutationFn: async ({ name, config }: { name: string; config: Partial<JailConfig> }) => {
      const res = await apiRequest('POST', `/api/fail2ban/jails/${name}`, { config });
      return res.json() as Promise<{ message: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/fail2ban/jails'] });
      setDialogOpen(false);
      toast({
        title: "Jail aggiornata",
        description: data.message,
      });
    },
    onError: () => {
      toast({
        title: "Errore",
        description: "Impossibile aggiornare la jail",
        variant: "destructive",
      });
    },
  });

  const handleToggleEnabled = async (jail: JailConfig) => {
    updateJailMutation.mutate({
      name: jail.name,
      config: { enabled: !jail.enabled },
    });
  };

  const handleEditJail = (jail: JailConfig) => {
    setSelectedJail(jail);
    setDialogOpen(true);
  };

  const handleSaveJail = () => {
    if (!selectedJail) return;
    
    updateJailMutation.mutate({
      name: selectedJail.name,
      config: {
        enabled: selectedJail.enabled,
        maxretry: selectedJail.maxretry,
        bantime: selectedJail.bantime,
        findtime: selectedJail.findtime,
      },
    });
  };

  if (isLoading) {
    return <LoadingState message="Caricamento jail..." />;
  }

  const displayJails = jails || [];

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Jail Fail2ban</CardTitle>
          <CardDescription>
            Gestisci le jail attive e configura i parametri di ban
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Stato</TableHead>
                  <TableHead>Filtro</TableHead>
                  <TableHead>Max Retry</TableHead>
                  <TableHead>Ban Time</TableHead>
                  <TableHead>Find Time</TableHead>
                  <TableHead className="text-right">Azioni</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayJails.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      Nessuna jail configurata
                    </TableCell>
                  </TableRow>
                ) : (
                  displayJails.map((jail) => (
                    <TableRow key={jail.name}>
                      <TableCell className="font-mono font-semibold">{jail.name}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={jail.enabled}
                            onCheckedChange={() => handleToggleEnabled(jail)}
                            disabled={updateJailMutation.isPending}
                            data-testid={`switch-jail-${jail.name}`}
                          />
                          <Badge variant={jail.enabled ? "default" : "secondary"}>
                            {jail.enabled ? "Attiva" : "Disattiva"}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{jail.filter || '-'}</TableCell>
                      <TableCell>{jail.maxretry || '-'}</TableCell>
                      <TableCell>{jail.bantime || '-'}</TableCell>
                      <TableCell>{jail.findtime || '-'}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleEditJail(jail)}
                          data-testid={`button-edit-jail-${jail.name}`}
                        >
                          Modifica
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modifica Jail: {selectedJail?.name}</DialogTitle>
            <DialogDescription>
              Configura i parametri della jail
            </DialogDescription>
          </DialogHeader>
          
          {selectedJail && (
            <div className="space-y-4 py-4">
              <div className="flex items-center justify-between">
                <Label htmlFor="enabled">Abilitata</Label>
                <Switch
                  id="enabled"
                  checked={selectedJail.enabled}
                  onCheckedChange={(checked) => setSelectedJail({ ...selectedJail, enabled: checked })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="maxretry">Max Retry</Label>
                <Input
                  id="maxretry"
                  type="number"
                  value={selectedJail.maxretry || ''}
                  onChange={(e) => setSelectedJail({ ...selectedJail, maxretry: parseInt(e.target.value) })}
                  placeholder="5"
                />
                <p className="text-xs text-muted-foreground">
                  Numero di tentativi falliti prima del ban
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="bantime">Ban Time (secondi)</Label>
                <Input
                  id="bantime"
                  value={selectedJail.bantime || ''}
                  onChange={(e) => setSelectedJail({ ...selectedJail, bantime: e.target.value })}
                  placeholder="3600"
                />
                <p className="text-xs text-muted-foreground">
                  Durata del ban in secondi (3600 = 1 ora)
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="findtime">Find Time (secondi)</Label>
                <Input
                  id="findtime"
                  value={selectedJail.findtime || ''}
                  onChange={(e) => setSelectedJail({ ...selectedJail, findtime: e.target.value })}
                  placeholder="600"
                />
                <p className="text-xs text-muted-foreground">
                  Finestra temporale per contare i tentativi falliti
                </p>
              </div>

              <div className="space-y-2">
                <Label>Filtro</Label>
                <p className="text-sm font-mono">{selectedJail.filter || 'N/A'}</p>
              </div>

              <div className="space-y-2">
                <Label>Log Path</Label>
                <p className="text-sm font-mono text-muted-foreground">{selectedJail.logpath || 'N/A'}</p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Annulla
            </Button>
            <Button onClick={handleSaveJail} disabled={updateJailMutation.isPending}>
              {updateJailMutation.isPending ? "Salvataggio..." : "Salva"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function FiltersTab() {
  const { toast } = useToast();
  const [selectedFilter, setSelectedFilter] = useState<Fail2banFilter | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editedFailregex, setEditedFailregex] = useState<string[]>([]);
  const [editedIgnoreregex, setEditedIgnoreregex] = useState<string[]>([]);

  const { data: filters, isLoading } = useQuery<Fail2banFilter[]>({
    queryKey: ['/api/fail2ban/filters'],
  });

  const updateFilterMutation = useMutation({
    mutationFn: async ({ name, failregex, ignoreregex }: { name: string; failregex: string[]; ignoreregex?: string[] }) => {
      const res = await apiRequest('POST', `/api/fail2ban/filters/${name}`, { failregex, ignoreregex });
      return res.json() as Promise<{ message: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/fail2ban/filters'] });
      setDialogOpen(false);
      toast({
        title: "Filtro aggiornato",
        description: data.message,
      });
    },
    onError: () => {
      toast({
        title: "Errore",
        description: "Impossibile aggiornare il filtro",
        variant: "destructive",
      });
    },
  });

  const handleEditFilter = (filter: Fail2banFilter) => {
    setSelectedFilter(filter);
    setEditedFailregex([...filter.failregex]);
    setEditedIgnoreregex(filter.ignoreregex ? [...filter.ignoreregex] : []);
    setDialogOpen(true);
  };

  const handleSaveFilter = () => {
    if (!selectedFilter) return;
    
    const validFailregex = editedFailregex.filter(r => r.trim());
    const validIgnoreregex = editedIgnoreregex.filter(r => r.trim());
    
    if (validFailregex.length === 0) {
      toast({
        title: "Errore",
        description: "Almeno una failregex valida è richiesta",
        variant: "destructive",
      });
      return;
    }
    
    updateFilterMutation.mutate({
      name: selectedFilter.name,
      failregex: validFailregex,
      ignoreregex: validIgnoreregex.length > 0 ? validIgnoreregex : undefined,
    });
  };

  const addFailregex = () => {
    setEditedFailregex([...editedFailregex, '']);
  };

  const removeFailregex = (index: number) => {
    const updated = editedFailregex.filter((_, i) => i !== index);
    // Prevent removing all regex entries
    if (updated.length === 0) {
      toast({
        title: "Attenzione",
        description: "Deve rimanere almeno una failregex",
        variant: "destructive",
      });
      return;
    }
    setEditedFailregex(updated);
  };

  const updateFailregex = (index: number, value: string) => {
    const updated = [...editedFailregex];
    updated[index] = value;
    setEditedFailregex(updated);
  };

  const addIgnoreregex = () => {
    setEditedIgnoreregex([...editedIgnoreregex, '']);
  };

  const removeIgnoreregex = (index: number) => {
    setEditedIgnoreregex(editedIgnoreregex.filter((_, i) => i !== index));
  };

  const updateIgnoreregex = (index: number, value: string) => {
    const updated = [...editedIgnoreregex];
    updated[index] = value;
    setEditedIgnoreregex(updated);
  };

  if (isLoading) {
    return <LoadingState message="Caricamento filtri..." />;
  }

  const displayFilters = filters || [];

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Filtri Fail2ban</CardTitle>
          <CardDescription>
            Gestisci i filtri e le loro regex di rilevamento
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {displayFilters.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                Nessun filtro disponibile
              </div>
            ) : (
              displayFilters.map((filter) => (
                <Card key={filter.name} className="overflow-hidden">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <CardTitle className="text-base font-mono">{filter.name}</CardTitle>
                        {filter.description && (
                          <CardDescription className="mt-1">{filter.description}</CardDescription>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="font-mono text-xs">
                          {filter.path}
                        </Badge>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleEditFilter(filter)}
                          data-testid={`button-edit-filter-${filter.name}`}
                        >
                          Modifica
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div>
                      <Label className="text-xs font-semibold">Fail Regex ({filter.failregex.length}):</Label>
                      <div className="mt-1 space-y-1">
                        {filter.failregex.map((regex, idx) => (
                          <code
                            key={idx}
                            className="block text-xs bg-muted p-2 rounded font-mono break-all"
                          >
                            {regex}
                          </code>
                        ))}
                      </div>
                    </div>
                    
                    {filter.ignoreregex && filter.ignoreregex.length > 0 && (
                      <div>
                        <Label className="text-xs font-semibold">Ignore Regex ({filter.ignoreregex.length}):</Label>
                        <div className="mt-1 space-y-1">
                          {filter.ignoreregex.map((regex, idx) => (
                            <code
                              key={idx}
                              className="block text-xs bg-muted p-2 rounded font-mono break-all"
                            >
                              {regex}
                            </code>
                          ))}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Modifica Filtro: {selectedFilter?.name}</DialogTitle>
            <DialogDescription>
              Modifica le regex di rilevamento e esclusione del filtro
            </DialogDescription>
          </DialogHeader>
          
          {selectedFilter && (
            <div className="space-y-6 py-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-semibold">Fail Regex</Label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={addFailregex}
                    data-testid="button-add-failregex"
                  >
                    + Aggiungi Regex
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Pattern regex che identificano i tentativi falliti da bannare
                </p>
                <div className="space-y-2">
                  {editedFailregex.map((regex, idx) => (
                    <div key={idx} className="flex gap-2">
                      <Input
                        value={regex}
                        onChange={(e) => updateFailregex(idx, e.target.value)}
                        placeholder="es: Failed password for .* from <HOST>"
                        className="font-mono text-sm"
                        data-testid={`input-failregex-${idx}`}
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => removeFailregex(idx)}
                        disabled={editedFailregex.length === 1}
                        data-testid={`button-remove-failregex-${idx}`}
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-semibold">Ignore Regex (opzionale)</Label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={addIgnoreregex}
                    data-testid="button-add-ignoreregex"
                  >
                    + Aggiungi Regex
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Pattern regex per escludere falsi positivi dal ban
                </p>
                <div className="space-y-2">
                  {editedIgnoreregex.length > 0 ? (
                    editedIgnoreregex.map((regex, idx) => (
                      <div key={idx} className="flex gap-2">
                        <Input
                          value={regex}
                          onChange={(e) => updateIgnoreregex(idx, e.target.value)}
                          placeholder="es: Authentication succeeded"
                          className="font-mono text-sm"
                          data-testid={`input-ignoreregex-${idx}`}
                        />
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => removeIgnoreregex(idx)}
                          data-testid={`button-remove-ignoreregex-${idx}`}
                        >
                          ×
                        </Button>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground italic">
                      Nessuna ignore regex configurata
                    </p>
                  )}
                </div>
              </div>

              <Card className="bg-muted/50">
                <CardHeader>
                  <CardTitle className="text-sm">Nota</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground space-y-2">
                  <p>
                    • Le modifiche verranno scritte in <code className="bg-muted px-1 rounded">{selectedFilter.path}</code>
                  </p>
                  <p>
                    • Il servizio fail2ban verrà ricaricato automaticamente
                  </p>
                  <p>
                    • Usa <code className="bg-muted px-1 rounded">&lt;HOST&gt;</code> per indicare l'indirizzo IP da bannare
                  </p>
                </CardContent>
              </Card>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Annulla
            </Button>
            <Button
              onClick={handleSaveFilter}
              disabled={updateFilterMutation.isPending}
              data-testid="button-save-filter"
            >
              {updateFilterMutation.isPending ? "Salvataggio..." : "Salva Modifiche"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ConfigsTab() {
  const { toast } = useToast();
  const [activeConfig, setActiveConfig] = useState<'jail.local' | 'fail2ban.local'>('jail.local');
  const [editedContent, setEditedContent] = useState("");
  const [hasChanges, setHasChanges] = useState(false);

  const { data: configFile, isLoading } = useQuery<ConfigFile>({
    queryKey: ['/api/fail2ban/config', activeConfig],
  });

  const updateConfigMutation = useMutation({
    mutationFn: async ({ type, content }: { type: string; content: string }) => {
      const res = await apiRequest('POST', `/api/fail2ban/config/${type}`, { content });
      return res.json() as Promise<{ message: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/fail2ban/config'] });
      setHasChanges(false);
      toast({
        title: "Configurazione salvata",
        description: data.message,
      });
    },
    onError: () => {
      toast({
        title: "Errore",
        description: "Impossibile salvare la configurazione",
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    if (configFile) {
      setEditedContent(configFile.content);
      setHasChanges(false);
    }
  }, [configFile]);

  const handleSave = () => {
    updateConfigMutation.mutate({ type: activeConfig, content: editedContent });
  };

  const handleReset = () => {
    setEditedContent(configFile?.content || "");
    setHasChanges(false);
  };

  const handleConfigChange = (type: 'jail.local' | 'fail2ban.local') => {
    if (hasChanges) {
      if (!confirm("Hai modifiche non salvate. Vuoi davvero cambiare configurazione?")) {
        return;
      }
    }
    setActiveConfig(type);
  };

  if (isLoading) {
    return <LoadingState message="Caricamento configurazione..." />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>File di Configurazione Fail2ban</CardTitle>
        <CardDescription>
          Modifica jail.local e fail2ban.local direttamente
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Button
            variant={activeConfig === 'jail.local' ? 'default' : 'outline'}
            onClick={() => handleConfigChange('jail.local')}
            data-testid="button-jail-local"
          >
            jail.local
          </Button>
          <Button
            variant={activeConfig === 'fail2ban.local' ? 'default' : 'outline'}
            onClick={() => handleConfigChange('fail2ban.local')}
            data-testid="button-fail2ban-local"
          >
            fail2ban.local
          </Button>
        </div>

        {configFile && (
          <div className="space-y-2">
            <div className="flex items-start gap-2 text-sm">
              <span className="font-medium text-muted-foreground">Percorso:</span>
              <span className="font-mono text-xs">{configFile.path}</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {configFile.description}
            </p>
          </div>
        )}

        <div>
          <Textarea
            value={editedContent}
            onChange={(e) => {
              setEditedContent(e.target.value);
              setHasChanges(true);
            }}
            className="font-mono text-sm min-h-[500px]"
            placeholder="# Configurazione fail2ban..."
            data-testid="textarea-fail2ban-config"
          />
        </div>

        <div className="flex justify-between items-center">
          {hasChanges && (
            <Badge variant="secondary">Modifiche non salvate</Badge>
          )}
          <div className="flex gap-2 ml-auto">
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={!hasChanges || updateConfigMutation.isPending}
            >
              Ripristina
            </Button>
            <Button
              onClick={handleSave}
              disabled={!hasChanges || updateConfigMutation.isPending}
              data-testid="button-save-fail2ban-config"
            >
              <Save className="w-4 h-4 mr-1" />
              {updateConfigMutation.isPending ? "Salvataggio..." : "Salva Modifiche"}
            </Button>
          </div>
        </div>

        <Card className="bg-muted/50">
          <CardHeader>
            <CardTitle className="text-sm">Importante</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              • Le modifiche a questi file richiedono il reload di fail2ban per essere applicate
            </p>
            <p>
              • Il servizio fail2ban verrà ricaricato automaticamente dopo il salvataggio
            </p>
            <p>
              • Verifica la sintassi prima di salvare per evitare errori di configurazione
            </p>
          </CardContent>
        </Card>
      </CardContent>
    </Card>
  );
}
