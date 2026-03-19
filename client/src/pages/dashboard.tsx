import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useVpsList, useVpsHealth, type VpsConfig } from "@/hooks/use-vps";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/loading-state";
import {
  Server, Wifi, WifiOff, Shield, Activity, RefreshCw,
  AlertTriangle, CheckCircle, XCircle, Search, ChevronRight,
  Radio, Cpu, MemoryStick, HardDrive,
} from "lucide-react";

interface BulkResult {
  vpsId: string;
  vpsName: string;
  success: boolean;
  data?: any;
  error?: string;
}

function useBulkStats() {
  return useQuery<BulkResult[]>({
    queryKey: ["bulk-stats"],
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/vps/bulk/get", { vpsIds: "all", path: "/api/stats" });
      return res.json();
    },
    refetchInterval: 60000,
    retry: false,
  });
}

function useBulkServices() {
  return useQuery<BulkResult[]>({
    queryKey: ["bulk-services"],
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/vps/bulk/get", { vpsIds: "all", path: "/api/services" });
      return res.json();
    },
    refetchInterval: 60000,
    retry: false,
  });
}

function useBulkNetbird() {
  return useQuery<BulkResult[]>({
    queryKey: ["bulk-netbird-dashboard"],
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/vps/bulk/get", { vpsIds: "all", path: "/api/netbird" });
      return res.json();
    },
    refetchInterval: 60000,
    retry: false,
  });
}

function useDashboardSystem() {
  return useQuery<{ memory: { totalMb: number; usedPct: number }; disk: { used: string; total: string; percent: string }; load: { "1m": number; "5m": number; "15m": number }; cpuCount: number }>({
    queryKey: ["dashboard-system"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/dashboard/system");
      return res.json();
    },
    refetchInterval: 30000,
  });
}

function ServiceBadge({ name, running }: { name: string; running: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-mono ${running ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}>
      {running ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      {name}
    </span>
  );
}

export default function Dashboard() {
  const [filter, setFilter] = useState<"all" | "online" | "offline">("all");
  const [search, setSearch] = useState("");

  const { data: vpsList, isLoading: vpsLoading, refetch: refetchVps } = useVpsList();
  const { data: healthMap, refetch: refetchHealth } = useVpsHealth();
  const { data: bulkStats, refetch: refetchStats } = useBulkStats();
  const { data: bulkServices, refetch: refetchServices } = useBulkServices();
  const { data: bulkNetbird, refetch: refetchNetbird } = useBulkNetbird();
  const { data: dashSystem, refetch: refetchSystem } = useDashboardSystem();

  const handleRefresh = () => {
    refetchVps(); refetchHealth(); refetchStats(); refetchServices(); refetchNetbird(); refetchSystem();
  };

  if (vpsLoading) return <LoadingState message="Caricamento VPS..." />;

  const list = vpsList || [];

  // Build lookup maps
  const statsMap: Record<string, any> = {};
  const servicesMap: Record<string, any[]> = {};
  const netbirdMap: Record<string, { running: boolean; connected: boolean }> = {};
  (bulkStats || []).forEach(r => { if (r.success && r.data) statsMap[r.vpsId] = r.data; });
  (bulkServices || []).forEach(r => { if (r.success && r.data) servicesMap[r.vpsId] = r.data; });
  (bulkNetbird || []).forEach(r => { if (r.success && r.data) netbirdMap[r.vpsId] = r.data; });

  // Filter & search
  const filtered = list.filter(vps => {
    const online = healthMap?.[vps.id] ?? false;
    if (filter === "online" && !online) return false;
    if (filter === "offline" && online) return false;
    if (search) {
      const q = search.toLowerCase();
      return vps.name.toLowerCase().includes(q) || vps.host.toLowerCase().includes(q) || vps.tags?.some(t => t.toLowerCase().includes(q));
    }
    return true;
  });

  // Summary counts
  const totalOnline = list.filter(v => healthMap?.[v.id]).length;
  const totalOffline = list.length - totalOnline;
  const totalBans = Object.values(statsMap).reduce((sum, s) => sum + (s?.totalBans24h || 0), 0);
  const totalConnections = Object.values(statsMap).reduce((sum, s) => sum + (s?.activeConnections || 0), 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-heading font-bold tracking-tight">Fleet Overview</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{list.length} VPS configurati · aggiornamento ogni 60s</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh}>
          <RefreshCw className="w-4 h-4 mr-1" />Aggiorna
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="border-card-border">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><Wifi className="w-3.5 h-3.5 text-green-500" />Online</div>
            <p className="text-2xl font-heading font-bold text-green-500">{totalOnline}</p>
          </CardContent>
        </Card>
        <Card className="border-card-border">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><WifiOff className="w-3.5 h-3.5 text-red-500" />Offline</div>
            <p className="text-2xl font-heading font-bold text-red-500">{totalOffline}</p>
          </CardContent>
        </Card>
        <Card className="border-card-border">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><Shield className="w-3.5 h-3.5" />Ban attivi</div>
            <p className="text-2xl font-heading font-bold">{totalBans}</p>
          </CardContent>
        </Card>
        <Card className="border-card-border">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><Activity className="w-3.5 h-3.5" />Connessioni :8880</div>
            <p className="text-2xl font-heading font-bold">{totalConnections}</p>
          </CardContent>
        </Card>
      </div>

      {/* Dashboard host health */}
      {dashSystem && (
        <Card className="border-card-border">
          <CardContent className="pt-4">
            <p className="text-xs font-heading uppercase tracking-wide text-muted-foreground mb-3">Dashboard Host</p>
            <div className="grid grid-cols-3 gap-4">
              <div className="flex items-center gap-2">
                <MemoryStick className="w-4 h-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">RAM</p>
                  <p className="text-sm font-semibold">{dashSystem.memory.usedPct}% <span className="text-xs text-muted-foreground font-normal">/ {dashSystem.memory.totalMb} MB</span></p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">Disco</p>
                  <p className="text-sm font-semibold">{dashSystem.disk.percent} <span className="text-xs text-muted-foreground font-normal">{dashSystem.disk.used}/{dashSystem.disk.total}</span></p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">Load avg</p>
                  <p className="text-sm font-semibold">{dashSystem.load["1m"]} <span className="text-xs text-muted-foreground font-normal">{dashSystem.load["5m"]} · {dashSystem.load["15m"]}</span></p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters & search */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-md border border-border p-1">
          {(["all", "online", "offline"] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors capitalize ${filter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {f === "all" ? "Tutti" : f === "online" ? "Online" : "Offline"}
              {f === "online" && <span className="ml-1 text-green-400">({totalOnline})</span>}
              {f === "offline" && <span className="ml-1 text-red-400">({totalOffline})</span>}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Cerca per nome, IP, tag..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
      </div>

      {/* VPS Grid */}
      {list.length === 0 ? (
        <Card className="border-card-border">
          <CardContent className="py-16 text-center text-muted-foreground">
            <Server className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="font-medium">Nessun VPS configurato</p>
            <p className="text-sm mt-1">Vai su <Link href="/vps" className="text-primary underline">Gestione VPS</Link> per aggiungerne uno</p>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <div className="text-center text-muted-foreground py-12">
          <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p>Nessun VPS corrisponde ai filtri</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map(vps => {
            const online = healthMap?.[vps.id] ?? false;
            const stats = statsMap[vps.id];
            const services: any[] = servicesMap[vps.id] || [];
            const nginx = services.find(s => s.name === "nginx");
            const fail2ban = services.find(s => s.name === "fail2ban");
            const mariadb = services.find(s => s.name === "mariadb");
            const nb = netbirdMap[vps.id];

            return (
              <Link key={vps.id} href={`/vps/${vps.id}`}>
                <Card className={`border-card-border cursor-pointer hover:border-primary/50 transition-colors ${!online ? "opacity-70" : ""}`}>
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <CardTitle className="text-base font-heading truncate">{vps.name}</CardTitle>
                        <p className="text-xs font-mono text-muted-foreground truncate mt-0.5">{vps.host}:{vps.port}</p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Badge
                          className={online ? "bg-green-600 text-white" : "bg-destructive text-white"}
                        >
                          {online
                            ? <><Wifi className="w-3 h-3 mr-1" />Online</>
                            : <><WifiOff className="w-3 h-3 mr-1" />Offline</>
                          }
                        </Badge>
                        <ChevronRight className="w-4 h-4 text-muted-foreground" />
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {/* Services */}
                    {services.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {nginx && <ServiceBadge name="nginx" running={nginx.status === "running"} />}
                        {fail2ban && <ServiceBadge name="fail2ban" running={fail2ban.status === "running"} />}
                        {mariadb && <ServiceBadge name="mariadb" running={mariadb.status === "running"} />}
                        {nb !== undefined && (
                          <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-mono ${nb.connected ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}>
                            <Radio className="w-3 h-3" />netbird
                          </span>
                        )}
                      </div>
                    ) : online ? (
                      <div className="flex flex-wrap gap-1.5">
                        <span className="text-xs text-muted-foreground">Caricamento servizi...</span>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        <span className="text-xs text-muted-foreground italic">Non raggiungibile</span>
                      </div>
                    )}

                    {/* Stats */}
                    <div className="grid grid-cols-2 gap-2 pt-1 border-t border-border/40">
                      <div>
                        <p className="text-xs text-muted-foreground">Ban attivi</p>
                        <p className="text-sm font-semibold font-heading">
                          {stats ? stats.totalBans24h : <span className="text-muted-foreground">—</span>}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Connessioni</p>
                        <p className="text-sm font-semibold font-heading">
                          {stats ? stats.activeConnections : <span className="text-muted-foreground">—</span>}
                        </p>
                      </div>
                    </div>

                    {/* Tags */}
                    {vps.tags && vps.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {vps.tags.map(tag => (
                          <span key={tag} className="text-xs bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded">{tag}</span>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
