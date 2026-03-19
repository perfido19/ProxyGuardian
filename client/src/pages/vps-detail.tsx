import { useState, useEffect } from "react";
import { useParams, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useVpsList } from "@/hooks/use-vps";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LoadingState } from "@/components/loading-state";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft, RefreshCw, Server, Shield, Activity,
  HardDrive, Cpu, MemoryStick, CheckCircle, XCircle,
  Play, Square, RotateCw, ShieldOff, Wifi, WifiOff,
  FileText, Settings, Save, AlertTriangle, Search, Plus, Trash2, Network,
} from "lucide-react";

interface ServiceStatus { name: string; status: string; pid?: number; uptime?: string; }
interface BannedIp { ip: string; jail: string; banTime: string; }
interface LogEntry { id: number; timestamp: string; level: string; message: string; source: string; }
interface SystemInfo {
  uptime: string; hostname: string;
  memory: { total: number; used: number; free: number };
  disk: { total: string; used: string; free: string; percent: string };
  load: { "1m": number; "5m": number; "15m": number };
}
interface Jail { name: string; enabled: boolean; banTime: number; maxRetry: number; findTime: number; }
interface IpSetMeta { name: string; type: string; count: number; }
interface IpSetDetail extends IpSetMeta { members: string[]; }
interface IpTablesChain { name: string; policy: string; rules: string[]; }

const REFETCH = 60000;

const CONFIG_FILES = [
  { value: "nginx.conf", label: "nginx.conf" },
  { value: "jail.local", label: "jail.local (fail2ban)" },
  { value: "fail2ban.local", label: "fail2ban.local" },
  { value: "country_whitelist.conf", label: "country_whitelist.conf" },
  { value: "block_asn.conf", label: "block_asn.conf" },
  { value: "block_isp.conf", label: "block_isp.conf" },
  { value: "useragent.rules", label: "useragent.rules" },
  { value: "ip_whitelist.conf", label: "ip_whitelist.conf" },
  { value: "exclusion_ip.conf", label: "exclusion_ip.conf" },
];

const LOG_TYPES = [
  { value: "nginx_access", label: "Nginx Access" },
  { value: "nginx_error", label: "Nginx Error" },
  { value: "fail2ban", label: "Fail2ban" },
  { value: "system", label: "Syslog" },
];

function statusColor(s: string) {
  if (s === "running") return "bg-green-600 text-white";
  if (s === "stopped") return "bg-destructive text-white";
  return "bg-secondary";
}

export default function VpsDetail() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const { data: vpsList } = useVpsList();
  const vps = vpsList?.find(v => v.id === id);

  const [selectedConfig, setSelectedConfig] = useState("nginx.conf");
  const [configContent, setConfigContent] = useState<string | null>(null);
  const [logType, setLogType] = useState("nginx_access");
  const [editingJail, setEditingJail] = useState<Jail | null>(null);
  const [ipSearch, setIpSearch] = useState("");
  const [logSearch, setLogSearch] = useState("");
  const [debouncedLogSearch, setDebouncedLogSearch] = useState("");
  const [selectedIpset, setSelectedIpset] = useState("");
  const [ipsetSearch, setIpsetSearch] = useState("");
  const [newIp, setNewIp] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedLogSearch(logSearch), 400);
    return () => clearTimeout(t);
  }, [logSearch]);


  const proxy = (path: string) => `/api/vps/${id}/proxy${path}`;

  const { data: services, isLoading: servicesLoading, refetch: refetchServices } = useQuery<ServiceStatus[]>({
    queryKey: [`vps-${id}-services`],
    queryFn: async () => { const r = await apiRequest("GET", proxy("/api/services")); return r.json(); },
    enabled: !!vps,
    refetchInterval: REFETCH,
  });

  const { data: systemInfo, refetch: refetchSystem } = useQuery<SystemInfo>({
    queryKey: [`vps-${id}-system`],
    queryFn: async () => { const r = await apiRequest("GET", proxy("/api/system")); return r.json(); },
    enabled: !!vps,
    refetchInterval: REFETCH,
  });

  const { data: bannedIps, isLoading: bannedLoading, refetch: refetchBanned } = useQuery<BannedIp[]>({
    queryKey: [`vps-${id}-banned`],
    queryFn: async () => { const r = await apiRequest("GET", proxy("/api/banned-ips")); return r.json(); },
    enabled: !!vps,
    refetchInterval: REFETCH,
  });

  const { data: logs, isLoading: logsLoading, refetch: refetchLogs } = useQuery<LogEntry[]>({
    queryKey: [`vps-${id}-logs-${logType}-${debouncedLogSearch}`],
    queryFn: async () => {
      const params = new URLSearchParams({ lines: "200" });
      if (debouncedLogSearch) params.set("grep", debouncedLogSearch);
      const r = await apiRequest("GET", proxy(`/api/logs/${logType}?${params}`));
      return r.json();
    },
    enabled: !!vps,
    refetchInterval: REFETCH,
  });

  const { data: ipsets, refetch: refetchIpsets } = useQuery<IpSetMeta[]>({
    queryKey: [`vps-${id}-ipsets`],
    queryFn: async () => { const r = await apiRequest("GET", proxy("/api/ipset")); return r.json(); },
    enabled: !!vps,
    refetchInterval: REFETCH,
  });

  const { data: ipsetDetail, isLoading: ipsetDetailLoading, refetch: refetchIpsetDetail } = useQuery<IpSetDetail>({
    queryKey: [`vps-${id}-ipset-${selectedIpset}`],
    queryFn: async () => { const r = await apiRequest("GET", proxy(`/api/ipset/${selectedIpset}`)); return r.json(); },
    enabled: !!vps && !!selectedIpset,
  });

  const { data: iptables, refetch: refetchIptables } = useQuery<IpTablesChain[]>({
    queryKey: [`vps-${id}-iptables`],
    queryFn: async () => { const r = await apiRequest("GET", proxy("/api/iptables")); return r.json(); },
    enabled: !!vps,
    refetchInterval: REFETCH,
  });

  useEffect(() => {
    if (ipsets?.length && !selectedIpset) setSelectedIpset(ipsets[0].name);
  }, [ipsets, selectedIpset]);

  const { data: jails, isLoading: jailsLoading, refetch: refetchJails } = useQuery<Jail[]>({
    queryKey: [`vps-${id}-jails`],
    queryFn: async () => { const r = await apiRequest("GET", proxy("/api/fail2ban/jails")); return r.json(); },
    enabled: !!vps,
    refetchInterval: REFETCH,
  });

  const { data: configData, isLoading: configLoading, refetch: refetchConfig } = useQuery<{ filename: string; content: string }>({
    queryKey: [`vps-${id}-config-${selectedConfig}`],
    queryFn: async () => { const r = await apiRequest("GET", proxy(`/api/config/${selectedConfig}`)); return r.json(); },
    enabled: !!vps,
  });

  // Keep textarea in sync with fetched data (only when not editing)
  if (configData && configContent === null) {
    setConfigContent(configData.content);
  }

  const serviceActionMutation = useMutation({
    mutationFn: async ({ service, action }: { service: string; action: string }) => {
      const r = await apiRequest("POST", proxy(`/api/services/${service}/action`), { action });
      return r.json();
    },
    onSuccess: () => { refetchServices(); toast({ title: "Azione eseguita" }); },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const unbanMutation = useMutation({
    mutationFn: async ({ ip, jail }: { ip: string; jail: string }) => {
      const r = await apiRequest("POST", proxy("/api/unban"), { ip, jail });
      return r.json();
    },
    onSuccess: () => { refetchBanned(); toast({ title: "IP sbloccato" }); },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const unbanAllMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", proxy("/api/unban-all"), {});
      return r.json();
    },
    onSuccess: (data: any) => {
      refetchBanned();
      toast({ title: "Tutti gli IP sbloccati", description: `${data.unbannedCount} IP sbloccati` });
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const addToIpsetMutation = useMutation({
    mutationFn: async ({ name, ip }: { name: string; ip: string }) => {
      const r = await apiRequest("POST", proxy(`/api/ipset/${name}/add`), { ip });
      return r.json();
    },
    onSuccess: () => { refetchIpsetDetail(); refetchIpsets(); setNewIp(""); toast({ title: "IP aggiunto all'ipset" }); },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const removeFromIpsetMutation = useMutation({
    mutationFn: async ({ name, ip }: { name: string; ip: string }) => {
      const r = await apiRequest("POST", proxy(`/api/ipset/${name}/remove`), { ip });
      return r.json();
    },
    onSuccess: () => { refetchIpsetDetail(); refetchIpsets(); toast({ title: "IP rimosso dall'ipset" }); },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const unbanFilteredMutation = useMutation({
    mutationFn: async (ips: BannedIp[]) => {
      for (const item of ips) {
        await apiRequest("POST", proxy("/api/unban"), { ip: item.ip, jail: item.jail });
      }
      return { unbannedCount: ips.length };
    },
    onSuccess: (data) => {
      refetchBanned();
      toast({ title: "IP sbloccati", description: `${data.unbannedCount} IP sbloccati` });
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const nginxTestMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", proxy("/api/nginx/test"), {});
      return r.json() as Promise<{ ok: boolean; output: string }>;
    },
    onSuccess: (data) => {
      toast({
        title: data.ok ? "nginx -t OK" : "nginx -t fallito",
        description: data.output.slice(0, 300),
        variant: data.ok ? "default" : "destructive",
      });
    },
  });

  const nginxReloadMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", proxy("/api/nginx/reload"), {});
      return r.json();
    },
    onSuccess: () => { refetchServices(); toast({ title: "nginx ricaricato" }); },
    onError: (e: any) => toast({ title: "Errore reload nginx", description: e.message, variant: "destructive" }),
  });

  const saveConfigMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", proxy(`/api/config/${selectedConfig}`), { content: configContent });
      return r.json();
    },
    onSuccess: () => toast({ title: "Configurazione salvata", description: selectedConfig }),
    onError: (e: any) => toast({ title: "Errore salvataggio", description: e.message, variant: "destructive" }),
  });

  const updateJailMutation = useMutation({
    mutationFn: async (jail: Jail) => {
      const r = await apiRequest("POST", proxy(`/api/fail2ban/jails/${jail.name}`), {
        config: { banTime: jail.banTime, maxRetry: jail.maxRetry, findTime: jail.findTime },
      });
      return r.json();
    },
    onSuccess: () => {
      refetchJails();
      setEditingJail(null);
      toast({ title: "Jail aggiornata" });
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  if (!vpsList) return <LoadingState message="Caricamento..." />;
  if (!vps) {
    return (
      <div className="space-y-4">
        <Link href="/"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4 mr-1" />Dashboard</Button></Link>
        <p className="text-muted-foreground">VPS non trovato.</p>
      </div>
    );
  }

  const filteredMembers = (ipsetDetail?.members || []).filter(ip =>
    !ipsetSearch || ip.includes(ipsetSearch)
  );

  const filteredBannedIps = (bannedIps || []).filter(item =>
    !ipSearch || item.ip.includes(ipSearch) || item.jail.toLowerCase().includes(ipSearch.toLowerCase())
  );

  const memPct = systemInfo ? Math.round((systemInfo.memory.used / systemInfo.memory.total) * 100) : 0;
  const online = vps.lastStatus === "online";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/">
          <Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4 mr-1" />Dashboard</Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold font-heading">{vps.name}</h1>
            <Badge className={online ? "bg-green-600 text-white" : "bg-destructive text-white"}>
              {online ? <><Wifi className="w-3 h-3 mr-1" />Online</> : <><WifiOff className="w-3 h-3 mr-1" />Offline</>}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground font-mono">{vps.host}:{vps.port}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { refetchServices(); refetchSystem(); refetchBanned(); refetchLogs(); refetchJails(); refetchIpsets(); refetchIpsetDetail(); refetchIptables(); }}>
          <RefreshCw className="w-4 h-4 mr-1" />Aggiorna
        </Button>
      </div>

      {/* System Info Cards */}
      {systemInfo && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1"><Server className="w-4 h-4" />Hostname</div>
              <p className="font-mono font-semibold">{systemInfo.hostname}</p>
              <p className="text-xs text-muted-foreground mt-1">{systemInfo.uptime}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1"><MemoryStick className="w-4 h-4" />Memoria</div>
              <p className="font-semibold">{memPct}%</p>
              <p className="text-xs text-muted-foreground">{systemInfo.memory.used}/{systemInfo.memory.total} MB</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1"><HardDrive className="w-4 h-4" />Disco</div>
              <p className="font-semibold">{systemInfo.disk.percent}</p>
              <p className="text-xs text-muted-foreground">{systemInfo.disk.used}/{systemInfo.disk.total}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1"><Cpu className="w-4 h-4" />Load avg</div>
              <p className="font-semibold">{systemInfo.load["1m"]}</p>
              <p className="text-xs text-muted-foreground">{systemInfo.load["5m"]} · {systemInfo.load["15m"]}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tabs */}
      <Tabs defaultValue="services">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="services">Servizi</TabsTrigger>
          <TabsTrigger value="banned">
            IP Bannati {bannedIps?.length ? <span className="ml-1 bg-destructive text-white text-xs rounded-full px-1.5">{bannedIps.length}</span> : ""}
          </TabsTrigger>
          <TabsTrigger value="fail2ban">Fail2ban Jail</TabsTrigger>
          <TabsTrigger value="configs">Configurazioni</TabsTrigger>
          <TabsTrigger value="logs">Log</TabsTrigger>
          <TabsTrigger value="ipset">IPSet / IPTables</TabsTrigger>
        </TabsList>

        {/* ── Servizi ── */}
        <TabsContent value="services" className="space-y-4 pt-4">
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="outline" onClick={() => nginxTestMutation.mutate()} disabled={nginxTestMutation.isPending}>
              <CheckCircle className="w-4 h-4 mr-1" />nginx -t
            </Button>
            <Button size="sm" variant="outline" onClick={() => nginxReloadMutation.mutate()} disabled={nginxReloadMutation.isPending}>
              <RotateCw className="w-4 h-4 mr-1" />Reload nginx
            </Button>
          </div>
          {servicesLoading ? <LoadingState message="Caricamento servizi..." /> : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {(services || []).map(svc => (
                <Card key={svc.name}>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base capitalize">{svc.name}</CardTitle>
                      <Badge className={statusColor(svc.status)}>{svc.status}</Badge>
                    </div>
                    {svc.uptime && <CardDescription className="text-xs">{svc.uptime}</CardDescription>}
                  </CardHeader>
                  <CardContent>
                    <div className="flex gap-2 flex-wrap">
                      {svc.status !== "running" && (
                        <Button size="sm" variant="outline" onClick={() => serviceActionMutation.mutate({ service: svc.name, action: "start" })} disabled={serviceActionMutation.isPending}>
                          <Play className="w-3 h-3 mr-1" />Start
                        </Button>
                      )}
                      {svc.status === "running" && (
                        <Button size="sm" variant="outline" onClick={() => serviceActionMutation.mutate({ service: svc.name, action: "stop" })} disabled={serviceActionMutation.isPending}>
                          <Square className="w-3 h-3 mr-1" />Stop
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => serviceActionMutation.mutate({ service: svc.name, action: "restart" })} disabled={serviceActionMutation.isPending}>
                        <RotateCw className="w-3 h-3 mr-1" />Restart
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── IP Bannati ── */}
        <TabsContent value="banned" className="pt-4">
          {bannedLoading ? <LoadingState message="Caricamento IP..." /> : (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <CardTitle className="flex items-center gap-2"><Shield className="w-4 h-4" />IP Bannati</CardTitle>
                    <CardDescription>{bannedIps?.length || 0} IP bannati attualmente</CardDescription>
                  </div>
                  {(bannedIps?.length ?? 0) > 0 && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => ipSearch ? unbanFilteredMutation.mutate(filteredBannedIps) : unbanAllMutation.mutate()}
                      disabled={ipSearch ? unbanFilteredMutation.isPending : unbanAllMutation.isPending}
                    >
                      <ShieldOff className="w-4 h-4 mr-1" />
                      {ipSearch ? `Sblocca filtrati (${filteredBannedIps.length})` : "Sblocca tutti"}
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {(bannedIps?.length ?? 0) > 0 && (
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Cerca IP..."
                      value={ipSearch}
                      onChange={e => setIpSearch(e.target.value)}
                      className="pl-8"
                    />
                    {ipSearch && (
                      <span className="absolute right-3 top-2.5 text-xs text-muted-foreground">
                        {filteredBannedIps.length} / {bannedIps?.length}
                      </span>
                    )}
                  </div>
                )}
                {!bannedIps?.length ? (
                  <p className="text-center text-muted-foreground py-8">Nessun IP bannato</p>
                ) : filteredBannedIps.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">Nessun risultato per "{ipSearch}"</p>
                ) : (
                  <div className="border rounded-md">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>IP</TableHead>
                          <TableHead>Jail</TableHead>
                          <TableHead>Ban time</TableHead>
                          <TableHead className="text-right">Azioni</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredBannedIps.map((item, i) => (
                          <TableRow key={i}>
                            <TableCell className="font-mono text-sm">{item.ip}</TableCell>
                            <TableCell><Badge variant="outline">{item.jail}</Badge></TableCell>
                            <TableCell className="text-sm text-muted-foreground">{new Date(item.banTime).toLocaleString("it-IT")}</TableCell>
                            <TableCell className="text-right">
                              <Button size="sm" variant="ghost" onClick={() => unbanMutation.mutate({ ip: item.ip, jail: item.jail })} disabled={unbanMutation.isPending}>
                                <ShieldOff className="w-4 h-4 mr-1" />Unban
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Fail2ban Jails ── */}
        <TabsContent value="fail2ban" className="pt-4 space-y-4">
          {jailsLoading ? <LoadingState message="Caricamento jail..." /> : (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Shield className="w-4 h-4" />Fail2ban Jails</CardTitle>
                <CardDescription>{jails?.length || 0} jail configurate</CardDescription>
              </CardHeader>
              <CardContent>
                {!jails?.length ? (
                  <p className="text-center text-muted-foreground py-8">Nessuna jail trovata</p>
                ) : editingJail ? (
                  <div className="space-y-4 max-w-sm">
                    <h3 className="font-semibold">Modifica jail: <span className="font-mono text-primary">{editingJail.name}</span></h3>
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs text-muted-foreground uppercase tracking-wide">Ban Time (secondi)</label>
                        <input
                          type="number"
                          className="w-full mt-1 px-3 py-1.5 text-sm border border-border rounded-md bg-background"
                          value={editingJail.banTime}
                          onChange={e => setEditingJail({ ...editingJail, banTime: parseInt(e.target.value) || 0 })}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground uppercase tracking-wide">Max Retry</label>
                        <input
                          type="number"
                          className="w-full mt-1 px-3 py-1.5 text-sm border border-border rounded-md bg-background"
                          value={editingJail.maxRetry}
                          onChange={e => setEditingJail({ ...editingJail, maxRetry: parseInt(e.target.value) || 0 })}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground uppercase tracking-wide">Find Time (secondi)</label>
                        <input
                          type="number"
                          className="w-full mt-1 px-3 py-1.5 text-sm border border-border rounded-md bg-background"
                          value={editingJail.findTime}
                          onChange={e => setEditingJail({ ...editingJail, findTime: parseInt(e.target.value) || 0 })}
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => updateJailMutation.mutate(editingJail)} disabled={updateJailMutation.isPending}>
                        <Save className="w-4 h-4 mr-1" />Salva
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setEditingJail(null)}>Annulla</Button>
                    </div>
                  </div>
                ) : (
                  <div className="border rounded-md">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Jail</TableHead>
                          <TableHead>Ban Time</TableHead>
                          <TableHead>Max Retry</TableHead>
                          <TableHead>Find Time</TableHead>
                          <TableHead className="text-right">Azioni</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {jails.map(jail => (
                          <TableRow key={jail.name}>
                            <TableCell className="font-mono text-sm">{jail.name}</TableCell>
                            <TableCell className="text-sm">{jail.banTime}s</TableCell>
                            <TableCell className="text-sm">{jail.maxRetry}</TableCell>
                            <TableCell className="text-sm">{jail.findTime}s</TableCell>
                            <TableCell className="text-right">
                              <Button size="sm" variant="ghost" onClick={() => setEditingJail({ ...jail })}>
                                <Settings className="w-4 h-4 mr-1" />Modifica
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Configurazioni ── */}
        <TabsContent value="configs" className="pt-4 space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <CardTitle className="flex items-center gap-2"><FileText className="w-4 h-4" />Editor Configurazioni</CardTitle>
                  <CardDescription>Modifica i file di configurazione del VPS remoto</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Select
                    value={selectedConfig}
                    onValueChange={v => { setSelectedConfig(v); setConfigContent(null); }}
                  >
                    <SelectTrigger className="w-56">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONFIG_FILES.map(f => (
                        <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" onClick={() => { setConfigContent(null); refetchConfig(); }}>
                    <RefreshCw className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {configLoading ? (
                <LoadingState message="Caricamento file..." />
              ) : (
                <>
                  <Textarea
                    value={configContent ?? ""}
                    onChange={e => setConfigContent(e.target.value)}
                    className="font-mono text-xs h-96 resize-y bg-muted"
                    placeholder="File vuoto o non trovato sul VPS"
                    spellCheck={false}
                  />
                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={() => saveConfigMutation.mutate()} disabled={saveConfigMutation.isPending}>
                      <Save className="w-4 h-4 mr-1" />
                      {saveConfigMutation.isPending ? "Salvataggio..." : "Salva"}
                    </Button>
                    {selectedConfig.includes("nginx") && (
                      <Button size="sm" variant="outline" onClick={() => nginxTestMutation.mutate()} disabled={nginxTestMutation.isPending}>
                        <CheckCircle className="w-4 h-4 mr-1" />nginx -t
                      </Button>
                    )}
                    {selectedConfig.includes("nginx") && (
                      <Button size="sm" variant="outline" onClick={() => nginxReloadMutation.mutate()} disabled={nginxReloadMutation.isPending}>
                        <RotateCw className="w-4 h-4 mr-1" />Reload nginx
                      </Button>
                    )}
                    <p className="text-xs text-muted-foreground ml-auto">
                      <AlertTriangle className="w-3 h-3 inline mr-1 text-yellow-500" />
                      I file nginx vengono validati con nginx -t prima del salvataggio
                    </p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Log ── */}
        <TabsContent value="logs" className="pt-4 space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <CardTitle className="flex items-center gap-2"><Activity className="w-4 h-4" />Log</CardTitle>
                <div className="flex items-center gap-2">
                  <Select value={logType} onValueChange={v => { setLogType(v); setLogSearch(""); }}>
                    <SelectTrigger className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LOG_TYPES.map(l => (
                        <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" onClick={() => refetchLogs()}>
                    <RefreshCw className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Cerca nei log..."
                  value={logSearch}
                  onChange={e => setLogSearch(e.target.value)}
                  className="pl-8"
                />
              </div>
              {logsLoading ? <LoadingState message="Caricamento log..." /> : (
                <div className="bg-muted rounded-md p-3 font-mono text-xs h-[32rem] overflow-y-auto space-y-0.5">
                  {(logs || []).map((entry, i) => (
                    <div
                      key={i}
                      className={
                        entry.level === "error" ? "text-red-400" :
                        entry.level === "warn" ? "text-yellow-400" :
                        "text-muted-foreground"
                      }
                    >
                      {entry.message}
                    </div>
                  ))}
                  {(!logs || logs.length === 0) && (
                    <p className="text-muted-foreground py-4 text-center">Nessun log disponibile</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        {/* ── IPSet / IPTables ── */}
        <TabsContent value="ipset" className="pt-4 space-y-4">

          {/* IPSet */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <CardTitle className="flex items-center gap-2"><Shield className="w-4 h-4" />IPSet</CardTitle>
                  <CardDescription>{ipsets?.length || 0} set configurati</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  {ipsets && ipsets.length > 0 && (
                    <Select value={selectedIpset} onValueChange={v => { setSelectedIpset(v); setIpsetSearch(""); setNewIp(""); }}>
                      <SelectTrigger className="w-52">
                        <SelectValue placeholder="Seleziona ipset..." />
                      </SelectTrigger>
                      <SelectContent>
                        {ipsets.map(s => (
                          <SelectItem key={s.name} value={s.name}>
                            {s.name} <span className="text-muted-foreground text-xs ml-1">({s.count})</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Button size="sm" variant="outline" onClick={() => { refetchIpsets(); refetchIpsetDetail(); }}>
                    <RefreshCw className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {!ipsets?.length ? (
                <p className="text-center text-muted-foreground py-8">Nessun ipset trovato</p>
              ) : !selectedIpset ? null : ipsetDetailLoading ? (
                <LoadingState message="Caricamento ipset..." />
              ) : (
                <>
                  {ipsetDetail && (
                    <div className="flex gap-4 text-sm text-muted-foreground mb-1">
                      <span>Tipo: <span className="font-mono text-foreground">{ipsetDetail.type}</span></span>
                      <span>Entries: <span className="font-semibold text-foreground">{ipsetDetail.members.length}</span></span>
                    </div>
                  )}

                  {/* Aggiungi IP */}
                  <div className="flex gap-2">
                    <Input
                      placeholder="IP da aggiungere (es. 1.2.3.4)"
                      value={newIp}
                      onChange={e => setNewIp(e.target.value)}
                      className="font-mono"
                      onKeyDown={e => e.key === "Enter" && newIp && addToIpsetMutation.mutate({ name: selectedIpset, ip: newIp })}
                    />
                    <Button
                      size="sm"
                      onClick={() => addToIpsetMutation.mutate({ name: selectedIpset, ip: newIp })}
                      disabled={!newIp || addToIpsetMutation.isPending}
                    >
                      <Plus className="w-4 h-4 mr-1" />Aggiungi
                    </Button>
                  </div>

                  {/* Ricerca */}
                  {(ipsetDetail?.members.length ?? 0) > 0 && (
                    <div className="relative">
                      <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                      <Input
                        placeholder="Cerca IP nell'ipset..."
                        value={ipsetSearch}
                        onChange={e => setIpsetSearch(e.target.value)}
                        className="pl-8"
                      />
                      {ipsetSearch && (
                        <span className="absolute right-3 top-2.5 text-xs text-muted-foreground">
                          {filteredMembers.length} / {ipsetDetail?.members.length}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Tabella members */}
                  {filteredMembers.length === 0 && ipsetSearch ? (
                    <p className="text-center text-muted-foreground py-6">Nessun risultato per "{ipsetSearch}"</p>
                  ) : filteredMembers.length === 0 ? (
                    <p className="text-center text-muted-foreground py-6">IPSet vuoto</p>
                  ) : (
                    <div className="border rounded-md max-h-80 overflow-y-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>IP</TableHead>
                            <TableHead className="text-right">Azioni</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {filteredMembers.map((ip, i) => (
                            <TableRow key={i}>
                              <TableCell className="font-mono text-sm">{ip}</TableCell>
                              <TableCell className="text-right">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => removeFromIpsetMutation.mutate({ name: selectedIpset, ip })}
                                  disabled={removeFromIpsetMutation.isPending}
                                >
                                  <Trash2 className="w-4 h-4 mr-1" />Rimuovi
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* IPTables */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2"><Network className="w-4 h-4" />IPTables</CardTitle>
                  <CardDescription>{iptables?.length || 0} chain</CardDescription>
                </div>
                <Button size="sm" variant="outline" onClick={() => refetchIptables()}>
                  <RefreshCw className="w-4 h-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {!iptables?.length ? (
                <p className="text-center text-muted-foreground py-8">Nessuna regola trovata</p>
              ) : (
                iptables.map(chain => (
                  <div key={chain.name}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-sm font-mono">{chain.name}</span>
                      <Badge variant="outline" className="text-xs">policy: {chain.policy}</Badge>
                      <span className="text-xs text-muted-foreground">{chain.rules.length} regole</span>
                    </div>
                    {chain.rules.length > 0 && (
                      <div className="bg-muted rounded-md p-2 font-mono text-xs overflow-x-auto space-y-0.5 max-h-48 overflow-y-auto">
                        {chain.rules.map((rule, i) => (
                          <div key={i} className={rule.toLowerCase().includes("drop") || rule.toLowerCase().includes("reject") ? "text-red-400" : "text-muted-foreground"}>
                            {rule}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

        </TabsContent>
      </Tabs>
    </div>
  );
}
