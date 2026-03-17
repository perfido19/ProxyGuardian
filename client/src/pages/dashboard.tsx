import { useQuery, useMutation } from "@tanstack/react-query";
import { ServiceStatusCard } from "@/components/service-status-card";
import { StatCard } from "@/components/stat-card";
import { BannedIpsTable } from "@/components/banned-ips-table";
import { LoadingState } from "@/components/loading-state";
import { Shield, Activity, Globe, TrendingUp, ShieldOff } from "lucide-react";
import type { Service, Stats, BannedIp } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export default function Dashboard() {
  const { toast } = useToast();

  const { data: services, isLoading: servicesLoading } = useQuery<Service[]>({
    queryKey: ['/api/services'],
    refetchInterval: 5000, // Refresh every 5 seconds
  });

  const { data: stats, isLoading: statsLoading } = useQuery<Stats>({
    queryKey: ['/api/stats'],
    refetchInterval: 10000, // Refresh every 10 seconds
  });

  const { data: bannedIps, isLoading: bannedIpsLoading } = useQuery<BannedIp[]>({
    queryKey: ['/api/banned-ips'],
    refetchInterval: 5000,
  });

  const serviceActionMutation = useMutation({
    mutationFn: async ({ service, action }: { service: string; action: string }) => {
      const res = await apiRequest('POST', '/api/services/action', { service, action });
      return res.json() as Promise<{ success: boolean; name: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/services'] });
      toast({
        title: "Azione completata",
        description: `Servizio ${data.name} aggiornato con successo`,
      });
    },
    onError: () => {
      toast({
        title: "Errore",
        description: "Impossibile eseguire l'azione sul servizio",
        variant: "destructive",
      });
    },
  });

  const unbanMutation = useMutation({
    mutationFn: async ({ ip, jail }: { ip: string; jail: string }) => {
      const res = await apiRequest('POST', '/api/unban', { ip, jail });
      return res.json() as Promise<{ success: boolean; message: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/banned-ips'] });
      queryClient.invalidateQueries({ queryKey: ['/api/stats'] });
      toast({
        title: "IP Sbloccato",
        description: data.message,
      });
    },
    onError: () => {
      toast({
        title: "Errore",
        description: "Impossibile sbloccare l'IP",
        variant: "destructive",
      });
    },
  });

  const unbanAllMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/unban-all', {});
      return res.json() as Promise<{ 
        message: string; 
        unbannedCount: number; 
        jailsProcessed: number;
      }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/banned-ips'] });
      queryClient.invalidateQueries({ queryKey: ['/api/stats'] });
      toast({
        title: "Tutti gli IP Sbloccati",
        description: data.message,
      });
    },
    onError: () => {
      toast({
        title: "Errore",
        description: "Impossibile sbloccare tutti gli IP",
        variant: "destructive",
      });
    },
  });

  const handleServiceAction = (service: string, action: string) => {
    serviceActionMutation.mutate({ service, action });
  };

  const handleUnban = (ip: string, jail: string) => {
    unbanMutation.mutate({ ip, jail });
  };

  if (servicesLoading || statsLoading) {
    return <LoadingState message="Caricamento dashboard..." />;
  }

  const displayStats = stats || {
    totalBans24h: 0,
    activeConnections: 0,
    blockedCountries: 0,
    totalRequests24h: 0,
    topBannedIps: [],
    bansByCountry: [],
    banTimeline: [],
  };

  const displayServices = services || [];
  const displayBannedIps = bannedIps || [];

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-2xl font-heading font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Panoramica generale del sistema e dei servizi
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Ban Totali (24h)"
          value={displayStats.totalBans24h}
          icon={Shield}
          testId="stat-total-bans"
        />
        <StatCard
          title="Connessioni Attive"
          value={displayStats.activeConnections}
          icon={Activity}
          testId="stat-active-connections"
        />
        <StatCard
          title="Paesi Bloccati"
          value={displayStats.blockedCountries}
          icon={Globe}
          testId="stat-blocked-countries"
        />
        <StatCard
          title="Richieste (24h)"
          value={displayStats.totalRequests24h.toLocaleString()}
          icon={TrendingUp}
          testId="stat-total-requests"
        />
      </div>

      {/* Services Status */}
      <div>
        <h2 className="text-xs font-heading font-semibold tracking-[0.12em] uppercase text-muted-foreground mb-3">Stato Servizi</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {displayServices.map((service) => (
            <ServiceStatusCard
              key={service.name}
              service={service}
              onAction={handleServiceAction}
              isLoading={serviceActionMutation.isPending}
            />
          ))}
        </div>
      </div>

      {/* Charts and Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Ban Timeline Chart */}
        <Card className="lg:col-span-2 border-card-border">
          <CardHeader>
            <CardTitle className="font-heading text-sm tracking-wide uppercase text-muted-foreground">Andamento Ban (24h)</CardTitle>
          </CardHeader>
          <CardContent>
            {displayStats.banTimeline.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={displayStats.banTimeline}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="time" className="text-xs" />
                  <YAxis className="text-xs" />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '6px',
                    }}
                  />
                  <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-64 text-muted-foreground">
                Nessun dato disponibile
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top Banned IPs */}
        <Card className="border-card-border">
          <CardHeader>
            <CardTitle className="font-heading text-sm tracking-wide uppercase text-muted-foreground">Top IP Bannati</CardTitle>
          </CardHeader>
          <CardContent>
            {displayStats.topBannedIps.length > 0 ? (
              <div className="space-y-2.5">
                {displayStats.topBannedIps.slice(0, 5).map((item, idx) => (
                  <div key={idx} className="flex items-center justify-between py-1 border-b border-border/40 last:border-0" data-testid={`top-ip-${idx}`}>
                    <span className="font-mono text-xs text-foreground/80">{item.ip}</span>
                    <span className="text-xs font-heading font-semibold text-primary">
                      {item.count}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
                Nessun dato disponibile
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent Banned IPs */}
      <div>
        <Card className="border-card-border">
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle className="font-heading text-sm tracking-wide uppercase text-muted-foreground">IP Bannati Recenti</CardTitle>
                <CardDescription>
                  {displayBannedIps.length} IP attualmente bannati
                </CardDescription>
              </div>
              {displayBannedIps.length > 0 && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button 
                      variant="destructive" 
                      size="sm"
                      disabled={unbanAllMutation.isPending}
                      data-testid="button-unban-all"
                    >
                      <ShieldOff className="h-4 w-4 mr-2" />
                      {unbanAllMutation.isPending ? "Sblocco..." : "Sblocca Tutti"}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Conferma Sblocco Totale</AlertDialogTitle>
                      <AlertDialogDescription>
                        Sei sicuro di voler sbloccare <strong>tutti i {displayBannedIps.length} IP bannati</strong> da tutte le jail?
                        Questa azione non può essere annullata.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel data-testid="button-cancel-unban-all">Annulla</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => unbanAllMutation.mutate()}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        data-testid="button-confirm-unban-all"
                      >
                        Sblocca Tutti
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <BannedIpsTable
              bannedIps={displayBannedIps.slice(0, 10)}
              onUnban={handleUnban}
              isUnbanning={unbanMutation.isPending}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
