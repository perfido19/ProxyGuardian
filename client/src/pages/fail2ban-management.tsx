import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useVpsList, useVpsHealth } from "@/hooks/use-vps";
import { apiRequest } from "@/lib/queryClient";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Save, Wifi, RefreshCw, Search, Server, ChevronDown } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { LoadingState } from "@/components/loading-state";

interface BulkResult { vpsId: string; vpsName: string; success: boolean; error?: string; }

function useDefaultVpsId() {
  const { data: vpsList } = useVpsList();
  const { data: healthMap } = useVpsHealth();
  return vpsList?.find(v => healthMap?.[v.id])?.id ?? null;
}

function useBulkPost(path: string, targetVpsIds: string[]) {
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (body: object) => {
      const r = await apiRequest("POST", "/api/vps/bulk/post", { vpsIds: targetVpsIds, path, body });
      return r.json() as Promise<BulkResult[]>;
    },
    onSuccess: (results) => {
      const ok = results.filter(r => r.success).length;
      toast({
        title: ok === results.length ? `Salvato su tutti i ${results.length} VPS selezionati` : `Salvato su ${ok}/${results.length} VPS`,
        variant: ok === results.length ? "default" : "destructive",
      });
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });
}

function RefVpsBanner({ name, count }: { name: string; count: number }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 border border-border rounded-md px-3 py-2 mb-4">
      <Wifi className="w-3.5 h-3.5 text-green-500" />
      <span>Lettura da: <strong className="text-foreground">{name}</strong></span>
      <span className="ml-auto">Applica a <strong className="text-foreground">{count}</strong> VPS selezionati</span>
    </div>
  );
}

function VpsTargetSelector({ allVpsIds, value, onChange }: { allVpsIds: string[]; value: string[]; onChange: (ids: string[]) => void }) {
  const { data: vpsList } = useVpsList();
  const { data: healthMap } = useVpsHealth();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const filtered = (vpsList || []).filter(v => !search || v.name.toLowerCase().includes(search.toLowerCase()));
  const allSelected = allVpsIds.length > 0 && value.length === allVpsIds.length;

  const toggle = (id: string) => onChange(value.includes(id) ? value.filter(v => v !== id) : [...value, id]);
  const toggleAll = () => onChange(allSelected ? [] : allVpsIds);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-sm">
          <Server className="w-3.5 h-3.5 mr-1.5" />
          {allSelected ? `Tutti i VPS (${value.length})` : `${value.length} VPS selezionati`}
          <ChevronDown className="w-3.5 h-3.5 ml-1.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="p-2 border-b border-border space-y-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input placeholder="Cerca VPS..." value={search} onChange={e => setSearch(e.target.value)} className="pl-8 h-8 text-sm" />
          </div>
          <div className="flex items-center gap-2 px-1">
            <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
            <span className="text-xs text-muted-foreground">Seleziona tutti ({allVpsIds.length})</span>
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="text-center text-xs text-muted-foreground py-4">Nessun risultato</div>
          ) : filtered.map(v => (
            <label key={v.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 cursor-pointer text-sm">
              <Checkbox checked={value.includes(v.id)} onCheckedChange={() => toggle(v.id)} />
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${healthMap?.[v.id] ? "bg-green-500" : "bg-destructive"}`} />
              <span className="truncate">{v.name}</span>
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function VpsSelector({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { data: vpsList } = useVpsList();
  const { data: healthMap } = useVpsHealth();
  const onlineVps = (vpsList || []).filter(v => healthMap?.[v.id]);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-44 h-8 text-sm">
        <SelectValue placeholder="Seleziona VPS" />
      </SelectTrigger>
      <SelectContent>
        {onlineVps.map(v => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
        {(vpsList || []).filter(v => !healthMap?.[v.id]).map(v => (
          <SelectItem key={v.id} value={v.id} disabled>{v.name} (offline)</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function Fail2banManagement() {
  const defaultVpsId = useDefaultVpsId();
  const [selectedVpsId, setSelectedVpsId] = useState<string>("");
  const { data: vpsList } = useVpsList();

  const refVpsId = selectedVpsId || defaultVpsId || "";
  const refVps = (vpsList || []).find(v => v.id === refVpsId) ?? null;

  const allVpsIds = useMemo(() => (vpsList || []).map(v => v.id), [vpsList]);
  const [targetVpsIds, setTargetVpsIds] = useState<string[]>([]);
  // Di default applica a tutti i VPS finche' l'utente non restringe la selezione manualmente.
  const [targetTouched, setTargetTouched] = useState(false);
  useEffect(() => {
    if (!targetTouched) setTargetVpsIds(allVpsIds);
  }, [allVpsIds, targetTouched]);

  const handleTargetChange = (ids: string[]) => {
    setTargetTouched(true);
    setTargetVpsIds(ids);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-heading font-bold tracking-tight">Gestione Fail2ban</h1>
          <p className="text-muted-foreground text-sm">Scegli su quali VPS applicare le modifiche</p>
        </div>
        <div className="flex items-center gap-2">
          <VpsSelector value={refVpsId} onChange={setSelectedVpsId} />
          <VpsTargetSelector allVpsIds={allVpsIds} value={targetVpsIds} onChange={handleTargetChange} />
        </div>
      </div>
      <Tabs defaultValue="jails">
        <TabsList>
          <TabsTrigger value="jails">Jail</TabsTrigger>
          <TabsTrigger value="filters">Filtri</TabsTrigger>
          <TabsTrigger value="configs">Configurazioni</TabsTrigger>
        </TabsList>
        <TabsContent value="jails"><JailsTab refVps={refVps} targetVpsIds={targetVpsIds} /></TabsContent>
        <TabsContent value="filters"><FiltersTab refVps={refVps} targetVpsIds={targetVpsIds} /></TabsContent>
        <TabsContent value="configs"><ConfigsTab refVps={refVps} targetVpsIds={targetVpsIds} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ── Jails ──────────────────────────────────────────────────────────────────────

interface Jail { name: string; enabled: boolean; banTime: number; maxRetry: number; findTime: number; }

function JailsTab({ refVps, targetVpsIds }: { refVps: { id: string; name: string } | null; targetVpsIds: string[] }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<Jail | null>(null);
  const [search, setSearch] = useState("");

  const { data: jails, isLoading, refetch } = useQuery<Jail[]>({
    queryKey: ["proxy-jails", refVps?.id],
    queryFn: async () => { const r = await apiRequest("GET", `/api/vps/${refVps!.id}/proxy/api/fail2ban/jails`); return r.json(); },
    enabled: !!refVps,
    refetchInterval: 60000,
  });

  const saveMutation = useMutation({
    mutationFn: async ({ name, config }: { name: string; config: Partial<Jail> }) => {
      const r = await apiRequest("POST", "/api/vps/bulk/post", {
        vpsIds: targetVpsIds,
        path: `/api/fail2ban/jails/${name}`,
        body: { config },
      });
      return r.json() as Promise<BulkResult[]>;
    },
    onSuccess: (results, vars) => {
      const ok = results.filter(r => r.success).length;
      toast({
        title: ok === results.length ? `Jail ${vars.name} aggiornata su tutti i ${results.length} VPS selezionati` : `Aggiornata su ${ok}/${results.length} VPS`,
        variant: ok === results.length ? "default" : "destructive",
      });
      setEditing(null);
      refetch();
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  if (!refVps) return <div className="py-8 text-center text-muted-foreground mt-4">Nessun VPS online disponibile</div>;
  if (isLoading) return <LoadingState message="Caricamento jail..." />;

  return (
    <Card className="mt-4 border-card-border">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Jail Fail2ban</CardTitle>
            <CardDescription>Configura banTime, maxRetry e findTime su tutti i VPS</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()}><RefreshCw className="w-4 h-4 mr-1" />Aggiorna</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <RefVpsBanner name={refVps.name} count={targetVpsIds.length} />
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Cerca jail..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Ban Time (s)</TableHead>
                <TableHead>Max Retry</TableHead>
                <TableHead>Find Time (s)</TableHead>
                <TableHead className="text-right">Azioni</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(jails || []).filter(j => !search || j.name.toLowerCase().includes(search.toLowerCase())).length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">{search ? "Nessun risultato" : "Nessuna jail"}</TableCell></TableRow>
              ) : (jails || []).filter(j => !search || j.name.toLowerCase().includes(search.toLowerCase())).map(jail => (
                <TableRow key={jail.name}>
                  {editing?.name === jail.name ? (
                    <>
                      <TableCell className="font-mono font-semibold">{jail.name}</TableCell>
                      <TableCell>
                        <Input type="number" className="w-24 h-7 text-sm" value={editing.banTime}
                          onChange={e => setEditing({ ...editing, banTime: parseInt(e.target.value) || 0 })} />
                      </TableCell>
                      <TableCell>
                        <Input type="number" className="w-20 h-7 text-sm" value={editing.maxRetry}
                          onChange={e => setEditing({ ...editing, maxRetry: parseInt(e.target.value) || 0 })} />
                      </TableCell>
                      <TableCell>
                        <Input type="number" className="w-24 h-7 text-sm" value={editing.findTime}
                          onChange={e => setEditing({ ...editing, findTime: parseInt(e.target.value) || 0 })} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button size="sm" variant="outline" onClick={() => setEditing(null)}>Annulla</Button>
                          <Button size="sm" disabled={saveMutation.isPending || targetVpsIds.length === 0}
                            onClick={() => saveMutation.mutate({ name: editing.name, config: { banTime: editing.banTime, maxRetry: editing.maxRetry, findTime: editing.findTime } })}>
                            <Save className="w-3 h-3 mr-1" />{saveMutation.isPending ? "..." : "Salva"}
                          </Button>
                        </div>
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell className="font-mono font-semibold">{jail.name}</TableCell>
                      <TableCell>{jail.banTime}</TableCell>
                      <TableCell>{jail.maxRetry}</TableCell>
                      <TableCell>{jail.findTime}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" onClick={() => setEditing({ ...jail })}>Modifica</Button>
                      </TableCell>
                    </>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Filters ────────────────────────────────────────────────────────────────────

function FiltersTab({ refVps, targetVpsIds }: { refVps: { id: string; name: string } | null; targetVpsIds: string[] }) {
  const [selectedName, setSelectedName] = useState<string>("");
  const [content, setContent] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const saveMutation = useBulkPost(`/api/fail2ban/filters/${selectedName}`, targetVpsIds);

  const { data: filterNames, isLoading: loadingNames } = useQuery<string[]>({
    queryKey: ["proxy-filter-names", refVps?.id],
    queryFn: async () => { const r = await apiRequest("GET", `/api/vps/${refVps!.id}/proxy/api/fail2ban/filters`); return r.json(); },
    enabled: !!refVps,
  });

  useEffect(() => {
    if (filterNames && filterNames.length > 0 && !selectedName) {
      setSelectedName(filterNames[0]);
    }
  }, [filterNames]);

  const { data: filterData, isLoading: loadingContent } = useQuery<{ name: string; content: string; path: string }>({
    queryKey: ["proxy-filter-content", refVps?.id, selectedName],
    queryFn: async () => { const r = await apiRequest("GET", `/api/vps/${refVps!.id}/proxy/api/fail2ban/filters/${selectedName}`); return r.json(); },
    enabled: !!refVps && !!selectedName,
  });

  useEffect(() => {
    if (filterData) { setContent(filterData.content); setHasChanges(false); }
  }, [filterData]);

  const handleSave = () => {
    saveMutation.mutate({ content }, { onSuccess: () => setHasChanges(false) });
  };

  if (!refVps) return <div className="py-8 text-center text-muted-foreground mt-4">Nessun VPS online disponibile</div>;
  if (loadingNames) return <LoadingState message="Caricamento filtri..." />;

  return (
    <Card className="mt-4 border-card-border">
      <CardHeader>
        <CardTitle>Filtri Fail2ban</CardTitle>
        <CardDescription>Modifica i file filter.d — le modifiche vengono propagate ai VPS selezionati</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <RefVpsBanner name={refVps.name} count={targetVpsIds.length} />
        <div className="flex items-center gap-2">
          <Select value={selectedName} onValueChange={v => { if (hasChanges && !confirm("Modifiche non salvate. Continuare?")) return; setSelectedName(v); }}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Seleziona filtro..." />
            </SelectTrigger>
            <SelectContent>
              {(filterNames || []).map(name => (
                <SelectItem key={name} value={name}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filterData && <span className="text-xs font-mono text-muted-foreground">{filterData.path}</span>}
        </div>
        {loadingContent ? <LoadingState message="Caricamento..." /> : (
          <>
            <Textarea
              value={content}
              onChange={e => { setContent(e.target.value); setHasChanges(true); }}
              className="font-mono text-xs min-h-[28rem]"
              placeholder="# Contenuto filtro fail2ban..."
            />
            <div className="flex items-center justify-between">
              {hasChanges && <Badge variant="secondary">Modifiche non salvate</Badge>}
              <div className="flex gap-2 ml-auto">
                <Button variant="outline" disabled={!hasChanges} onClick={() => { setContent(filterData?.content ?? ""); setHasChanges(false); }}>Ripristina</Button>
                <Button disabled={!hasChanges || targetVpsIds.length === 0 || saveMutation.isPending} onClick={handleSave}>
                  <Save className="w-4 h-4 mr-1" />{saveMutation.isPending ? "Salvataggio..." : `Salva su ${targetVpsIds.length} VPS`}
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Config files ───────────────────────────────────────────────────────────────

const FAIL2BAN_CONFIGS = ["jail.local", "fail2ban.local"] as const;
type F2BConfig = typeof FAIL2BAN_CONFIGS[number];

function ConfigsTab({ refVps, targetVpsIds }: { refVps: { id: string; name: string } | null; targetVpsIds: string[] }) {
  const [activeConfig, setActiveConfig] = useState<F2BConfig>("jail.local");
  const [content, setContent] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const saveMutation = useBulkPost(`/api/config/${activeConfig}`, targetVpsIds);

  const { data: configData, isLoading } = useQuery<{ filename: string; content: string; path: string }>({
    queryKey: ["proxy-f2b-config", refVps?.id, activeConfig],
    queryFn: async () => { const r = await apiRequest("GET", `/api/vps/${refVps!.id}/proxy/api/config/${activeConfig}`); return r.json(); },
    enabled: !!refVps,
  });

  useEffect(() => {
    if (configData) { setContent(configData.content); setHasChanges(false); }
  }, [configData]);

  const switchConfig = (cfg: F2BConfig) => {
    if (hasChanges && !confirm("Modifiche non salvate. Continuare?")) return;
    setActiveConfig(cfg);
  };

  const handleSave = () => {
    saveMutation.mutate({ content }, { onSuccess: () => setHasChanges(false) });
  };

  if (!refVps) return <div className="py-8 text-center text-muted-foreground mt-4">Nessun VPS online disponibile</div>;
  if (isLoading) return <LoadingState message="Caricamento configurazione..." />;

  return (
    <Card className="mt-4 border-card-border">
      <CardHeader>
        <CardTitle>File di Configurazione</CardTitle>
        <CardDescription>Modifica jail.local e fail2ban.local — le modifiche vengono applicate ai VPS selezionati</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <RefVpsBanner name={refVps.name} count={targetVpsIds.length} />
        <div className="flex gap-2">
          {FAIL2BAN_CONFIGS.map(cfg => (
            <Button key={cfg} variant={activeConfig === cfg ? "default" : "outline"} size="sm" onClick={() => switchConfig(cfg)}>
              {cfg}
            </Button>
          ))}
          {configData && <span className="text-xs font-mono text-muted-foreground self-center ml-2">{configData.path}</span>}
        </div>
        <Textarea
          value={content}
          onChange={e => { setContent(e.target.value); setHasChanges(true); }}
          className="font-mono text-xs min-h-[32rem]"
          placeholder="# Configurazione fail2ban..."
        />
        <div className="flex items-center justify-between">
          {hasChanges && <Badge variant="secondary">Modifiche non salvate</Badge>}
          <div className="flex gap-2 ml-auto">
            <Button variant="outline" disabled={!hasChanges} onClick={() => { setContent(configData?.content ?? ""); setHasChanges(false); }}>Ripristina</Button>
            <Button disabled={!hasChanges || targetVpsIds.length === 0 || saveMutation.isPending} onClick={handleSave}>
              <Save className="w-4 h-4 mr-1" />{saveMutation.isPending ? "Salvataggio..." : `Salva su ${targetVpsIds.length} VPS`}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
