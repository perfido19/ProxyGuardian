import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { LoadingState } from "@/components/loading-state";
import {
  CheckCircle2, XCircle, RefreshCw, Upload, RotateCw, FileText, Eye
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface LogGroup {
  id: string;
  label: string;
  paths: string[];
  defaultRotate: number;
  defaultFrequency: "daily" | "weekly";
  postrotate?: string;
  description: string;
}

const LOG_GROUPS: LogGroup[] = [
  {
    id: "nginx",
    label: "Nginx",
    paths: ["/var/log/nginx/access.log", "/var/log/nginx/error.log"],
    defaultRotate: 3,
    defaultFrequency: "daily",
    postrotate: "[ -f /var/run/nginx.pid ] && kill -USR1 $(cat /var/run/nginx.pid) 2>/dev/null || true",
    description: "Access e error log di Nginx reverse proxy",
  },
  {
    id: "modsec",
    label: "ModSecurity",
    paths: ["/opt/log/modsec_audit.log"],
    defaultRotate: 3,
    defaultFrequency: "daily",
    description: "Audit log delle regole WAF ModSecurity",
  },
  {
    id: "fail2ban",
    label: "Fail2ban",
    paths: ["/var/log/fail2ban.log"],
    defaultRotate: 3,
    defaultFrequency: "daily",
    postrotate: "fail2ban-client flushlogs 2>/dev/null || true",
    description: "Log di ban/unban e attività jail",
  },
  {
    id: "syslog",
    label: "Syslog",
    paths: ["/var/log/syslog", "/var/log/messages"],
    defaultRotate: 7,
    defaultFrequency: "daily",
    postrotate: "systemctl restart rsyslog 2>/dev/null || true",
    description: "Log di sistema generali",
  },
  {
    id: "agent",
    label: "ProxyGuardian Agent",
    paths: ["/var/log/pg-agent.log"],
    defaultRotate: 3,
    defaultFrequency: "daily",
    description: "Log dell'agent ProxyGuardian",
  },
];

interface GroupConfig {
  enabled: boolean;
  rotate: number;
  frequency: "daily" | "weekly";
  compress: boolean;
  delaycompress: boolean;
  missingok: boolean;
  notifempty: boolean;
}

type ConfigMap = Record<string, GroupConfig>;

function buildDefaultConfig(): ConfigMap {
  const cfg: ConfigMap = {};
  for (const g of LOG_GROUPS) {
    cfg[g.id] = {
      enabled: true,
      rotate: g.defaultRotate,
      frequency: g.defaultFrequency,
      compress: true,
      delaycompress: true,
      missingok: true,
      notifempty: true,
    };
  }
  return cfg;
}

function generateLogrotateConf(config: ConfigMap): string {
  const blocks: string[] = [];
  for (const group of LOG_GROUPS) {
    const c = config[group.id] ?? {
      enabled: false, rotate: group.defaultRotate, frequency: "daily" as const,
      compress: true, delaycompress: true, missingok: true, notifempty: true
    };
    if (!c?.enabled) continue;
    const lines: string[] = [];
    lines.push(group.paths.join("\n"));
    lines.push("{");
    lines.push(`    ${c.frequency}`);
    lines.push(`    rotate ${c.rotate}`);
    if (c.missingok) lines.push("    missingok");
    if (c.notifempty) lines.push("    notifempty");
    if (c.compress) lines.push("    compress");
    if (c.delaycompress) lines.push("    delaycompress");
    if (group.paths.length > 1 || group.postrotate) lines.push("    sharedscripts");
    if (group.postrotate) {
      lines.push("    postrotate");
      lines.push(`        ${group.postrotate}`);
      lines.push("    endscript");
    }
    lines.push("}");
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n") + "\n";
}

interface VpsLogrotateStatus {
  vpsId: string;
  vpsName: string;
  ready: boolean;
  checks: { installed: boolean; upToDate: boolean; ready: boolean } | null;
  error: string | null;
}

export default function Logrotate() {
  const { toast } = useToast();
  const [config, setConfig] = useState<ConfigMap>(buildDefaultConfig);
  const [applying, setApplying] = useState<Record<string, "idle" | "running" | "ok" | "error">>({});
  const [previewOpen, setPreviewOpen] = useState(false);

  const { data: statuses, isLoading, refetch, isFetching } = useQuery<VpsLogrotateStatus[]>({
    queryKey: ["/api/fleet/logrotate/status"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/fleet/logrotate/status");
      return res.json();
    },
    staleTime: 30000,
  });

  const { data: savedConfig } = useQuery<ConfigMap | null>({
    queryKey: ["/api/admin/logrotate-config"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/admin/logrotate-config");
      return res.json();
    },
    staleTime: 60000,
  });

  useEffect(() => {
    if (savedConfig) {
      setConfig(prev => {
        const merged = { ...prev };
        for (const g of LOG_GROUPS) {
          if (savedConfig[g.id]) {
            merged[g.id] = { ...prev[g.id], ...savedConfig[g.id] };
          }
        }
        return merged;
      });
    }
  }, [savedConfig]);

  const saveTimer = useRef<NodeJS.Timeout | null>(null);
  const saveConfig = useCallback(async (configToSave: ConfigMap) => {
    try {
      await apiRequest("POST", "/api/admin/logrotate-config", configToSave);
    } catch (e) {
      console.error("Failed to save logrotate config:", e);
    }
  }, []);

  const updateGroup = (id: string, patch: Partial<GroupConfig>) => {
    setConfig(prev => {
      const newConfig = { ...prev, [id]: { ...prev[id], ...patch } };
      // Debounce save
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => saveConfig(newConfig), 1000);
      return newConfig;
    });
  };

  const applyLogrotate = async (vpsIds: string[]) => {
    const next: Record<string, "idle" | "running" | "ok" | "error"> = { ...applying };
    vpsIds.forEach(id => { next[id] = "running"; });
    setApplying(next);
    // Save config immediately before applying
    await saveConfig(config);
    try {
      const conf = generateLogrotateConf(config);
      const res = await apiRequest("POST", "/api/fleet/logrotate/setup", { vpsIds, config: conf });
      const results: Array<{ vpsId: string; vpsName: string; ok: boolean; error?: string }> = await res.json();
      const updated: Record<string, "idle" | "running" | "ok" | "error"> = { ...applying };
      results.forEach(r => { updated[r.vpsId] = r.ok ? "ok" : "error"; });
      setApplying(updated);
      const failed = results.filter(r => !r.ok);
      if (failed.length === 0) {
        toast({ title: "Logrotate configurato", description: `${results.length} VPS aggiornati` });
      } else {
        toast({ title: "Setup parziale", description: `${failed.length} VPS falliti: ${failed.map(f => f.vpsName).join(", ")}`, variant: "destructive" });
      }
      setTimeout(() => refetch(), 1500);
    } catch (e: any) {
      vpsIds.forEach(id => { next[id] = "error"; });
      setApplying({ ...next });
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  const readyCount = (statuses || []).filter(s => s.ready).length;
  const totalCount = (statuses || []).length;
  const enabledGroups = Object.values(config).filter(c => c.enabled).length;

  if (isLoading) return <LoadingState message="Controllo logrotate su fleet..." />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-heading tracking-tight">Logrotate</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configura la rotazione log su tutti i VPS della fleet
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="gap-1.5">
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Aggiorna
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)} className="gap-1.5">
            <Eye className="w-3.5 h-3.5" />
            Anteprima config
          </Button>
          <Button
            size="sm"
            onClick={() => {
              const allIds = (statuses || []).filter(s => !s.error).map(s => s.vpsId);
              if (allIds.length > 0) applyLogrotate(allIds);
            }}
            disabled={!statuses || statuses.filter(s => !s.error).length === 0 || enabledGroups === 0}
            className="gap-1.5"
          >
            <Upload className="w-3.5 h-3.5" />
            Applica a tutti ({totalCount})
          </Button>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-green-500/10 flex items-center justify-center">
                <CheckCircle2 className="w-5 h-5 text-green-500" />
              </div>
              <div>
                <div className="text-2xl font-bold font-heading">{readyCount}/{totalCount}</div>
                <div className="text-xs text-muted-foreground">VPS con logrotate attivo</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <FileText className="w-5 h-5 text-blue-500" />
              </div>
              <div>
                <div className="text-2xl font-bold font-heading">{enabledGroups}/{LOG_GROUPS.length}</div>
                <div className="text-xs text-muted-foreground">Gruppi log abilitati</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-orange-500/10 flex items-center justify-center">
                <RotateCw className="w-5 h-5 text-orange-500" />
              </div>
              <div>
                <div className="text-2xl font-bold font-heading">{totalCount - readyCount}</div>
                <div className="text-xs text-muted-foreground">Da configurare</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Log group configuration */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-heading">Configurazione gruppi log</CardTitle>
          <CardDescription className="text-xs mt-0.5">
            Configura retention, frequenza e opzioni per ogni gruppo di log
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {LOG_GROUPS.map(group => {
            const c = config[group.id] ?? {
              enabled: false, rotate: group.defaultRotate, frequency: "daily" as const,
              compress: true, delaycompress: true, missingok: true, notifempty: true
            };
            return (
              <div key={group.id} className={`border rounded-lg p-4 transition-colors ${c.enabled ? "border-border" : "border-border/50 opacity-60"}`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-1">
                      <Switch
                        checked={c.enabled}
                        onCheckedChange={(v) => updateGroup(group.id, { enabled: v })}
                      />
                      <span className="font-heading font-medium text-sm">{group.label}</span>
                      <Badge variant="outline" className="text-[10px] font-mono">
                        {group.paths.length} file
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground ml-11">{group.description}</p>
                    <div className="text-[10px] font-mono text-muted-foreground/70 ml-11 mt-1">
                      {group.paths.join(", ")}
                    </div>
                  </div>
                  {c.enabled && (
                    <div className="flex items-center gap-3">
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">Frequenza</Label>
                        <Select value={c.frequency} onValueChange={(v) => updateGroup(group.id, { frequency: v as "daily" | "weekly" })}>
                          <SelectTrigger className="h-8 w-24 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="daily">Giornaliero</SelectItem>
                            <SelectItem value="weekly">Settimanale</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">Retention</Label>
                        <div className="flex items-center gap-1.5">
                          <Input
                            type="number"
                            min={1}
                            max={90}
                            value={c.rotate}
                            onChange={(e) => updateGroup(group.id, { rotate: parseInt(e.target.value) || 1 })}
                            className="h-8 w-16 text-xs"
                          />
                          <span className="text-[10px] text-muted-foreground">{c.frequency === "daily" ? "giorni" : "settimane"}</span>
                        </div>
                      </div>
                      <div className="space-y-1.5 pt-3">
                        <div className="flex items-center gap-2">
                          <Switch checked={c.compress} onCheckedChange={(v) => updateGroup(group.id, { compress: v })} className="scale-75" />
                          <span className="text-[10px]">Comprimi</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* VPS status table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base font-heading">Stato fleet</CardTitle>
              <CardDescription className="text-xs mt-0.5">
                Stato logrotate per ogni VPS
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>VPS</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Installato</TableHead>
                <TableHead>Aggiornato</TableHead>
                <TableHead className="text-right pr-4">Azioni</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(statuses || []).map(vps => {
                const state = applying[vps.vpsId] || "idle";
                return (
                  <TableRow key={vps.vpsId}>
                    <TableCell className="font-medium font-heading">{vps.vpsName}</TableCell>
                    <TableCell>
                      {vps.error ? (
                        <Badge variant="destructive" className="text-[10px] gap-1">
                          <XCircle className="w-3 h-3" /> Errore
                        </Badge>
                      ) : vps.ready ? (
                        <Badge className="text-[10px] gap-1 bg-green-500/15 text-green-600 border-green-500/30 hover:bg-green-500/20">
                          <CheckCircle2 className="w-3 h-3" /> Configurato
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] gap-1 text-orange-500 border-orange-500/30">
                          <RotateCw className="w-3 h-3" /> Da configurare
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {vps.error ? (
                        <span className="text-muted-foreground">—</span>
                      ) : vps.checks?.installed ? (
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                      ) : (
                        <XCircle className="w-4 h-4 text-red-400" />
                      )}
                    </TableCell>
                    <TableCell>
                      {vps.error ? (
                        <span className="text-muted-foreground">—</span>
                      ) : vps.checks?.upToDate ? (
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                      ) : (
                        <XCircle className="w-4 h-4 text-red-400" />
                      )}
                    </TableCell>
                    <TableCell className="text-right pr-4">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1"
                        disabled={state === "running" || !!vps.error}
                        onClick={() => applyLogrotate([vps.vpsId])}
                      >
                        {state === "running" ? (
                          <RefreshCw className="w-3 h-3 animate-spin" />
                        ) : state === "ok" ? (
                          <CheckCircle2 className="w-3 h-3 text-green-500" />
                        ) : state === "error" ? (
                          <XCircle className="w-3 h-3 text-red-400" />
                        ) : (
                          <Upload className="w-3 h-3" />
                        )}
                        Applica
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Preview dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="font-heading">proxyguardian (logrotate config)</DialogTitle>
          </DialogHeader>
          <div className="overflow-auto flex-1">
            <pre className="text-xs font-mono bg-muted/50 rounded-lg p-4 whitespace-pre overflow-x-auto">
              {generateLogrotateConf(config)}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
