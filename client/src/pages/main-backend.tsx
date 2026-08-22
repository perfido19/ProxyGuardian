import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/loading-state";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CheckCircle, XCircle, RotateCw, Server, Cpu, HardDrive, MemoryStick } from "lucide-react";

interface MainService { name: string; status: string; }
interface MainSystem {
  vpsId: string;
  vpsName: string;
  load: { "1m": number; "5m": number; "15m": number };
  memory: { totalMb: number; usedMb: number; availableMb: number };
  disk: { total: string; used: string; available: string; percent: string };
  services: MainService[];
  updatedAt: string;
}

const SERVICE_LABELS: Record<string, string> = {
  nginx: "nginx",
  mariadb: "MariaDB",
  fail2ban: "fail2ban",
  crowdsec: "CrowdSec",
  "crowdsec-firewall-bouncer": "CrowdSec Bouncer",
  xtreamcodes: "XtreamCodes",
};

const RESTARTABLE = new Set(["nginx", "fail2ban"]);

function useMainSystem() {
  return useQuery<MainSystem>({
    queryKey: ["main-system"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/main/system");
      return r.json();
    },
    refetchInterval: 30000,
  });
}

function StatusDot({ active }: { active: boolean }) {
  return active
    ? <CheckCircle className="w-4 h-4 text-green-500 inline" />
    : <XCircle className="w-4 h-4 text-red-500 inline" />;
}

export default function MainBackend() {
  const { toast } = useToast();
  const { data, isLoading, refetch } = useMainSystem();
  const [confirmService, setConfirmService] = useState<string | null>(null);

  const restartMutation = useMutation({
    mutationFn: async (name: string) => {
      const r = await apiRequest("POST", `/api/main/service/${name}/restart`, {});
      if (!r.ok) throw new Error((await r.json()).error || "Riavvio fallito");
      return r.json();
    },
    onSuccess: (data, name) => {
      toast({ title: `${SERVICE_LABELS[name] || name} riavviato`, description: `Stato: ${data.status}` });
      queryClient.invalidateQueries({ queryKey: ["main-system"] });
    },
    onError: (e: any) => {
      toast({ title: "Errore riavvio", description: e.message, variant: "destructive" });
    },
    onSettled: () => setConfirmService(null),
  });

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-6 p-6" data-testid="page-main-backend">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Server className="w-6 h-6" /> Main Backend
          </h1>
          <p className="text-muted-foreground text-sm">
            Server XtreamCodes centrale — gestito via SSH diretto, non ha l'agent ProxyGuardian.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-main">
          <RotateCw className="w-4 h-4 mr-2" /> Aggiorna
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><Cpu className="w-4 h-4" /> Load Average</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-mono" data-testid="text-load">
              {data?.load["1m"]} / {data?.load["5m"]} / {data?.load["15m"]}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><MemoryStick className="w-4 h-4" /> RAM</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-mono" data-testid="text-memory">
              {data && `${data.memory.usedMb} MB / ${data.memory.totalMb} MB`}
            </div>
            <div className="text-xs text-muted-foreground">{data?.memory.availableMb} MB disponibili</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><HardDrive className="w-4 h-4" /> Disco</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-mono" data-testid="text-disk">
              {data && `${data.disk.used} / ${data.disk.total} (${data.disk.percent})`}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Servizi</CardTitle>
          <CardDescription>Stato in tempo reale (SSH diretto). Riavvio disponibile solo per nginx (reload a caldo del binario XtreamCodes, non il servizio di sistema) e fail2ban.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {data?.services.map((svc) => {
            const active = svc.status === "active";
            const canRestart = RESTARTABLE.has(svc.name);
            return (
              <div
                key={svc.name}
                className="flex items-center justify-between border rounded-md p-3"
                data-testid={`row-service-${svc.name}`}
              >
                <div className="flex items-center gap-3">
                  <StatusDot active={active} />
                  <span className="font-medium">{SERVICE_LABELS[svc.name] || svc.name}</span>
                  <Badge variant={active ? "default" : "destructive"}>{svc.status}</Badge>
                </div>
                {canRestart && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={restartMutation.isPending}
                    onClick={() => setConfirmService(svc.name)}
                    data-testid={`button-restart-${svc.name}`}
                  >
                    <RotateCw className="w-4 h-4 mr-2" /> Riavvia
                  </Button>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <AlertDialog open={!!confirmService} onOpenChange={(open) => !open && setConfirmService(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Riavviare {confirmService && (SERVICE_LABELS[confirmService] || confirmService)}?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmService === "nginx"
                ? <>Reload a caldo del nginx XtreamCodes su <strong>main</strong> (server centrale, traffico live) — nessuna interruzione se la config e' valida. Confermi?</>
                : <>Interrompe brevemente il servizio su <strong>main</strong> (server centrale, traffico live). Confermi?</>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => confirmService && restartMutation.mutate(confirmService)}
            >
              Riavvia
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
