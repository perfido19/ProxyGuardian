import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVpsList, useVpsHealth } from "@/hooks/use-vps";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LoadingState } from "@/components/loading-state";
import { RefreshCw, Server, Search, X } from "lucide-react";

interface LogEntry { id: number; timestamp: string; level: string; message: string; source: string; }

const LOG_TYPES = [
  { value: "nginx_access", label: "Nginx Access" },
  { value: "nginx_error", label: "Nginx Error" },
  { value: "fail2ban", label: "Fail2ban" },
  { value: "system", label: "Syslog" },
];

function LogPane({ vpsId, logType }: { vpsId: string; logType: string }) {
  const [search, setSearch] = useState("");

  const { data: logs, isLoading, refetch } = useQuery<LogEntry[]>({
    queryKey: [`logs-${vpsId}-${logType}`],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/vps/${vpsId}/proxy/api/logs/${logType}?lines=300`);
      return r.json();
    },
    refetchInterval: 60000,
    enabled: !!vpsId,
  });

  const filtered = search
    ? (logs || []).filter(e => e.message.toLowerCase().includes(search.toLowerCase()))
    : (logs || []);

  return (
    <Card className="border-card-border">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">
            {LOG_TYPES.find(l => l.value === logType)?.label}
          </CardTitle>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Filtra righe..."
                className="h-7 pl-7 pr-7 text-xs w-48 font-mono"
              />
              {search && (
                <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2">
                  <X className="w-3 h-3 text-muted-foreground hover:text-foreground" />
                </button>
              )}
            </div>
            <Button size="sm" variant="ghost" onClick={() => refetch()}>
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingState message="Caricamento log..." />
        ) : (
          <>
            {search && (
              <p className="text-xs text-muted-foreground mb-2">{filtered.length} risultati su {(logs || []).length} righe</p>
            )}
            <div className="bg-muted rounded-md p-3 font-mono text-xs h-[36rem] overflow-y-auto space-y-0.5">
              {filtered.map((entry, i) => (
                <div
                  key={i}
                  className={
                    entry.level === "error" ? "text-red-400" :
                    entry.level === "warn" ? "text-yellow-400" :
                    "text-muted-foreground"
                  }
                >
                  {search ? (
                    <HighlightedLine text={entry.message} query={search} />
                  ) : entry.message}
                </div>
              ))}
              {filtered.length === 0 && (
                <p className="text-muted-foreground py-4 text-center">
                  {search ? "Nessuna riga corrisponde alla ricerca" : "Nessun log disponibile"}
                </p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function HighlightedLine({ text, query }: { text: string; query: string }) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-400/30 text-yellow-200 rounded-sm px-0.5">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export default function Logs() {
  const { data: vpsList } = useVpsList();
  const { data: healthMap } = useVpsHealth();
  const [selectedVpsId, setSelectedVpsId] = useState<string>("");

  const onlineVps = vpsList?.filter(v => healthMap?.[v.id]) ?? [];
  const effectiveVpsId = selectedVpsId || onlineVps[0]?.id || "";
  const selectedVps = vpsList?.find(v => v.id === effectiveVpsId);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-heading font-bold tracking-tight">Log</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Visualizza i log nginx e fail2ban dai VPS remoti</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Server className="w-4 h-4 text-muted-foreground" />
          <Select value={effectiveVpsId} onValueChange={setSelectedVpsId}>
            <SelectTrigger className="w-52">
              <SelectValue placeholder="Seleziona VPS" />
            </SelectTrigger>
            <SelectContent>
              {(vpsList || []).map(vps => (
                <SelectItem key={vps.id} value={vps.id}>
                  <span className={healthMap?.[vps.id] ? "text-green-400" : "text-muted-foreground"}>●</span>
                  {" "}{vps.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!effectiveVpsId ? (
        <p className="text-center text-muted-foreground py-16">Nessun VPS configurato</p>
      ) : (
        <>
          {selectedVps && (
            <p className="text-xs text-muted-foreground font-mono">
              {selectedVps.host}:{selectedVps.port}
            </p>
          )}
          <Tabs defaultValue="nginx_access">
            <TabsList>
              {LOG_TYPES.map(l => (
                <TabsTrigger key={l.value} value={l.value}>{l.label}</TabsTrigger>
              ))}
            </TabsList>
            {LOG_TYPES.map(l => (
              <TabsContent key={l.value} value={l.value} className="pt-4">
                <LogPane vpsId={effectiveVpsId} logType={l.value} />
              </TabsContent>
            ))}
          </Tabs>
        </>
      )}
    </div>
  );
}
