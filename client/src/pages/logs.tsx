import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { LogViewer } from "@/components/log-viewer";
import { LoadingState } from "@/components/loading-state";
import type { LogEntry } from "@shared/schema";

export default function Logs() {
  const { data: nginxAccessLogs, isLoading: accessLoading } = useQuery<LogEntry[]>({
    queryKey: ['/api/logs/nginx-access'],
    refetchInterval: 3000, // Refresh every 3 seconds for real-time
  });

  const { data: nginxErrorLogs, isLoading: errorLoading } = useQuery<LogEntry[]>({
    queryKey: ['/api/logs/nginx-error'],
    refetchInterval: 3000,
  });

  const { data: fail2banLogs, isLoading: fail2banLoading } = useQuery<LogEntry[]>({
    queryKey: ['/api/logs/fail2ban'],
    refetchInterval: 3000,
  });

  const { data: modsecLogs, isLoading: modsecLoading } = useQuery<LogEntry[]>({
    queryKey: ['/api/logs/modsec'],
    refetchInterval: 3000,
  });

  const isAnyLoading = accessLoading && errorLoading && fail2banLoading && modsecLoading;

  if (isAnyLoading) {
    return <LoadingState message="Caricamento log..." />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Visualizzatore Log</h1>
        <p className="text-muted-foreground">
          Monitora i log del sistema in tempo reale
        </p>
      </div>

      <Tabs defaultValue="nginx-access">
        <TabsList className="grid w-full grid-cols-4" data-testid="tabs-logs">
          <TabsTrigger value="nginx-access" data-testid="tab-nginx-access">
            Nginx Access
          </TabsTrigger>
          <TabsTrigger value="nginx-error" data-testid="tab-nginx-error">
            Nginx Error
          </TabsTrigger>
          <TabsTrigger value="fail2ban" data-testid="tab-fail2ban">
            Fail2ban
          </TabsTrigger>
          <TabsTrigger value="modsec" data-testid="tab-modsec">
            ModSecurity
          </TabsTrigger>
        </TabsList>

        <TabsContent value="nginx-access" className="space-y-4">
          <Card>
            <CardContent className="p-6">
              <LogViewer
                logs={nginxAccessLogs || []}
                title="Nginx Access Log"
                testId="nginx-access"
              />
            </CardContent>
          </Card>
          <div className="text-sm text-muted-foreground">
            <p className="font-medium mb-1">Percorso: /var/log/nginx/access.log</p>
            <p>Registra tutte le richieste HTTP ricevute dal server nginx.</p>
          </div>
        </TabsContent>

        <TabsContent value="nginx-error" className="space-y-4">
          <Card>
            <CardContent className="p-6">
              <LogViewer
                logs={nginxErrorLogs || []}
                title="Nginx Error Log"
                testId="nginx-error"
              />
            </CardContent>
          </Card>
          <div className="text-sm text-muted-foreground">
            <p className="font-medium mb-1">Percorso: /var/log/nginx/error.log</p>
            <p>Contiene errori e warning del server nginx, inclusi rate limiting violations.</p>
          </div>
        </TabsContent>

        <TabsContent value="fail2ban" className="space-y-4">
          <Card>
            <CardContent className="p-6">
              <LogViewer
                logs={fail2banLogs || []}
                title="Fail2ban Log"
                testId="fail2ban"
              />
            </CardContent>
          </Card>
          <div className="text-sm text-muted-foreground">
            <p className="font-medium mb-1">Percorso: /var/log/fail2ban.log</p>
            <p>Registra le azioni di fail2ban: ban, unban, rilevamento pattern.</p>
          </div>
        </TabsContent>

        <TabsContent value="modsec" className="space-y-4">
          <Card>
            <CardContent className="p-6">
              <LogViewer
                logs={modsecLogs || []}
                title="ModSecurity Audit Log"
                testId="modsec"
              />
            </CardContent>
          </Card>
          <div className="text-sm text-muted-foreground">
            <p className="font-medium mb-1">Percorso: /opt/log/modsec_audit.log</p>
            <p>Audit log di ModSecurity con dettagli sulle richieste bloccate.</p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
