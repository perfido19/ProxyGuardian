import React, { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useVpsList, useVpsHealth } from "@/hooks/use-vps";
import { apiRequest } from "@/lib/queryClient";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Save, Trash2, Wifi, Search, RefreshCw, ShieldAlert, ShieldCheck, ShieldOff, Eye, FileText, Download } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { LoadingState } from "@/components/loading-state";

interface BulkResult { vpsId: string; vpsName: string; success: boolean; error?: string; }
interface Vps { id: string; name: string; }

function useDefaultVpsId() {
  const { data: vpsList } = useVpsList();
  const { data: healthMap } = useVpsHealth();
  return vpsList?.find(v => healthMap?.[v.id])?.id ?? null;
}

function useSaveConfig(filename: string, vpsId: string) {
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (content: string) => {
      if (vpsId === "all") {
        const r = await apiRequest("POST", "/api/vps/bulk/post", { vpsIds: "all", path: `/api/config/${filename}`, body: { content } });
        return r.json() as Promise<BulkResult[]>;
      } else {
        const r = await apiRequest("POST", `/api/vps/${vpsId}/proxy/api/config/${filename}`, { content });
        const data = await r.json();
        return [{ vpsId, vpsName: vpsId, success: true, data }] as BulkResult[];
      }
    },
    onSuccess: (results) => {
      const ok = results.filter(r => r.success).length;
      toast({
        title: vpsId === "all"
          ? (ok === results.length ? "Salvato su tutti i VPS" : `Salvato su ${ok}/${results.length} VPS`)
          : "Salvato sul VPS selezionato",
        description: filename,
        variant: ok > 0 ? "default" : "destructive",
      });
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });
}

function VpsBanner({ refVps, saveTarget, totalCount }: { refVps: Vps; saveTarget: string; totalCount: number }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 border border-border rounded-md px-3 py-2 mb-4">
      <Wifi className="w-3.5 h-3.5 text-green-500" />
      <span>Lettura da: <strong className="text-foreground">{refVps.name}</strong></span>
      <span className="ml-auto">
        Salva su: <strong className="text-foreground">{saveTarget === "all" ? `tutti i ${totalCount} VPS` : refVps.name}</strong>
      </span>
    </div>
  );
}

function VpsSelector({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { data: vpsList } = useVpsList();
  const { data: healthMap } = useVpsHealth();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-44 h-8 text-sm">
        <SelectValue placeholder="Seleziona VPS" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">Tutti i VPS</SelectItem>
        {(vpsList || []).filter(v => healthMap?.[v.id]).map(v => (
          <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
        ))}
        {(vpsList || []).filter(v => !healthMap?.[v.id]).map(v => (
          <SelectItem key={v.id} value={v.id} disabled>{v.name} (offline)</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function Firewall() {
  const defaultVpsId = useDefaultVpsId();
  const [selectedVps, setSelectedVps] = useState("all");
  const { data: vpsList } = useVpsList();
  const { data: healthMap } = useVpsHealth();

  const refVpsId = selectedVps === "all"
    ? (defaultVpsId ?? "")
    : selectedVps;
  const refVps = (vpsList || []).find(v => v.id === refVpsId) ?? null;
  const totalCount = (vpsList || []).length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-heading font-bold tracking-tight">Regole Firewall</h1>
          <p className="text-muted-foreground text-sm">Lettura e salvataggio configurabile per VPS singolo o tutti</p>
        </div>
        <VpsSelector value={selectedVps} onChange={setSelectedVps} />
      </div>
      <Tabs defaultValue="countries">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="countries">Paesi</TabsTrigger>
          <TabsTrigger value="asn">ASN</TabsTrigger>
          <TabsTrigger value="isp">ISP</TabsTrigger>
          <TabsTrigger value="useragent">User-Agent</TabsTrigger>
          <TabsTrigger value="baduseragent">Bad User-Agent</TabsTrigger>
          <TabsTrigger value="ip">IP Whitelist</TabsTrigger>
          <TabsTrigger value="exclusion">IP Exclusion</TabsTrigger>
          <TabsTrigger value="iptables">IPTables Banned</TabsTrigger>
          <TabsTrigger value="modsec">ModSecurity</TabsTrigger>
        </TabsList>
        <TabsContent value="countries"><CountriesTab refVps={refVps} saveTarget={selectedVps} totalCount={totalCount} /></TabsContent>
        <TabsContent value="asn"><AsnTab refVps={refVps} saveTarget={selectedVps} totalCount={totalCount} /></TabsContent>
        <TabsContent value="isp"><IspTab refVps={refVps} saveTarget={selectedVps} totalCount={totalCount} /></TabsContent>
        <TabsContent value="useragent"><UserAgentTab refVps={refVps} saveTarget={selectedVps} totalCount={totalCount} /></TabsContent>
        <TabsContent value="baduseragent"><BadUserAgentTab refVps={refVps} saveTarget={selectedVps} totalCount={totalCount} /></TabsContent>
        <TabsContent value="ip"><IpWhitelistTab refVps={refVps} saveTarget={selectedVps} totalCount={totalCount} /></TabsContent>
        <TabsContent value="exclusion"><ExclusionIpTab refVps={refVps} saveTarget={selectedVps} totalCount={totalCount} /></TabsContent>
        <TabsContent value="iptables"><IpTablesSearchTab /></TabsContent>
        <TabsContent value="modsec"><ModSecTab refVps={refVps} saveTarget={selectedVps} totalCount={totalCount} /></TabsContent>
      </Tabs>
    </div>
  );
}

interface TabProps { refVps: Vps | null; saveTarget: string; totalCount: number; }

// ── Countries ──────────────────────────────────────────────────────────────────

function CountriesTab({ refVps, saveTarget, totalCount }: TabProps) {
  const [countries, setCountries] = useState<string[]>([]);
  const [newCountry, setNewCountry] = useState("");
  const [search, setSearch] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const saveMutation = useSaveConfig("country_whitelist.conf", saveTarget);

  const { data: configData, isLoading } = useQuery<{ content: string }>({
    queryKey: ["proxy-config-country_whitelist", refVps?.id],
    queryFn: async () => { const r = await apiRequest("GET", `/api/vps/${refVps!.id}/proxy/api/config/country_whitelist.conf`); return r.json(); },
    enabled: !!refVps,
  });

  useEffect(() => {
    if (configData) {
      const lines = configData.content.split("\n").filter(l => !l.trim().startsWith("#") && l.includes("yes")).map(l => l.split(/\s+/)[0]).filter(Boolean);
      setCountries(lines); setHasChanges(false);
    }
  }, [configData]);

  const addCountry = () => {
    if (newCountry.length === 2 && !countries.includes(newCountry)) {
      setCountries([...countries, newCountry]); setNewCountry(""); setHasChanges(true);
    }
  };

  const handleSave = () => {
    const content = countries.map(c => `${c} yes;`).join("\n") + "\n";
    saveMutation.mutate(content, { onSuccess: () => setHasChanges(false) });
  };

  const filtered = search ? countries.filter(c => c.toLowerCase().includes(search.toLowerCase())) : countries;

  if (!refVps) return <div className="py-8 text-center text-muted-foreground">Nessun VPS online disponibile</div>;
  if (isLoading) return <LoadingState message="Caricamento..." />;

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Whitelist Paesi</CardTitle>
        <CardDescription>Codici ISO 3166-1 alpha-2 (es. IT, DE, FR)</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <VpsBanner refVps={refVps} saveTarget={saveTarget} totalCount={totalCount} />
        <div className="flex gap-2">
          <Input placeholder="Codice paese (es. IT)" value={newCountry} onChange={e => setNewCountry(e.target.value.toUpperCase())} maxLength={2} onKeyDown={e => e.key === "Enter" && addCountry()} />
          <Button onClick={addCountry}><Plus className="w-4 h-4 mr-1" />Aggiungi</Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Cerca paese..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        {search && <p className="text-xs text-muted-foreground">{filtered.length} / {countries.length} risultati</p>}
        <div className="border rounded-md">
          <Table>
            <TableHeader><TableRow><TableHead>Codice</TableHead><TableHead>Stato</TableHead><TableHead className="text-right">Azioni</TableHead></TableRow></TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={3} className="text-center py-6 text-muted-foreground">{search ? "Nessun risultato" : "Nessun paese configurato"}</TableCell></TableRow>
              ) : filtered.map(code => (
                <TableRow key={code}>
                  <TableCell className="font-mono font-semibold">{code}</TableCell>
                  <TableCell><Badge variant="secondary">Consentito</Badge></TableCell>
                  <TableCell className="text-right"><Button variant="ghost" size="icon" onClick={() => { setCountries(countries.filter(c => c !== code)); setHasChanges(true); }}><Trash2 className="w-4 h-4 text-destructive" /></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={!hasChanges || saveMutation.isPending}>
            <Save className="w-4 h-4 mr-1" />{saveMutation.isPending ? "Salvataggio..." : saveTarget === "all" ? "Salva su tutti i VPS" : "Salva su questo VPS"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── ASN ────────────────────────────────────────────────────────────────────────

function AsnTab({ refVps }: TabProps) {
  const { toast } = useToast();
  const [asns, setAsns] = useState<Array<{ asn: string; description?: string }>>([]);
  const [newAsn, setNewAsn] = useState(""); const [newDesc, setNewDesc] = useState("");
  const [search, setSearch] = useState("");
  const [hasChanges, setHasChanges] = useState(false);

  const { data: fleetData } = useQuery<{ content: string }>({
    queryKey: ["fleet-asn-blocklist"],
    queryFn: async () => { const r = await apiRequest("GET", "/api/fleet/asn/blocklist"); return r.json(); },
  });

  const saveMutation = useMutation({
    mutationFn: async (content: string) => {
      const r = await apiRequest("POST", "/api/fleet/asn/blocklist", { content });
      return r.json();
    },
    onSuccess: (data) => {
      const ok = (data.syncResults || []).filter((r: BulkResult) => r.success).length;
      const tot = (data.syncResults || []).length;
      toast({ title: "Fleet ASN salvato", description: `Sincronizzato su ${ok}/${tot} VPS + repo` });
      setHasChanges(false);
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  // Formato AsnBlock: "AS12345 # Descrizione"
  function parseAsnList(content: string): Array<{ asn: string; description?: string }> {
    return content.split("\n").map(line => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return null;
      const commentIdx = t.indexOf("#");
      const asn = (commentIdx >= 0 ? t.slice(0, commentIdx) : t).trim().toUpperCase();
      if (!/^AS\d+$/.test(asn)) return null;
      const description = commentIdx >= 0 ? t.slice(commentIdx + 1).trim() : undefined;
      return { asn, description };
    }).filter(Boolean) as Array<{ asn: string; description?: string }>;
  }

  function serializeAsnList(list: Array<{ asn: string; description?: string }>): string {
    return list.map(({ asn, description }) => description ? `${asn} # ${description}` : asn).join("\n") + "\n";
  }

  useEffect(() => {
    if (fleetData) { setAsns(parseAsnList(fleetData.content)); setHasChanges(false); }
  }, [fleetData]);

  const addAsn = () => {
    const normalized = newAsn.trim().toUpperCase().startsWith("AS") ? newAsn.trim().toUpperCase() : `AS${newAsn.trim()}`;
    if (normalized && !asns.find(a => a.asn === normalized)) {
      setAsns([...asns, { asn: normalized, description: newDesc || undefined }]);
      setNewAsn(""); setNewDesc(""); setHasChanges(true);
    }
  };

  const handleSave = () => { saveMutation.mutate(serializeAsnList(asns)); };

  const handleImportFromVps = async () => {
    if (!refVps) return;
    try {
      const r = await apiRequest("GET", `/api/fleet/asn/blocklist/import/${refVps.id}`);
      const data = await r.json();
      if (data.content) {
        const parsed = parseAsnList(data.content);
        setAsns(parsed); setHasChanges(true);
        toast({ title: "Importato", description: `${parsed.length} ASN da ${refVps.name}` });
      }
    } catch (e: any) { toast({ title: "Errore", description: e.message, variant: "destructive" }); }
  };

  const handleSyncGithub = async () => {
    try {
      const r = await apiRequest("POST", "/api/fleet/asn/sync-github");
      const data = await r.json();
      const ok = (data.results || []).filter((r: BulkResult) => r.success).length;
      toast({ title: "Sync GitHub completato", description: `${ok}/${(data.results || []).length} VPS aggiornati da AsnBlock repo` });
    } catch (e: any) { toast({ title: "Errore sync", description: e.message, variant: "destructive" }); }
  };

  const filtered = search
    ? asns.filter(a => a.asn.includes(search) || (a.description ?? "").toLowerCase().includes(search.toLowerCase()))
    : asns;

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Fleet Blacklist ASN</CardTitle>
              <CardDescription>Blocco iptables/ipset via AsnBlock • salvato nella repo • "Sync da AsnBlock repo" scarica la lista da GitHub</CardDescription>
            </div>
            <div className="flex gap-2">
              {refVps && (
                <Button variant="outline" size="sm" onClick={handleImportFromVps}>
                  <Download className="w-4 h-4 mr-1" />Importa da {refVps.name}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={handleSyncGithub}>
                <RefreshCw className="w-4 h-4 mr-1" />Sync da AsnBlock repo
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <Input placeholder="ASN (es. AS15169 o 15169)" value={newAsn} onChange={e => setNewAsn(e.target.value)} onKeyDown={e => e.key === "Enter" && addAsn()} />
            <Input placeholder="Descrizione (opzionale)" value={newDesc} onChange={e => setNewDesc(e.target.value)} />
            <Button onClick={addAsn}><Plus className="w-4 h-4 mr-1" />Aggiungi</Button>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Cerca ASN o descrizione..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
          </div>
          {search && <p className="text-xs text-muted-foreground">{filtered.length} / {asns.length} risultati</p>}
          <div className="border rounded-md">
            <Table>
              <TableHeader><TableRow><TableHead>ASN</TableHead><TableHead>Descrizione</TableHead><TableHead>Stato</TableHead><TableHead className="text-right">Azioni</TableHead></TableRow></TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="text-center py-6 text-muted-foreground">{search ? "Nessun risultato" : "Nessun ASN bloccato"}</TableCell></TableRow>
                ) : filtered.map(({ asn, description }) => (
                  <TableRow key={asn}>
                    <TableCell className="font-mono font-semibold">{asn}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{description || "—"}</TableCell>
                    <TableCell><Badge variant="destructive">Bloccato</Badge></TableCell>
                    <TableCell className="text-right"><Button variant="ghost" size="icon" onClick={() => { setAsns(asns.filter(a => a.asn !== asn)); setHasChanges(true); }}><Trash2 className="w-4 h-4 text-destructive" /></Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">{asns.length} ASN bloccati</p>
            <Button onClick={handleSave} disabled={!hasChanges || saveMutation.isPending}>
              <Save className="w-4 h-4 mr-1" />{saveMutation.isPending ? "Sincronizzazione..." : "Salva su repo + tutti i VPS"}
            </Button>
          </div>
        </CardContent>
      </Card>
      <AsnWhitelistCard />
    </div>
  );
}

function AsnWhitelistCard() {
  const { toast } = useToast();
  const [content, setContent] = useState("");
  const [hasChanges, setHasChanges] = useState(false);

  const { data } = useQuery<{ content: string }>({
    queryKey: ["fleet-asn-whitelist"],
    queryFn: async () => { const r = await apiRequest("GET", "/api/fleet/asn/whitelist"); return r.json(); },
  });

  useEffect(() => {
    if (data) { setContent(data.content); setHasChanges(false); }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async (c: string) => { const r = await apiRequest("POST", "/api/fleet/asn/whitelist", { content: c }); return r.json(); },
    onSuccess: (data) => {
      const ok = (data.syncResults || []).filter((r: BulkResult) => r.success).length;
      const tot = (data.syncResults || []).length;
      toast({ title: "Whitelist ASN salvata", description: `Sincronizzata su ${ok}/${tot} VPS + repo` });
      setHasChanges(false);
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Fleet Whitelist ASN</CardTitle>
        <CardDescription>CIDR e domini esclusi dal blocco • un valore per riga • sincronizzato nella repo</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Textarea
          value={content}
          onChange={e => { setContent(e.target.value); setHasChanges(true); }}
          className="font-mono text-sm min-h-48"
          placeholder={"# Esempio:\n192.168.0.0/16 # rete interna\ndomain.example.com # provider fidato"}
        />
        <div className="flex justify-end">
          <Button onClick={() => saveMutation.mutate(content)} disabled={!hasChanges || saveMutation.isPending}>
            <Save className="w-4 h-4 mr-1" />{saveMutation.isPending ? "Sincronizzazione..." : "Salva su repo + tutti i VPS"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── ISP ────────────────────────────────────────────────────────────────────────

function IspTab({ refVps, saveTarget, totalCount }: TabProps) {
  const [isps, setIsps] = useState<Array<{ name: string; type: string }>>([]);
  const [newIsp, setNewIsp] = useState(""); const [matchType, setMatchType] = useState<"exact" | "partial">("partial");
  const [search, setSearch] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const saveMutation = useSaveConfig("block_isp.conf", saveTarget);

  const { data: configData, isLoading } = useQuery<{ content: string }>({
    queryKey: ["proxy-config-block_isp", refVps?.id],
    queryFn: async () => { const r = await apiRequest("GET", `/api/vps/${refVps!.id}/proxy/api/config/block_isp.conf`); return r.json(); },
    enabled: !!refVps,
  });

  useEffect(() => {
    if (configData) {
      const parsed = configData.content.split("\n").map(line => {
        const t = line.trim();
        if (t.startsWith("#") || !t) return null;
        const m = t.match(/^"([^"]+)"\s+\S+;/);
        if (!m) return null;
        const raw = m[1];
        const isPartial = raw.startsWith("~*");
        return { name: isPartial ? raw.slice(2) : raw, type: isPartial ? "partial" : "exact" };
      }).filter(Boolean) as any[];
      setIsps(parsed); setHasChanges(false);
    }
  }, [configData]);

  const addIsp = () => {
    if (newIsp && !isps.find(i => i.name === newIsp)) {
      setIsps([...isps, { name: newIsp, type: matchType }]); setNewIsp(""); setHasChanges(true);
    }
  };

  const handleSave = () => {
    const content = isps.map(({ name, type }) => type === "partial" ? `"~*${name}" 1;` : `"${name}" 1;`).join("\n") + "\n";
    saveMutation.mutate(content, { onSuccess: () => setHasChanges(false) });
  };

  const filtered = search ? isps.filter(i => i.name.toLowerCase().includes(search.toLowerCase())) : isps;

  if (!refVps) return <div className="py-8 text-center text-muted-foreground">Nessun VPS online disponibile</div>;
  if (isLoading) return <LoadingState message="Caricamento..." />;

  return (
    <Card className="mt-4">
      <CardHeader><CardTitle>Blacklist ISP</CardTitle><CardDescription>Blocca provider internet per nome</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <VpsBanner refVps={refVps} saveTarget={saveTarget} totalCount={totalCount} />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <Input placeholder="Nome ISP" value={newIsp} onChange={e => setNewIsp(e.target.value)} className="md:col-span-2" />
          <Select value={matchType} onValueChange={v => setMatchType(v as any)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="exact">Esatto</SelectItem><SelectItem value="partial">Parziale</SelectItem></SelectContent></Select>
          <Button onClick={addIsp}><Plus className="w-4 h-4 mr-1" />Aggiungi</Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Cerca ISP..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        {search && <p className="text-xs text-muted-foreground">{filtered.length} / {isps.length} risultati</p>}
        <div className="border rounded-md">
          <Table>
            <TableHeader><TableRow><TableHead>ISP</TableHead><TableHead>Tipo</TableHead><TableHead>Stato</TableHead><TableHead className="text-right">Azioni</TableHead></TableRow></TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="text-center py-6 text-muted-foreground">{search ? "Nessun risultato" : "Nessun ISP bloccato"}</TableCell></TableRow>
              ) : filtered.map(({ name, type }) => (
                <TableRow key={name}>
                  <TableCell className="font-mono">{name}</TableCell>
                  <TableCell><Badge variant="outline">{type === "exact" ? "Esatto" : "Parziale"}</Badge></TableCell>
                  <TableCell><Badge variant="destructive">Bloccato</Badge></TableCell>
                  <TableCell className="text-right"><Button variant="ghost" size="icon" onClick={() => { setIsps(isps.filter(i => i.name !== name)); setHasChanges(true); }}><Trash2 className="w-4 h-4 text-destructive" /></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={!hasChanges || saveMutation.isPending}>
            <Save className="w-4 h-4 mr-1" />{saveMutation.isPending ? "Salvataggio..." : saveTarget === "all" ? "Salva su tutti i VPS" : "Salva su questo VPS"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── User-Agent ─────────────────────────────────────────────────────────────────

function UserAgentTab({ refVps, saveTarget, totalCount }: TabProps) {
  const [patterns, setPatterns] = useState<string[]>([]);
  const [newPattern, setNewPattern] = useState("");
  const [search, setSearch] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const saveMutation = useSaveConfig("useragent.rules", saveTarget);

  const { data: configData, isLoading } = useQuery<{ content: string }>({
    queryKey: ["proxy-config-useragent", refVps?.id],
    queryFn: async () => { const r = await apiRequest("GET", `/api/vps/${refVps!.id}/proxy/api/config/useragent.rules`); return r.json(); },
    enabled: !!refVps,
  });

  useEffect(() => {
    if (configData) {
      const parsed = configData.content.split("\n").map(line => {
        const t = line.trim();
        if (t.startsWith("#") || !t) return null;
        const m = t.match(/^~?\*?(.+?)\s+\S+;/);
        return m ? m[1].trim() : null;
      }).filter(Boolean) as string[];
      setPatterns(parsed); setHasChanges(false);
    }
  }, [configData]);

  const addPattern = () => {
    if (newPattern && !patterns.includes(newPattern)) {
      setPatterns([...patterns, newPattern]); setNewPattern(""); setHasChanges(true);
    }
  };

  const handleSave = () => {
    const content = patterns.map(p => `~*${p} 1;`).join("\n") + "\n";
    saveMutation.mutate(content, { onSuccess: () => setHasChanges(false) });
  };

  const filtered = search ? patterns.filter(p => p.toLowerCase().includes(search.toLowerCase())) : patterns;

  if (!refVps) return <div className="py-8 text-center text-muted-foreground">Nessun VPS online disponibile</div>;
  if (isLoading) return <LoadingState message="Caricamento..." />;

  return (
    <Card className="mt-4">
      <CardHeader><CardTitle>Blacklist User-Agent</CardTitle><CardDescription>Blocca ISP per pattern regex — file: useragent.rules</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <VpsBanner refVps={refVps} saveTarget={saveTarget} totalCount={totalCount} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Input placeholder="Pattern (es. bot|crawler)" className="md:col-span-2" value={newPattern} onChange={e => setNewPattern(e.target.value)} onKeyDown={e => e.key === "Enter" && addPattern()} />
          <Button onClick={addPattern}><Plus className="w-4 h-4 mr-1" />Aggiungi</Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Cerca pattern..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        {search && <p className="text-xs text-muted-foreground">{filtered.length} / {patterns.length} risultati</p>}
        <div className="border rounded-md">
          <Table>
            <TableHeader><TableRow><TableHead>Pattern</TableHead><TableHead>Stato</TableHead><TableHead className="text-right">Azioni</TableHead></TableRow></TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={3} className="text-center py-6 text-muted-foreground">{search ? "Nessun risultato" : "Nessun pattern configurato"}</TableCell></TableRow>
              ) : filtered.map(pattern => (
                <TableRow key={pattern}>
                  <TableCell className="font-mono text-sm">{pattern}</TableCell>
                  <TableCell><Badge variant="destructive">Bloccato</Badge></TableCell>
                  <TableCell className="text-right"><Button variant="ghost" size="icon" onClick={() => { setPatterns(patterns.filter(p => p !== pattern)); setHasChanges(true); }}><Trash2 className="w-4 h-4 text-destructive" /></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={!hasChanges || saveMutation.isPending}>
            <Save className="w-4 h-4 mr-1" />{saveMutation.isPending ? "Salvataggio..." : saveTarget === "all" ? "Salva su tutti i VPS" : "Salva su questo VPS"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Bad User-Agent ─────────────────────────────────────────────────────────────

function BadUserAgentTab({ refVps, saveTarget, totalCount }: TabProps) {
  const [patterns, setPatterns] = useState<string[]>([]);
  const [newPattern, setNewPattern] = useState("");
  const [search, setSearch] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const saveMutation = useSaveConfig("block_baduseragents.conf", saveTarget);

  const { data: configData, isLoading } = useQuery<{ content: string }>({
    queryKey: ["proxy-config-block_baduseragents", refVps?.id],
    queryFn: async () => { const r = await apiRequest("GET", `/api/vps/${refVps!.id}/proxy/api/config/block_baduseragents.conf`); return r.json(); },
    enabled: !!refVps,
  });

  useEffect(() => {
    if (configData) {
      const parsed = configData.content.split("\n").map(line => {
        const t = line.trim();
        if (t.startsWith("#") || !t) return null;
        const m = t.match(/^~?\*?(.+?)\s+\S+;/);
        return m ? m[1].trim() : null;
      }).filter(Boolean) as string[];
      setPatterns(parsed); setHasChanges(false);
    }
  }, [configData]);

  const addPattern = () => {
    if (newPattern && !patterns.includes(newPattern)) {
      setPatterns([...patterns, newPattern]); setNewPattern(""); setHasChanges(true);
    }
  };

  const handleSave = () => {
    const content = patterns.map(p => `~*${p} 1;`).join("\n") + "\n";
    saveMutation.mutate(content, { onSuccess: () => setHasChanges(false) });
  };

  const filtered = search ? patterns.filter(p => p.toLowerCase().includes(search.toLowerCase())) : patterns;

  if (!refVps) return <div className="py-8 text-center text-muted-foreground">Nessun VPS online disponibile</div>;
  if (isLoading) return <LoadingState message="Caricamento..." />;

  return (
    <Card className="mt-4">
      <CardHeader><CardTitle>Bad User-Agent</CardTitle><CardDescription>Blocca specifici user agent — file: block_baduseragents.conf</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <VpsBanner refVps={refVps} saveTarget={saveTarget} totalCount={totalCount} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Input placeholder="Pattern (es. python-requests|curl)" className="md:col-span-2" value={newPattern} onChange={e => setNewPattern(e.target.value)} onKeyDown={e => e.key === "Enter" && addPattern()} />
          <Button onClick={addPattern}><Plus className="w-4 h-4 mr-1" />Aggiungi</Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Cerca pattern..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        {search && <p className="text-xs text-muted-foreground">{filtered.length} / {patterns.length} risultati</p>}
        <div className="border rounded-md">
          <Table>
            <TableHeader><TableRow><TableHead>Pattern</TableHead><TableHead>Stato</TableHead><TableHead className="text-right">Azioni</TableHead></TableRow></TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={3} className="text-center py-6 text-muted-foreground">{search ? "Nessun risultato" : "Nessun pattern configurato"}</TableCell></TableRow>
              ) : filtered.map(pattern => (
                <TableRow key={pattern}>
                  <TableCell className="font-mono text-sm">{pattern}</TableCell>
                  <TableCell><Badge variant="destructive">Bloccato</Badge></TableCell>
                  <TableCell className="text-right"><Button variant="ghost" size="icon" onClick={() => { setPatterns(patterns.filter(p => p !== pattern)); setHasChanges(true); }}><Trash2 className="w-4 h-4 text-destructive" /></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={!hasChanges || saveMutation.isPending}>
            <Save className="w-4 h-4 mr-1" />{saveMutation.isPending ? "Salvataggio..." : saveTarget === "all" ? "Salva su tutti i VPS" : "Salva su questo VPS"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── IP Whitelist ───────────────────────────────────────────────────────────────

function IpWhitelistTab({ refVps, saveTarget, totalCount }: TabProps) {
  const [ips, setIps] = useState<string[]>([]);
  const [newIp, setNewIp] = useState("");
  const [search, setSearch] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const saveMutation = useSaveConfig("ip_whitelist.conf", saveTarget);

  const { data: configData, isLoading } = useQuery<{ content: string }>({
    queryKey: ["proxy-config-ip_whitelist", refVps?.id],
    queryFn: async () => { const r = await apiRequest("GET", `/api/vps/${refVps!.id}/proxy/api/config/ip_whitelist.conf`); return r.json(); },
    enabled: !!refVps,
  });

  useEffect(() => {
    if (configData) {
      const parsed = configData.content.split("\n").map(l => {
        const t = l.trim();
        if (t.startsWith("#") || !t) return null;
        return t.split(/\s+/)[0];
      }).filter(Boolean) as string[];
      setIps(parsed); setHasChanges(false);
    }
  }, [configData]);

  const addIp = () => {
    if (newIp && !ips.includes(newIp)) { setIps([...ips, newIp]); setNewIp(""); setHasChanges(true); }
  };

  const handleSave = () => {
    const content = ips.map(ip => `${ip} 0;`).join("\n") + "\n";
    saveMutation.mutate(content, { onSuccess: () => setHasChanges(false) });
  };

  const filtered = search ? ips.filter(ip => ip.includes(search)) : ips;

  if (!refVps) return <div className="py-8 text-center text-muted-foreground">Nessun VPS online disponibile</div>;
  if (isLoading) return <LoadingState message="Caricamento..." />;

  return (
    <Card className="mt-4">
      <CardHeader><CardTitle>IP Whitelist</CardTitle><CardDescription>IP esclusi dal rate limiting (singoli o CIDR)</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <VpsBanner refVps={refVps} saveTarget={saveTarget} totalCount={totalCount} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Input placeholder="IP o Range (es. 10.0.0.0/24)" className="md:col-span-2" value={newIp} onChange={e => setNewIp(e.target.value)} onKeyDown={e => e.key === "Enter" && addIp()} />
          <Button onClick={addIp}><Plus className="w-4 h-4 mr-1" />Aggiungi</Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Cerca IP o range..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 font-mono" />
        </div>
        {search && <p className="text-xs text-muted-foreground">{filtered.length} / {ips.length} risultati</p>}
        <div className="border rounded-md">
          <Table>
            <TableHeader><TableRow><TableHead>IP / Range</TableHead><TableHead>Stato</TableHead><TableHead className="text-right">Azioni</TableHead></TableRow></TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={3} className="text-center py-6 text-muted-foreground">{search ? "Nessun risultato" : "Nessun IP in whitelist"}</TableCell></TableRow>
              ) : filtered.map(ip => (
                <TableRow key={ip}>
                  <TableCell className="font-mono">{ip}</TableCell>
                  <TableCell><Badge variant="secondary">Escluso</Badge></TableCell>
                  <TableCell className="text-right"><Button variant="ghost" size="icon" onClick={() => { setIps(ips.filter(i => i !== ip)); setHasChanges(true); }}><Trash2 className="w-4 h-4 text-destructive" /></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={!hasChanges || saveMutation.isPending}>
            <Save className="w-4 h-4 mr-1" />{saveMutation.isPending ? "Salvataggio..." : saveTarget === "all" ? "Salva su tutti i VPS" : "Salva su questo VPS"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── IP Exclusion ───────────────────────────────────────────────────────────────

function ExclusionIpTab({ refVps, saveTarget, totalCount }: TabProps) {
  const [ips, setIps] = useState<string[]>([]);
  const [newIp, setNewIp] = useState("");
  const [search, setSearch] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const saveMutation = useSaveConfig("exclusion_ip.conf", saveTarget);

  const { data: configData, isLoading } = useQuery<{ content: string }>({
    queryKey: ["proxy-config-exclusion_ip", refVps?.id],
    queryFn: async () => { const r = await apiRequest("GET", `/api/vps/${refVps!.id}/proxy/api/config/exclusion_ip.conf`); return r.json(); },
    enabled: !!refVps,
  });

  useEffect(() => {
    if (configData) {
      const parsed = configData.content.split("\n").map(l => {
        const t = l.trim();
        if (t.startsWith("#") || !t) return null;
        return t.split(/\s+/)[0];
      }).filter(Boolean) as string[];
      setIps(parsed); setHasChanges(false);
    }
  }, [configData]);

  const addIp = () => {
    if (newIp && !ips.includes(newIp)) { setIps([...ips, newIp]); setNewIp(""); setHasChanges(true); }
  };

  const handleSave = () => {
    const content = ips.map(ip => `${ip} 1;`).join("\n") + "\n";
    saveMutation.mutate(content, { onSuccess: () => setHasChanges(false) });
  };

  const filtered = search ? ips.filter(ip => ip.includes(search)) : ips;

  if (!refVps) return <div className="py-8 text-center text-muted-foreground">Nessun VPS online disponibile</div>;
  if (isLoading) return <LoadingState message="Caricamento..." />;

  return (
    <Card className="mt-4">
      <CardHeader><CardTitle>IP Exclusion</CardTitle><CardDescription>IP esclusi dal blocco geografico</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <VpsBanner refVps={refVps} saveTarget={saveTarget} totalCount={totalCount} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Input placeholder="IP o Range (es. 10.0.0.0/24)" className="md:col-span-2" value={newIp} onChange={e => setNewIp(e.target.value)} onKeyDown={e => e.key === "Enter" && addIp()} />
          <Button onClick={addIp}><Plus className="w-4 h-4 mr-1" />Aggiungi</Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Cerca IP o range..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 font-mono" />
        </div>
        {search && <p className="text-xs text-muted-foreground">{filtered.length} / {ips.length} risultati</p>}
        <div className="border rounded-md">
          <Table>
            <TableHeader><TableRow><TableHead>IP / Range</TableHead><TableHead>Stato</TableHead><TableHead className="text-right">Azioni</TableHead></TableRow></TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={3} className="text-center py-6 text-muted-foreground">{search ? "Nessun risultato" : "Nessun IP configurato"}</TableCell></TableRow>
              ) : filtered.map(ip => (
                <TableRow key={ip}>
                  <TableCell className="font-mono">{ip}</TableCell>
                  <TableCell><Badge variant="secondary">Escluso</Badge></TableCell>
                  <TableCell className="text-right"><Button variant="ghost" size="icon" onClick={() => { setIps(ips.filter(i => i !== ip)); setHasChanges(true); }}><Trash2 className="w-4 h-4 text-destructive" /></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={!hasChanges || saveMutation.isPending}>
            <Save className="w-4 h-4 mr-1" />{saveMutation.isPending ? "Salvataggio..." : saveTarget === "all" ? "Salva su tutti i VPS" : "Salva su questo VPS"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── IPTables Banned IPs ────────────────────────────────────────────────────────

function IpTablesSearchTab() {
  const { data: vpsList } = useVpsList();
  const { data: healthMap } = useVpsHealth();
  const [selectedVps, setSelectedVps] = useState("all");
  const [search, setSearch] = useState("");

  const onlineVps = (vpsList || []).filter(v => healthMap?.[v.id]);
  const targetIds = selectedVps === "all" ? onlineVps.map(v => v.id) : [selectedVps];

  const { data: results, isLoading, refetch } = useQuery<any[]>({
    queryKey: ["firewall-iptables", selectedVps],
    queryFn: async () => {
      const r = await apiRequest("POST", "/api/vps/bulk/get", { vpsIds: targetIds, path: "/api/iptables" });
      return r.json();
    },
    enabled: targetIds.length > 0,
    refetchInterval: 60000,
  });

  const bannedEntries: Array<{ vpsName: string; chain: string; rule: string }> = [];
  (results || []).filter((r: any) => r.success).forEach((r: any) => {
    (r.data || []).forEach((chain: any) => {
      chain.rules.filter((rule: string) =>
        rule.toLowerCase().includes("drop") || rule.toLowerCase().includes("reject")
      ).forEach((rule: string) => {
        bannedEntries.push({ vpsName: r.vpsName, chain: chain.name, rule });
      });
    });
  });

  const filtered = search
    ? bannedEntries.filter(e => e.rule.includes(search) || e.vpsName.toLowerCase().includes(search.toLowerCase()))
    : bannedEntries;

  return (
    <Card className="mt-4">
      <CardHeader>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <CardTitle>IP Bannati — IPTables</CardTitle>
            <CardDescription>Regole DROP/REJECT da tutti i VPS selezionati</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <VpsSelector value={selectedVps} onChange={setSelectedVps} />
            <Button size="sm" variant="outline" onClick={() => refetch()}><RefreshCw className="w-4 h-4" /></Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Cerca IP, VPS o chain..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 font-mono" />
        </div>
        {search && <p className="text-xs text-muted-foreground">{filtered.length} / {bannedEntries.length} risultati</p>}
        {isLoading ? <LoadingState message="Caricamento regole..." /> : (
          <div className="border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>VPS</TableHead>
                  <TableHead>Chain</TableHead>
                  <TableHead>Regola</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow><TableCell colSpan={3} className="text-center py-6 text-muted-foreground">{search ? "Nessun risultato" : "Nessuna regola DROP/REJECT trovata"}</TableCell></TableRow>
                ) : filtered.map((entry, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-sm font-medium">{entry.vpsName}</TableCell>
                    <TableCell><Badge variant="outline" className="font-mono text-xs">{entry.chain}</Badge></TableCell>
                    <TableCell className="font-mono text-xs text-red-400">{entry.rule}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── IPSet View ─────────────────────────────────────────────────────────────────

function IpSetViewTab() {
  const { data: vpsList } = useVpsList();
  const { data: healthMap } = useVpsHealth();
  const [selectedVps, setSelectedVps] = useState("all");
  const [search, setSearch] = useState("");

  const onlineVps = (vpsList || []).filter(v => healthMap?.[v.id]);
  const targetIds = selectedVps === "all" ? onlineVps.map(v => v.id) : [selectedVps];

  const { data: results, isLoading, refetch } = useQuery<any[]>({
    queryKey: ["firewall-ipset", selectedVps],
    queryFn: async () => {
      const r = await apiRequest("POST", "/api/vps/bulk/get", { vpsIds: targetIds, path: "/api/ipset" });
      return r.json();
    },
    enabled: targetIds.length > 0,
    refetchInterval: 60000,
  });

  const byVps = (results || []).filter((r: any) => r.success);
  const filtered = search
    ? byVps.map((r: any) => ({ ...r, data: (r.data || []).filter((s: any) => s.name.toLowerCase().includes(search.toLowerCase())) })).filter((r: any) => r.data.length > 0)
    : byVps;

  return (
    <Card className="mt-4">
      <CardHeader>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <CardTitle>IPSet</CardTitle>
            <CardDescription>Visualizza ipset configurati per VPS</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <VpsSelector value={selectedVps} onChange={setSelectedVps} />
            <Button size="sm" variant="outline" onClick={() => refetch()}><RefreshCw className="w-4 h-4" /></Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Cerca nome ipset..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 font-mono" />
        </div>
        {isLoading ? <LoadingState message="Caricamento ipset..." /> : filtered.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">Nessun VPS online o nessun ipset trovato</p>
        ) : (
          filtered.map((r: any) => (
            <div key={r.vpsId} className="space-y-2">
              <p className="text-sm font-semibold">{r.vpsName}</p>
              <div className="border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nome</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Entries</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(r.data || []).length === 0 ? (
                      <TableRow><TableCell colSpan={3} className="text-center py-4 text-muted-foreground text-sm">Nessun ipset</TableCell></TableRow>
                    ) : (r.data || []).map((s: any) => (
                      <TableRow key={s.name}>
                        <TableCell className="font-mono text-sm">{s.name}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{s.type}</TableCell>
                        <TableCell><Badge variant="outline">{s.count}</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ── ModSecurity ────────────────────────────────────────────────────────────────

interface ModSecStatus {
  engine: string;
  configFound: boolean;
  moduleLoaded: boolean;
  logLines: number;
  logPath: string;
  configPath: string;
}

interface ModSecLogEvent {
  id: string;
  timestamp: string;
  ip: string;
  uri: string;
  method: string;
  status: string;
  messages: string[];
}

function engineBadge(engine: string) {
  if (engine === "On") return <Badge className="bg-green-600 text-white"><ShieldCheck className="w-3 h-3 mr-1 inline" />On</Badge>;
  if (engine === "DetectionOnly") return <Badge className="bg-yellow-500 text-white"><Eye className="w-3 h-3 mr-1 inline" />Detection Only</Badge>;
  if (engine === "Off") return <Badge className="bg-destructive text-white"><ShieldOff className="w-3 h-3 mr-1 inline" />Off</Badge>;
  return <Badge variant="outline">{engine}</Badge>;
}

function ModSecTab({ refVps, saveTarget, totalCount }: TabProps) {
  const { toast } = useToast();
  const [activeSection, setActiveSection] = useState<"status" | "config" | "crs" | "log">("status");
  const [configContent, setConfigContent] = useState("");
  const [crsContent, setCrsContent] = useState("");
  const [configChanged, setConfigChanged] = useState(false);
  const [crsChanged, setCrsChanged] = useState(false);
  const saveMutation = useSaveConfig("modsecurity.conf", saveTarget);
  const crsMutation = useSaveConfig("crs-setup.conf", saveTarget);

  const { data: status, isLoading: statusLoading, refetch: refetchStatus } = useQuery<ModSecStatus>({
    queryKey: ["modsec-status", refVps?.id],
    queryFn: async () => { const r = await apiRequest("GET", `/api/vps/${refVps!.id}/proxy/api/modsec/status`); return r.json(); },
    enabled: !!refVps,
    refetchInterval: 60000,
  });

  const { data: configData, isLoading: configLoading } = useQuery<{ content: string }>({
    queryKey: ["modsec-config", refVps?.id],
    queryFn: async () => { const r = await apiRequest("GET", `/api/vps/${refVps!.id}/proxy/api/config/modsecurity.conf`); return r.json(); },
    enabled: !!refVps && activeSection === "config",
  });

  const { data: crsData, isLoading: crsLoading } = useQuery<{ content: string }>({
    queryKey: ["crs-config", refVps?.id],
    queryFn: async () => { const r = await apiRequest("GET", `/api/vps/${refVps!.id}/proxy/api/config/crs-setup.conf`); return r.json(); },
    enabled: !!refVps && activeSection === "crs",
  });

  const { data: logData, isLoading: logLoading, refetch: refetchLog } = useQuery<{ raw: string; events: ModSecLogEvent[] }>({
    queryKey: ["modsec-log", refVps?.id],
    queryFn: async () => { const r = await apiRequest("GET", `/api/vps/${refVps!.id}/proxy/api/modsec/log?lines=200`); return r.json(); },
    enabled: !!refVps && activeSection === "log",
  });

  useEffect(() => { if (configData) { setConfigContent(configData.content); setConfigChanged(false); } }, [configData]);
  useEffect(() => { if (crsData) { setCrsContent(crsData.content); setCrsChanged(false); } }, [crsData]);

  const engineMutation = useMutation({
    mutationFn: async (state: string) => {
      const r = await apiRequest("POST", `/api/vps/${refVps!.id}/proxy/api/modsec/engine`, { state });
      return r.json();
    },
    onSuccess: (data) => {
      refetchStatus();
      toast({ title: `ModSecurity: ${data.engine}` });
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  if (!refVps) return <div className="py-8 text-center text-muted-foreground">Nessun VPS online disponibile</div>;

  const sectionBtn = (id: typeof activeSection, label: string, icon: React.ReactNode) => (
    <Button size="sm" variant={activeSection === id ? "default" : "outline"} onClick={() => setActiveSection(id)} className="gap-1.5">
      {icon}{label}
    </Button>
  );

  return (
    <div className="mt-4 space-y-4">
      <VpsBanner refVps={refVps} saveTarget={saveTarget} totalCount={totalCount} />

      <div className="flex gap-2 flex-wrap">
        {sectionBtn("status", "Stato", <ShieldAlert className="w-3.5 h-3.5" />)}
        {sectionBtn("config", "modsecurity.conf", <FileText className="w-3.5 h-3.5" />)}
        {sectionBtn("crs", "crs-setup.conf", <FileText className="w-3.5 h-3.5" />)}
        {sectionBtn("log", "Audit Log", <Eye className="w-3.5 h-3.5" />)}
      </div>

      {activeSection === "status" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Engine</p>
                {statusLoading ? <div className="h-6 bg-muted rounded animate-pulse" /> : engineBadge(status?.engine || "unknown")}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Modulo nginx</p>
                {statusLoading ? <div className="h-6 bg-muted rounded animate-pulse" /> : (
                  <Badge variant={status?.moduleLoaded ? "default" : "destructive"}>
                    {status?.moduleLoaded ? "Caricato" : "Non trovato"}
                  </Badge>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Righe audit log</p>
                <p className="text-3xl font-bold font-heading">{statusLoading ? "…" : (status?.logLines || 0).toLocaleString()}</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">Cambia stato engine</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => refetchStatus()}><RefreshCw className="w-3.5 h-3.5" /></Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2 flex-wrap">
                {(["On", "DetectionOnly", "Off"] as const).map(state => (
                  <Button
                    key={state}
                    size="sm"
                    variant={status?.engine === state ? "default" : "outline"}
                    disabled={engineMutation.isPending || status?.engine === state}
                    onClick={() => engineMutation.mutate(state)}
                  >
                    {state === "On" && <ShieldCheck className="w-3.5 h-3.5 mr-1" />}
                    {state === "DetectionOnly" && <Eye className="w-3.5 h-3.5 mr-1" />}
                    {state === "Off" && <ShieldOff className="w-3.5 h-3.5 mr-1" />}
                    {state}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                <strong>On</strong>: blocca le richieste &nbsp;·&nbsp;
                <strong>DetectionOnly</strong>: logga senza bloccare &nbsp;·&nbsp;
                <strong>Off</strong>: disabilitato
              </p>
              {status && !status.configFound && (
                <p className="text-xs text-destructive mt-2">Config non trovata: {status.configPath}</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {(activeSection === "config" || activeSection === "crs") && (() => {
        const isCrs = activeSection === "crs";
        const content = isCrs ? crsContent : configContent;
        const setContent = isCrs ? setCrsContent : setConfigContent;
        const hasChanges = isCrs ? crsChanged : configChanged;
        const setHasChanges = isCrs ? setCrsChanged : setConfigChanged;
        const mutation = isCrs ? crsMutation : saveMutation;
        const loading = isCrs ? crsLoading : configLoading;
        const filename = isCrs ? "crs-setup.conf" : "modsecurity.conf";

        return (
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-mono">{filename}</CardTitle>
                {hasChanges && <Badge variant="outline" className="text-xs">Modificato</Badge>}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {loading ? <LoadingState message="Caricamento..." /> : (
                <Textarea
                  value={content}
                  onChange={e => { setContent(e.target.value); setHasChanges(true); }}
                  className="font-mono text-xs min-h-[420px] resize-y"
                  spellCheck={false}
                />
              )}
              <div className="flex justify-end">
                <Button
                  onClick={() => mutation.mutate(content, { onSuccess: () => setHasChanges(false) })}
                  disabled={!hasChanges || mutation.isPending}
                >
                  <Save className="w-4 h-4 mr-1" />
                  {mutation.isPending ? "Salvataggio..." : saveTarget === "all" ? "Salva su tutti i VPS" : "Salva"}
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {activeSection === "log" && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Audit Log ModSecurity</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => refetchLog()}><RefreshCw className="w-3.5 h-3.5" /></Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {logLoading ? <LoadingState message="Caricamento..." /> : (
              <>
                {logData && logData.events.length > 0 ? (
                  <div>
                    <p className="text-xs text-muted-foreground mb-2">{logData.events.length} eventi recenti</p>
                    <div className="border rounded-md overflow-auto max-h-64">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="text-xs">Timestamp</TableHead>
                            <TableHead className="text-xs">IP</TableHead>
                            <TableHead className="text-xs">Metodo</TableHead>
                            <TableHead className="text-xs">URI</TableHead>
                            <TableHead className="text-xs">Status</TableHead>
                            <TableHead className="text-xs">Regola</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {logData.events.map((e, i) => (
                            <TableRow key={i}>
                              <TableCell className="text-xs font-mono whitespace-nowrap">{e.timestamp}</TableCell>
                              <TableCell className="text-xs font-mono">{e.ip}</TableCell>
                              <TableCell className="text-xs font-mono">{e.method}</TableCell>
                              <TableCell className="text-xs font-mono max-w-[200px] truncate">{e.uri}</TableCell>
                              <TableCell className="text-xs">
                                <Badge variant={e.status && e.status.startsWith("4") ? "destructive" : "outline"}>{e.status || "—"}</Badge>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                                {e.messages.length > 0 ? e.messages[0].substring(0, 60) + (e.messages[0].length > 60 ? "…" : "") : "—"}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    {logData?.raw?.trim() ? "Nessun evento parsato" : "Audit log vuoto"}
                  </p>
                )}
                {logData?.raw?.trim() && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Raw (ultime righe)</p>
                    <pre className="bg-muted rounded p-3 text-xs font-mono overflow-auto max-h-48 whitespace-pre-wrap break-all">
                      {logData.raw.slice(-3000)}
                    </pre>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
