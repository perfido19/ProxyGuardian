import { useParams, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useVpsList } from "@/hooks/use-vps";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LoadingState } from "@/components/loading-state";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft, RefreshCw, Server, Shield, Activity,
  HardDrive, Cpu, MemoryStick, CheckCircle, XCircle,
  Play, Square, RotateCw, ShieldOff, Wifi,
} from "lucide-react";

interface ServiceStatus {
  name: string;
  status: string;
  pid?: number;
  uptime?: string;
}

interface BannedIp {
  ip: string;
  jail: string;
  banTime: string;
}

interface LogEntry {
  id: number;
  timestamp: string;
  level: string;
  message: string;
  source: string;
}

interface SystemInfo {
  uptime: string;
  hostname: string;
  memory: { total: number; used: number; free: number };
  disk: { total: string; used: string; free: string; percent: string };
  load: { "1m": number; "5m": number; "15m": number };
}

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

  // Proxy requests to this specific VPS
  const proxy = (path: string) => `/api/vps/${id}/proxy${path}`;

  const { data: services, isLoading: servicesLoading, refetch: refetchServices } = useQuery<ServiceStatus[]>({
    queryKey: [`vps-${id}-services`],
    queryFn: async () => {
      const res = await apiRequest("GET", proxy("/api/services"));
      return res.json();
    },
    enabled: !!vps,
    refetchInterval: 15000,
  });

  const { data: systemInfo, refetch: refetchSystem } = useQuery<SystemInfo>({
    queryKey: [`vps-${id}-system`],
    queryFn: async () => {
      const res = await apiRequest("GET", proxy("/api/system"));
      return res.json();
    },
    enabled: !!vps,
    refetchInterval: 30000,
  });

  const { data: bannedIps, isLoading: bannedLoading, refetch: refetchBanned } = useQuery<BannedIp[]>({
    queryKey: [`vps-${id}-banned`],
    queryFn: async () => {
      const res = await apiRequest("GET", proxy("/api/banned-ips"));
      return res.json();
    },
    enabled: !!vps,
    refetchInterval: 20000,
  });

  const { data: logs, isLoading: logsLoading, refetch: refetchLogs } = useQuery<LogEntry[]>({
    queryKey: [`vps-${id}-logs`],
    queryFn: async () => {
      const res = await apiRequest("GET", proxy("/api/logs/nginx_access?lines=100"));
      return res.json();
    },
    enabled: !!vps,
  });

  const serviceActionMutation = useMutation({
    mutationFn: async ({ service, action }: { service: string; action: string }) => {
      const res = await apiRequest("POST", `/api/vps/${id}/proxy/api/services/${service}/action`, { action });
      return res.json();
    },
    onSuccess: () => {
      refetchServices();
      toast({ title: "Azione eseguita" });
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const unbanMutation = useMutation({
    mutationFn: async ({ ip, jail }: { ip: string; jail: string }) => {
      const res = await apiRequest("POST", `/api/vps/${id}/proxy/api/unban`, { ip, jail });
      return res.json();
    },
    onSuccess: () => {
      refetchBanned();
      toast({ title: "IP sbloccato" });
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const nginxTestMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/vps/${id}/proxy/api/nginx/test`, {});
      return res.json() as Promise<{ ok: boolean; output: string }>;
    },
    onSuccess: (data) => {
      toast({
        title: data.ok ? "nginx -t OK" : "nginx -t fallito",
        description: data.output.slice(0, 200),
        variant: data.ok ? "default" : "destructive",
      });
    },
  });

  const nginxReloadMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/vps/${id}/proxy/api/nginx/reload`, {});
      return res.json();
    },
    onSuccess: () => { refetchServices(); toast({ title: "nginx ricaricato" }); },
    onError: (e: any) => toast({ title: "Errore reload nginx", description: e.message, variant: "destructive" }),
  });

  if (!vpsList) return <LoadingState message="Caricamento..." />;
  if (!vps) {
    return (
      <div className="space-y-4">
        <Link href="/vps"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4 mr-1" />VPS</Button></Link>
        <p className="text-muted-foreground">VPS non trovato.</p>
      </div>
    );
  }

  const memPct = systemInfo ? Math.round((systemInfo.memory.used / systemInfo.memory.total) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/vps">
          <Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4 mr-1" />VPS</Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{vps.name}</h1>
            <Badge variant={vps.lastStatus === "online" ? "default" : vps.lastStatus === "offline" ? "destructive" : "outline"}
              className={vps.lastStatus === "online" ? "bg-green-600" : ""}>
              {vps.lastStatus === "online" ? <><Wifi className="w-3 h-3 mr-1" />Online</> : vps.lastStatus || "Sconosciuto"}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground font-mono">{vps.host}:{vps.port}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { refetchServices(); refetchSystem(); refetchBanned(); }}>
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
        <TabsList>
          <TabsTrigger value="services">Servizi</TabsTrigger>
          <TabsTrigger value="banned">IP Bannati {bannedIps?.length ? `(${bannedIps.length})` : ""}</TabsTrigger>
          <TabsTrigger value="logs">Log</TabsTrigger>
        </TabsList>

        {/* Servizi */}
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

        {/* IP Bannati */}
        <TabsContent value="banned" className="pt-4">
          {bannedLoading ? <LoadingState message="Caricamento IP..." /> : (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Shield className="w-4 h-4" />IP Bannati</CardTitle>
                <CardDescription>{bannedIps?.length || 0} IP bannati</CardDescription>
              </CardHeader>
              <CardContent>
                {!bannedIps?.length ? (
                  <p className="text-center text-muted-foreground py-8">Nessun IP bannato</p>
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
                        {bannedIps.map((item, i) => (
                          <TableRow key={i}>
                            <TableCell className="font-mono">{item.ip}</TableCell>
                            <TableCell><Badge variant="outline">{item.jail}</Badge></TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {new Date(item.banTime).toLocaleString("it-IT")}
                            </TableCell>
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

        {/* Log */}
        <TabsContent value="logs" className="pt-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Log nginx access</CardTitle>
                <Button size="sm" variant="outline" onClick={() => refetchLogs()}><RefreshCw className="w-4 h-4" /></Button>
              </div>
            </CardHeader>
            <CardContent>
              {logsLoading ? <LoadingState message="Caricamento log..." /> : (
                <div className="bg-muted rounded-md p-3 font-mono text-xs h-96 overflow-y-auto space-y-0.5">
                  {(logs || []).map((entry, i) => (
                    <div key={i} className={`${entry.level === "error" ? "text-red-400" : entry.level === "warn" ? "text-yellow-400" : "text-muted-foreground"}`}>
                      {entry.message}
                    </div>
                  ))}
                  {(!logs || logs.length === 0) && <p className="text-muted-foreground">Nessun log disponibile</p>}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
