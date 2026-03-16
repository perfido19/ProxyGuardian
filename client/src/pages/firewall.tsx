import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Save, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ConfigFile } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { LoadingState } from "@/components/loading-state";

export default function Firewall() {
  const [activeTab, setActiveTab] = useState("countries");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Regole Firewall</h1>
        <p className="text-muted-foreground">
          Gestisci whitelist e blacklist per proteggere il tuo proxy
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-5" data-testid="tabs-firewall">
          <TabsTrigger value="countries" data-testid="tab-countries">Paesi</TabsTrigger>
          <TabsTrigger value="asn" data-testid="tab-asn">ASN</TabsTrigger>
          <TabsTrigger value="isp" data-testid="tab-isp">ISP</TabsTrigger>
          <TabsTrigger value="useragent" data-testid="tab-useragent">User-Agent</TabsTrigger>
          <TabsTrigger value="ip" data-testid="tab-ip">IP Whitelist</TabsTrigger>
        </TabsList>

        <TabsContent value="countries" className="space-y-4">
          <CountriesTab />
        </TabsContent>

        <TabsContent value="asn" className="space-y-4">
          <AsnTab />
        </TabsContent>

        <TabsContent value="isp" className="space-y-4">
          <IspTab />
        </TabsContent>

        <TabsContent value="useragent" className="space-y-4">
          <UserAgentTab />
        </TabsContent>

        <TabsContent value="ip" className="space-y-4">
          <IpWhitelistTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CountriesTab() {
  const { toast } = useToast();
  const [newCountry, setNewCountry] = useState("");
  const [countries, setCountries] = useState<string[]>([]);
  const [hasChanges, setHasChanges] = useState(false);

  const { data: configFile, isLoading } = useQuery<ConfigFile>({
    queryKey: ['/api/config', 'country_whitelist.conf'],
  });

  const updateConfigMutation = useMutation({
    mutationFn: async ({ filename, content }: { filename: string; content: string }) => {
      const res = await apiRequest('POST', '/api/config/update', { filename, content });
      return res.json() as Promise<{ success: boolean; message: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/config', 'country_whitelist.conf'] });
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
      const lines = configFile.content
        .split('\n')
        .filter(line => !line.trim().startsWith('#') && line.includes('yes'))
        .map(line => line.split(/\s+/)[0])
        .filter(Boolean);
      setCountries(lines);
    }
  }, [configFile]);

  const handleAddCountry = () => {
    if (newCountry.length === 2 && !countries.includes(newCountry)) {
      setCountries([...countries, newCountry]);
      setNewCountry("");
      setHasChanges(true);
    }
  };

  const handleRemoveCountry = (code: string) => {
    setCountries(countries.filter(c => c !== code));
    setHasChanges(true);
  };

  const handleSave = () => {
    const content = countries.map(code => `${code} yes;`).join('\n') + '\n';
    updateConfigMutation.mutate({ filename: 'country_whitelist.conf', content });
  };

  if (isLoading) {
    return <LoadingState message="Caricamento configurazione paesi..." />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Whitelist Paesi</CardTitle>
        <CardDescription>
          Configura i paesi autorizzati ad accedere al proxy. 
          Usa i codici ISO 3166-1 alpha-2 (es. IT, DE, FR).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            placeholder="Codice paese (es. IT)"
            value={newCountry}
            onChange={(e) => setNewCountry(e.target.value.toUpperCase())}
            maxLength={2}
            data-testid="input-country-code"
            onKeyPress={(e) => e.key === 'Enter' && handleAddCountry()}
          />
          <Button onClick={handleAddCountry} data-testid="button-add-country">
            <Plus className="w-4 h-4 mr-1" />
            Aggiungi
          </Button>
        </div>

        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Codice</TableHead>
                <TableHead>Stato</TableHead>
                <TableHead className="text-right">Azioni</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {countries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                    Nessun paese configurato. Default: tutti i paesi bloccati.
                  </TableCell>
                </TableRow>
              ) : (
                countries.map((code) => (
                  <TableRow key={code}>
                    <TableCell className="font-mono font-semibold">{code}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">Consentito</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemoveCountry(code)}
                        data-testid={`button-remove-country-${code}`}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex justify-end">
          <Button
            variant="default"
            onClick={handleSave}
            disabled={!hasChanges || updateConfigMutation.isPending}
            data-testid="button-save-countries"
          >
            <Save className="w-4 h-4 mr-1" />
            {updateConfigMutation.isPending ? "Salvataggio..." : "Salva Modifiche"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AsnTab() {
  const { toast } = useToast();
  const [newAsn, setNewAsn] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [asns, setAsns] = useState<Array<{ asn: string; description?: string }>>([]);
  const [hasChanges, setHasChanges] = useState(false);

  const { data: configFile, isLoading } = useQuery<ConfigFile>({
    queryKey: ['/api/config', 'block_asn.conf'],
  });

  const updateConfigMutation = useMutation({
    mutationFn: async ({ filename, content }: { filename: string; content: string }) => {
      const res = await apiRequest('POST', '/api/config/update', { filename, content });
      return res.json() as Promise<{ success: boolean; message: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/config', 'block_asn.conf'] });
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
      const parsed = configFile.content
        .split('\n')
        .map(line => {
          if (line.trim().startsWith('#') || !line.includes('yes')) return null;
          const parts = line.split(/\s+/);
          const asn = parts[0];
          const comment = line.includes('#') ? line.split('#')[1].trim() : undefined;
          return { asn, description: comment };
        })
        .filter(Boolean) as Array<{ asn: string; description?: string }>;
      setAsns(parsed);
    }
  }, [configFile]);

  const handleAddAsn = () => {
    if (newAsn && !asns.find(a => a.asn === newAsn)) {
      setAsns([...asns, { asn: newAsn, description: newDescription || undefined }]);
      setNewAsn("");
      setNewDescription("");
      setHasChanges(true);
    }
  };

  const handleRemoveAsn = (asn: string) => {
    setAsns(asns.filter(a => a.asn !== asn));
    setHasChanges(true);
  };

  const handleSave = () => {
    const content = asns.map(({ asn, description }) => 
      `${asn} yes;${description ? ` # ${description}` : ''}`
    ).join('\n') + '\n';
    updateConfigMutation.mutate({ filename: 'block_asn.conf', content });
  };

  if (isLoading) {
    return <LoadingState message="Caricamento configurazione ASN..." />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Blacklist ASN</CardTitle>
        <CardDescription>
          Blocca specifici Autonomous System Numbers (es. Google: 15169, Microsoft: 8075).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Input
            placeholder="Numero ASN"
            value={newAsn}
            onChange={(e) => setNewAsn(e.target.value)}
            data-testid="input-asn-number"
          />
          <Input
            placeholder="Descrizione (opzionale)"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            data-testid="input-asn-description"
          />
          <Button onClick={handleAddAsn} data-testid="button-add-asn">
            <Plus className="w-4 h-4 mr-1" />
            Aggiungi
          </Button>
        </div>

        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ASN</TableHead>
                <TableHead>Descrizione</TableHead>
                <TableHead>Stato</TableHead>
                <TableHead className="text-right">Azioni</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {asns.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                    Nessun ASN bloccato
                  </TableCell>
                </TableRow>
              ) : (
                asns.map(({ asn, description }) => (
                  <TableRow key={asn}>
                    <TableCell className="font-mono font-semibold">{asn}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {description || '-'}
                    </TableCell>
                    <TableCell>
                      <Badge variant="destructive">Bloccato</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemoveAsn(asn)}
                        data-testid={`button-remove-asn-${asn}`}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex justify-end">
          <Button
            variant="default"
            onClick={handleSave}
            disabled={!hasChanges || updateConfigMutation.isPending}
            data-testid="button-save-asn"
          >
            <Save className="w-4 h-4 mr-1" />
            {updateConfigMutation.isPending ? "Salvataggio..." : "Salva Modifiche"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function IspTab() {
  const { toast } = useToast();
  const [newIsp, setNewIsp] = useState("");
  const [matchType, setMatchType] = useState<"exact" | "partial">("partial");
  const [isps, setIsps] = useState<Array<{ name: string; type: string }>>([]);
  const [hasChanges, setHasChanges] = useState(false);

  const { data: configFile, isLoading } = useQuery<ConfigFile>({
    queryKey: ['/api/config', 'block_isp.conf'],
  });

  const updateConfigMutation = useMutation({
    mutationFn: async ({ filename, content }: { filename: string; content: string }) => {
      const res = await apiRequest('POST', '/api/config/update', { filename, content });
      return res.json() as Promise<{ success: boolean; message: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/config', 'block_isp.conf'] });
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
      const parsed = configFile.content
        .split('\n')
        .map(line => {
          if (line.trim().startsWith('#') || !line.includes('return')) return null;
          const name = line.split('"')[1] || line.split("'")[1];
          const type = line.includes('~*') ? 'partial' : 'exact';
          return { name, type };
        })
        .filter(Boolean) as Array<{ name: string; type: string }>;
      setIsps(parsed);
    }
  }, [configFile]);

  const handleAddIsp = () => {
    if (newIsp && !isps.find(i => i.name === newIsp)) {
      setIsps([...isps, { name: newIsp, type: matchType }]);
      setNewIsp("");
      setHasChanges(true);
    }
  };

  const handleRemoveIsp = (name: string) => {
    setIsps(isps.filter(i => i.name !== name));
    setHasChanges(true);
  };

  const handleSave = () => {
    const content = isps.map(({ name, type }) => 
      type === 'partial' 
        ? `if ($geoip2_isp ~* "${name}") { return 403; }`
        : `if ($geoip2_isp = "${name}") { return 403; }`
    ).join('\n') + '\n';
    updateConfigMutation.mutate({ filename: 'block_isp.conf', content });
  };

  if (isLoading) {
    return <LoadingState message="Caricamento configurazione ISP..." />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Blacklist ISP</CardTitle>
        <CardDescription>
          Blocca provider internet specifici per nome.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <Input
            placeholder="Nome ISP"
            value={newIsp}
            onChange={(e) => setNewIsp(e.target.value)}
            className="md:col-span-2"
            data-testid="input-isp-name"
          />
          <Select value={matchType} onValueChange={(v) => setMatchType(v as "exact" | "partial")}>
            <SelectTrigger data-testid="select-match-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="exact">Esatto</SelectItem>
              <SelectItem value="partial">Parziale</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={handleAddIsp} data-testid="button-add-isp">
            <Plus className="w-4 h-4 mr-1" />
            Aggiungi
          </Button>
        </div>

        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome ISP</TableHead>
                <TableHead>Tipo Match</TableHead>
                <TableHead>Stato</TableHead>
                <TableHead className="text-right">Azioni</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isps.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                    Nessun ISP bloccato
                  </TableCell>
                </TableRow>
              ) : (
                isps.map(({ name, type }) => (
                  <TableRow key={name}>
                    <TableCell className="font-mono">{name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {type === 'exact' ? 'Esatto' : 'Parziale'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="destructive">Bloccato</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemoveIsp(name)}
                        data-testid={`button-remove-isp-${name}`}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex justify-end">
          <Button
            variant="default"
            onClick={handleSave}
            disabled={!hasChanges || updateConfigMutation.isPending}
            data-testid="button-save-isp"
          >
            <Save className="w-4 h-4 mr-1" />
            {updateConfigMutation.isPending ? "Salvataggio..." : "Salva Modifiche"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function UserAgentTab() {
  const { toast } = useToast();
  const [newPattern, setNewPattern] = useState("");
  const [patterns, setPatterns] = useState<string[]>([]);
  const [hasChanges, setHasChanges] = useState(false);

  const { data: configFile, isLoading } = useQuery<ConfigFile>({
    queryKey: ['/api/config', 'useragent.rules'],
  });

  const updateConfigMutation = useMutation({
    mutationFn: async ({ filename, content }: { filename: string; content: string }) => {
      const res = await apiRequest('POST', '/api/config/update', { filename, content });
      return res.json() as Promise<{ success: boolean; message: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/config', 'useragent.rules'] });
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
      const parsed = configFile.content
        .split('\n')
        .map(line => {
          if (line.trim().startsWith('#') || !line.includes('return')) return null;
          const match = line.match(/\$http_user_agent\s+(~\*?)\s+"([^"]+)"/);
          return match ? match[2] : null;
        })
        .filter(Boolean) as string[];
      setPatterns(parsed);
    }
  }, [configFile]);

  const handleAddPattern = () => {
    if (newPattern && !patterns.includes(newPattern)) {
      setPatterns([...patterns, newPattern]);
      setNewPattern("");
      setHasChanges(true);
    }
  };

  const handleRemovePattern = (pattern: string) => {
    setPatterns(patterns.filter(p => p !== pattern));
    setHasChanges(true);
  };

  const handleSave = () => {
    const content = patterns.map(pattern => 
      `if ($http_user_agent ~* "${pattern}") { return 403; }`
    ).join('\n') + '\n';
    updateConfigMutation.mutate({ filename: 'useragent.rules', content });
  };

  if (isLoading) {
    return <LoadingState message="Caricamento configurazione User-Agent..." />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Blacklist User-Agent</CardTitle>
        <CardDescription>
          Blocca richieste con specifici user agent (bot, crawler, ecc.).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Input
            placeholder="Pattern (es. bot|crawler)"
            className="md:col-span-2"
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            data-testid="input-useragent-pattern"
            onKeyPress={(e) => e.key === 'Enter' && handleAddPattern()}
          />
          <Button onClick={handleAddPattern} data-testid="button-add-useragent">
            <Plus className="w-4 h-4 mr-1" />
            Aggiungi
          </Button>
        </div>

        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pattern</TableHead>
                <TableHead>Stato</TableHead>
                <TableHead className="text-right">Azioni</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {patterns.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                    Nessun user-agent bloccato. Default: tutti consentiti.
                  </TableCell>
                </TableRow>
              ) : (
                patterns.map((pattern) => (
                  <TableRow key={pattern}>
                    <TableCell className="font-mono">{pattern}</TableCell>
                    <TableCell>
                      <Badge variant="destructive">Bloccato</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemovePattern(pattern)}
                        data-testid={`button-remove-useragent-${pattern}`}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex justify-end">
          <Button
            variant="default"
            onClick={handleSave}
            disabled={!hasChanges || updateConfigMutation.isPending}
            data-testid="button-save-useragent"
          >
            <Save className="w-4 h-4 mr-1" />
            {updateConfigMutation.isPending ? "Salvataggio..." : "Salva Modifiche"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function IpWhitelistTab() {
  const { toast } = useToast();
  const [newIp, setNewIp] = useState("");
  const [ips, setIps] = useState<string[]>([]);
  const [hasChanges, setHasChanges] = useState(false);

  const { data: configFile, isLoading } = useQuery<ConfigFile>({
    queryKey: ['/api/config', 'ip_whitelist.conf'],
  });

  const updateConfigMutation = useMutation({
    mutationFn: async ({ filename, content }: { filename: string; content: string }) => {
      const res = await apiRequest('POST', '/api/config/update', { filename, content });
      return res.json() as Promise<{ success: boolean; message: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/config', 'ip_whitelist.conf'] });
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
      const parsed = configFile.content
        .split('\n')
        .map(line => {
          if (line.trim().startsWith('#') || !line.trim()) return null;
          return line.trim().replace(';', '');
        })
        .filter(Boolean) as string[];
      setIps(parsed);
    }
  }, [configFile]);

  const handleAddIp = () => {
    if (newIp && !ips.includes(newIp)) {
      setIps([...ips, newIp]);
      setNewIp("");
      setHasChanges(true);
    }
  };

  const handleRemoveIp = (ip: string) => {
    setIps(ips.filter(i => i !== ip));
    setHasChanges(true);
  };

  const handleSave = () => {
    const content = ips.map(ip => `${ip};`).join('\n') + '\n';
    updateConfigMutation.mutate({ filename: 'ip_whitelist.conf', content });
  };

  if (isLoading) {
    return <LoadingState message="Caricamento whitelist IP..." />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Whitelist IP</CardTitle>
        <CardDescription>
          IP esclusi dal rate limiting. Supporta indirizzi singoli e range CIDR.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Input
            placeholder="IP o Range (es. 10.0.0.0/24)"
            className="md:col-span-2"
            value={newIp}
            onChange={(e) => setNewIp(e.target.value)}
            data-testid="input-ip-whitelist"
            onKeyPress={(e) => e.key === 'Enter' && handleAddIp()}
          />
          <Button onClick={handleAddIp} data-testid="button-add-ip-whitelist">
            <Plus className="w-4 h-4 mr-1" />
            Aggiungi
          </Button>
        </div>

        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Indirizzo IP / Range</TableHead>
                <TableHead>Stato</TableHead>
                <TableHead className="text-right">Azioni</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ips.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                    Nessun IP in whitelist
                  </TableCell>
                </TableRow>
              ) : (
                ips.map((ip) => (
                  <TableRow key={ip}>
                    <TableCell className="font-mono font-semibold">{ip}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">Escluso</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemoveIp(ip)}
                        data-testid={`button-remove-ip-${ip}`}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex justify-end">
          <Button
            variant="default"
            onClick={handleSave}
            disabled={!hasChanges || updateConfigMutation.isPending}
            data-testid="button-save-ip-whitelist"
          >
            <Save className="w-4 h-4 mr-1" />
            {updateConfigMutation.isPending ? "Salvataggio..." : "Salva Modifiche"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
