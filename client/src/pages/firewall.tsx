import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useVpsList, useVpsHealth } from "@/hooks/use-vps";
import { apiRequest } from "@/lib/queryClient";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Save, Trash2, Wifi } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { LoadingState } from "@/components/loading-state";

interface BulkResult { vpsId: string; vpsName: string; success: boolean; error?: string; }

function useRefVps() {
  const { data: vpsList } = useVpsList();
  const { data: healthMap } = useVpsHealth();
  return vpsList?.find(v => healthMap?.[v.id]) ?? null;
}

function useBulkSaveConfig(filename: string) {
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (content: string) => {
      const r = await apiRequest("POST", "/api/vps/bulk/post", {
        vpsIds: "all",
        path: `/api/config/${filename}`,
        body: { content },
      });
      return r.json() as Promise<BulkResult[]>;
    },
    onSuccess: (results) => {
      const ok = results.filter(r => r.success).length;
      toast({
        title: ok === results.length ? "Salvato su tutti i VPS" : `Salvato su ${ok}/${results.length} VPS`,
        description: filename,
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
      <span className="ml-auto">Applica a <strong className="text-foreground">{count}</strong> VPS</span>
    </div>
  );
}

export default function Firewall() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-heading font-bold tracking-tight">Regole Firewall</h1>
        <p className="text-muted-foreground text-sm">Le modifiche vengono applicate a tutti i VPS simultaneamente</p>
      </div>
      <Tabs defaultValue="countries">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="countries">Paesi</TabsTrigger>
          <TabsTrigger value="asn">ASN</TabsTrigger>
          <TabsTrigger value="isp">ISP</TabsTrigger>
          <TabsTrigger value="useragent">User-Agent</TabsTrigger>
          <TabsTrigger value="ip">IP Whitelist</TabsTrigger>
          <TabsTrigger value="exclusion">IP Exclusion</TabsTrigger>
        </TabsList>
        <TabsContent value="countries"><CountriesTab /></TabsContent>
        <TabsContent value="asn"><AsnTab /></TabsContent>
        <TabsContent value="isp"><IspTab /></TabsContent>
        <TabsContent value="useragent"><UserAgentTab /></TabsContent>
        <TabsContent value="ip"><IpWhitelistTab /></TabsContent>
        <TabsContent value="exclusion"><ExclusionIpTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ── Countries ──────────────────────────────────────────────────────────────────

function CountriesTab() {
  const refVps = useRefVps();
  const { data: vpsList } = useVpsList();
  const [countries, setCountries] = useState<string[]>([]);
  const [newCountry, setNewCountry] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const saveMutation = useBulkSaveConfig("country_whitelist.conf");

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

  const handleSave = () => {
    const content = countries.map(c => `${c} yes;`).join("\n") + "\n";
    saveMutation.mutate(content, { onSuccess: () => setHasChanges(false) });
  };

  if (!refVps) return <div className="py-8 text-center text-muted-foreground">Nessun VPS online disponibile</div>;
  if (isLoading) return <LoadingState message="Caricamento..." />;

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Whitelist Paesi</CardTitle>
        <CardDescription>Codici ISO 3166-1 alpha-2 (es. IT, DE, FR)</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <RefVpsBanner name={refVps.name} count={vpsList?.length ?? 0} />
        <div className="flex gap-2">
          <Input placeholder="Codice paese (es. IT)" value={newCountry} onChange={e => setNewCountry(e.target.value.toUpperCase())} maxLength={2} onKeyPress={e => e.key === "Enter" && newCountry.length === 2 && !countries.includes(newCountry) && (setCountries([...countries, newCountry]), setNewCountry(""), setHasChanges(true))} />
          <Button onClick={() => { if (newCountry.length === 2 && !countries.includes(newCountry)) { setCountries([...countries, newCountry]); setNewCountry(""); setHasChanges(true); } }}>
            <Plus className="w-4 h-4 mr-1" />Aggiungi
          </Button>
        </div>
        <div className="border rounded-md">
          <Table>
            <TableHeader><TableRow><TableHead>Codice</TableHead><TableHead>Stato</TableHead><TableHead className="text-right">Azioni</TableHead></TableRow></TableHeader>
            <TableBody>
              {countries.length === 0 ? (
                <TableRow><TableCell colSpan={3} className="text-center py-6 text-muted-foreground">Nessun paese configurato</TableCell></TableRow>
              ) : countries.map(code => (
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
            <Save className="w-4 h-4 mr-1" />{saveMutation.isPending ? "Salvataggio..." : "Salva su tutti i VPS"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── ASN ────────────────────────────────────────────────────────────────────────

function AsnTab() {
  const refVps = useRefVps();
  const { data: vpsList } = useVpsList();
  const [asns, setAsns] = useState<Array<{ asn: string; description?: string }>>([]);
  const [newAsn, setNewAsn] = useState(""); const [newDesc, setNewDesc] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const saveMutation = useBulkSaveConfig("block_asn.conf");

  const { data: configData, isLoading } = useQuery<{ content: string }>({
    queryKey: ["proxy-config-block_asn", refVps?.id],
    queryFn: async () => { const r = await apiRequest("GET", `/api/vps/${refVps!.id}/proxy/api/config/block_asn.conf`); return r.json(); },
    enabled: !!refVps,
  });

  useEffect(() => {
    if (configData) {
      const parsed = configData.content.split("\n").map(line => {
        const t = line.trim();
        if (t.startsWith("#") || !t || !/^\S+\s+\S+;/.test(t)) return null;
        const parts = t.split(/\s+/); const asn = parts[0];
        const comment = t.includes("#") ? t.split("#").slice(1).join("#").trim() : undefined;
        return { asn, description: comment };
      }).filter(Boolean) as any[];
      setAsns(parsed); setHasChanges(false);
    }
  }, [configData]);

  const handleSave = () => {
    const content = asns.map(({ asn, description }) => `${asn} 1;${description ? ` # ${description}` : ""}`).join("\n") + "\n";
    saveMutation.mutate(content, { onSuccess: () => setHasChanges(false) });
  };

  if (!refVps) return <div className="py-8 text-center text-muted-foreground">Nessun VPS online disponibile</div>;
  if (isLoading) return <LoadingState message="Caricamento..." />;

  return (
    <Card className="mt-4">
      <CardHeader><CardTitle>Blacklist ASN</CardTitle><CardDescription>Blocca Autonomous System Numbers (es. Google: 15169)</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <RefVpsBanner name={refVps.name} count={vpsList?.length ?? 0} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Input placeholder="Numero ASN" value={newAsn} onChange={e => setNewAsn(e.target.value)} />
          <Input placeholder="Descrizione (opzionale)" value={newDesc} onChange={e => setNewDesc(e.target.value)} />
          <Button onClick={() => { if (newAsn && !asns.find(a => a.asn === newAsn)) { setAsns([...asns, { asn: newAsn, description: newDesc || undefined }]); setNewAsn(""); setNewDesc(""); setHasChanges(true); } }}>
            <Plus className="w-4 h-4 mr-1" />Aggiungi
          </Button>
        </div>
        <div className="border rounded-md">
          <Table>
            <TableHeader><TableRow><TableHead>ASN</TableHead><TableHead>Descrizione</TableHead><TableHead>Stato</TableHead><TableHead className="text-right">Azioni</TableHead></TableRow></TableHeader>
            <TableBody>
              {asns.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="text-center py-6 text-muted-foreground">Nessun ASN bloccato</TableCell></TableRow>
              ) : asns.map(({ asn, description }) => (
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
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={!hasChanges || saveMutation.isPending}>
            <Save className="w-4 h-4 mr-1" />{saveMutation.isPending ? "Salvataggio..." : "Salva su tutti i VPS"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── ISP ────────────────────────────────────────────────────────────────────────

function IspTab() {
  const refVps = useRefVps();
  const { data: vpsList } = useVpsList();
  const [isps, setIsps] = useState<Array<{ name: string; type: string }>>([]);
  const [newIsp, setNewIsp] = useState(""); const [matchType, setMatchType] = useState<"exact" | "partial">("partial");
  const [hasChanges, setHasChanges] = useState(false);
  const saveMutation = useBulkSaveConfig("block_isp.conf");

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
        // Format: "~*Pattern" 1;  or  "Exact Name" 1;
        const m = t.match(/^"([^"]+)"\s+\S+;/);
        if (!m) return null;
        const raw = m[1];
        const isPartial = raw.startsWith("~*");
        return { name: isPartial ? raw.slice(2) : raw, type: isPartial ? "partial" : "exact" };
      }).filter(Boolean) as any[];
      setIsps(parsed); setHasChanges(false);
    }
  }, [configData]);

  const handleSave = () => {
    const content = isps.map(({ name, type }) => type === "partial" ? `"~*${name}" 1;` : `"${name}" 1;`).join("\n") + "\n";
    saveMutation.mutate(content, { onSuccess: () => setHasChanges(false) });
  };

  if (!refVps) return <div className="py-8 text-center text-muted-foreground">Nessun VPS online disponibile</div>;
  if (isLoading) return <LoadingState message="Caricamento..." />;

  return (
    <Card className="mt-4">
      <CardHeader><CardTitle>Blacklist ISP</CardTitle><CardDescription>Blocca provider internet per nome</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <RefVpsBanner name={refVps.name} count={vpsList?.length ?? 0} />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <Input placeholder="Nome ISP" value={newIsp} onChange={e => setNewIsp(e.target.value)} className="md:col-span-2" />
          <Select value={matchType} onValueChange={v => setMatchType(v as any)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="exact">Esatto</SelectItem><SelectItem value="partial">Parziale</SelectItem></SelectContent></Select>
          <Button onClick={() => { if (newIsp && !isps.find(i => i.name === newIsp)) { setIsps([...isps, { name: newIsp, type: matchType }]); setNewIsp(""); setHasChanges(true); } }}><Plus className="w-4 h-4 mr-1" />Aggiungi</Button>
        </div>
        <div className="border rounded-md">
          <Table>
            <TableHeader><TableRow><TableHead>ISP</TableHead><TableHead>Tipo</TableHead><TableHead>Stato</TableHead><TableHead className="text-right">Azioni</TableHead></TableRow></TableHeader>
            <TableBody>
              {isps.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="text-center py-6 text-muted-foreground">Nessun ISP bloccato</TableCell></TableRow>
              ) : isps.map(({ name, type }) => (
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
            <Save className="w-4 h-4 mr-1" />{saveMutation.isPending ? "Salvataggio..." : "Salva su tutti i VPS"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── User-Agent ─────────────────────────────────────────────────────────────────

function UserAgentTab() {
  const refVps = useRefVps();
  const { data: vpsList } = useVpsList();
  const [patterns, setPatterns] = useState<string[]>([]);
  const [newPattern, setNewPattern] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const saveMutation = useBulkSaveConfig("useragent.rules");

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
        // Format: ~*pattern  1;  (with tab/spaces before value)
        const m = t.match(/^~?\*?(.+?)\s+\S+;/);
        return m ? m[1].trim() : null;
      }).filter(Boolean) as string[];
      setPatterns(parsed); setHasChanges(false);
    }
  }, [configData]);

  const handleSave = () => {
    const content = patterns.map(p => `~*${p} 1;`).join("\n") + "\n";
    saveMutation.mutate(content, { onSuccess: () => setHasChanges(false) });
  };

  if (!refVps) return <div className="py-8 text-center text-muted-foreground">Nessun VPS online disponibile</div>;
  if (isLoading) return <LoadingState message="Caricamento..." />;

  return (
    <Card className="mt-4">
      <CardHeader><CardTitle>Blacklist User-Agent</CardTitle><CardDescription>Blocca bot e crawler per pattern regex</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <RefVpsBanner name={refVps.name} count={vpsList?.length ?? 0} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Input placeholder="Pattern (es. bot|crawler)" className="md:col-span-2" value={newPattern} onChange={e => setNewPattern(e.target.value)} onKeyPress={e => e.key === "Enter" && newPattern && !patterns.includes(newPattern) && (setPatterns([...patterns, newPattern]), setNewPattern(""), setHasChanges(true))} />
          <Button onClick={() => { if (newPattern && !patterns.includes(newPattern)) { setPatterns([...patterns, newPattern]); setNewPattern(""); setHasChanges(true); } }}><Plus className="w-4 h-4 mr-1" />Aggiungi</Button>
        </div>
        <div className="border rounded-md">
          <Table>
            <TableHeader><TableRow><TableHead>Pattern</TableHead><TableHead>Stato</TableHead><TableHead className="text-right">Azioni</TableHead></TableRow></TableHeader>
            <TableBody>
              {patterns.length === 0 ? (
                <TableRow><TableCell colSpan={3} className="text-center py-6 text-muted-foreground">Nessun pattern configurato</TableCell></TableRow>
              ) : patterns.map(pattern => (
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
            <Save className="w-4 h-4 mr-1" />{saveMutation.isPending ? "Salvataggio..." : "Salva su tutti i VPS"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── IP Whitelist ───────────────────────────────────────────────────────────────

function IpWhitelistTab() {
  const refVps = useRefVps();
  const { data: vpsList } = useVpsList();
  const [ips, setIps] = useState<string[]>([]);
  const [newIp, setNewIp] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const saveMutation = useBulkSaveConfig("ip_whitelist.conf");

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
        return t.split(/\s+/)[0]; // extract IP/CIDR, ignore value and comments
      }).filter(Boolean) as string[];
      setIps(parsed); setHasChanges(false);
    }
  }, [configData]);

  const handleSave = () => {
    const content = ips.map(ip => `${ip} 0;`).join("\n") + "\n";
    saveMutation.mutate(content, { onSuccess: () => setHasChanges(false) });
  };

  if (!refVps) return <div className="py-8 text-center text-muted-foreground">Nessun VPS online disponibile</div>;
  if (isLoading) return <LoadingState message="Caricamento..." />;

  return (
    <Card className="mt-4">
      <CardHeader><CardTitle>IP Whitelist</CardTitle><CardDescription>IP esclusi dal rate limiting (singoli o CIDR)</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <RefVpsBanner name={refVps.name} count={vpsList?.length ?? 0} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Input placeholder="IP o Range (es. 10.0.0.0/24)" className="md:col-span-2" value={newIp} onChange={e => setNewIp(e.target.value)} onKeyPress={e => e.key === "Enter" && newIp && !ips.includes(newIp) && (setIps([...ips, newIp]), setNewIp(""), setHasChanges(true))} />
          <Button onClick={() => { if (newIp && !ips.includes(newIp)) { setIps([...ips, newIp]); setNewIp(""); setHasChanges(true); } }}><Plus className="w-4 h-4 mr-1" />Aggiungi</Button>
        </div>
        <div className="border rounded-md">
          <Table>
            <TableHeader><TableRow><TableHead>IP / Range</TableHead><TableHead>Stato</TableHead><TableHead className="text-right">Azioni</TableHead></TableRow></TableHeader>
            <TableBody>
              {ips.length === 0 ? (
                <TableRow><TableCell colSpan={3} className="text-center py-6 text-muted-foreground">Nessun IP in whitelist</TableCell></TableRow>
              ) : ips.map(ip => (
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
            <Save className="w-4 h-4 mr-1" />{saveMutation.isPending ? "Salvataggio..." : "Salva su tutti i VPS"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── IP Exclusion ───────────────────────────────────────────────────────────────

function ExclusionIpTab() {
  const refVps = useRefVps();
  const { data: vpsList } = useVpsList();
  const [ips, setIps] = useState<string[]>([]);
  const [newIp, setNewIp] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const saveMutation = useBulkSaveConfig("exclusion_ip.conf");

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

  const handleSave = () => {
    const content = ips.map(ip => `${ip} 1;`).join("\n") + "\n";
    saveMutation.mutate(content, { onSuccess: () => setHasChanges(false) });
  };

  if (!refVps) return <div className="py-8 text-center text-muted-foreground">Nessun VPS online disponibile</div>;
  if (isLoading) return <LoadingState message="Caricamento..." />;

  return (
    <Card className="mt-4">
      <CardHeader><CardTitle>IP Exclusion</CardTitle><CardDescription>IP esclusi dal blocco geografico</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <RefVpsBanner name={refVps.name} count={vpsList?.length ?? 0} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Input placeholder="IP o Range (es. 10.0.0.0/24)" className="md:col-span-2" value={newIp} onChange={e => setNewIp(e.target.value)} onKeyPress={e => e.key === "Enter" && newIp && !ips.includes(newIp) && (setIps([...ips, newIp]), setNewIp(""), setHasChanges(true))} />
          <Button onClick={() => { if (newIp && !ips.includes(newIp)) { setIps([...ips, newIp]); setNewIp(""); setHasChanges(true); } }}><Plus className="w-4 h-4 mr-1" />Aggiungi</Button>
        </div>
        <div className="border rounded-md">
          <Table>
            <TableHeader><TableRow><TableHead>IP / Range</TableHead><TableHead>Stato</TableHead><TableHead className="text-right">Azioni</TableHead></TableRow></TableHeader>
            <TableBody>
              {ips.length === 0 ? (
                <TableRow><TableCell colSpan={3} className="text-center py-6 text-muted-foreground">Nessun IP configurato</TableCell></TableRow>
              ) : ips.map(ip => (
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
            <Save className="w-4 h-4 mr-1" />{saveMutation.isPending ? "Salvataggio..." : "Salva su tutti i VPS"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
