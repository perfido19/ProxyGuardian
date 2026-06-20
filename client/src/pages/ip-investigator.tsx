import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Search, ShieldBan, ShieldCheck, AlertTriangle, Globe, User, Server, RefreshCw, XCircle, CheckCircle2 } from "lucide-react";

interface VpsHit {
  vpsId: string;
  vpsName: string;
  count: number;
  usernames: string[];
  paths: string[];
  statuses: string[];
  ua: string | null;
  banned: boolean;
  sample: string[];
}

interface InvestigateResult {
  ip: string;
  totalVps: number;
  totalRequests: number;
  allUsernames: string[];
  geoInfo: { asn?: string; org?: string; countryCode?: string } | null;
  vpsResults: VpsHit[];
}

function statusColor(s: string) {
  if (s.startsWith("2")) return "text-green-500";
  if (s.startsWith("4")) return "text-orange-400";
  if (s.startsWith("5")) return "text-red-400";
  return "text-muted-foreground";
}

export default function IpInvestigator() {
  const { toast } = useToast();
  const [ipInput, setIpInput] = useState("");
  const [result, setResult] = useState<InvestigateResult | null>(null);
  const [expandedVps, setExpandedVps] = useState<string | null>(null);
  const [banState, setBanState] = useState<"idle" | "running" | "ok" | "error">("idle");

  const investigate = useMutation({
    mutationFn: async (ip: string) => {
      const res = await apiRequest("POST", "/api/fleet/ip-investigate", { ip });
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<InvestigateResult>;
    },
    onSuccess: (data) => {
      setResult(data);
      setBanState("idle");
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const banFleet = async (ip: string) => {
    setBanState("running");
    try {
      const res = await apiRequest("POST", "/api/fleet/ip-ban", { ip });
      const data = await res.json();
      setBanState("ok");
      toast({ title: `Bannato su ${data.ok} VPS`, description: data.fail > 0 ? `${data.fail} VPS falliti` : "Tutta la fleet aggiornata" });
      // refresh
      investigate.mutate(ip);
    } catch (e: any) {
      setBanState("error");
      toast({ title: "Errore ban", description: e.message, variant: "destructive" });
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const ip = ipInput.trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      toast({ title: "IP non valido", variant: "destructive" });
      return;
    }
    investigate.mutate(ip);
  };

  const bannedVpsCount = result?.vpsResults.filter(v => v.banned).length ?? 0;
  const isFullyBanned = result && bannedVpsCount === result.totalVps && result.totalVps > 0;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold font-heading">IP Investigator</h1>
        <p className="text-sm text-muted-foreground mt-1">Analisi cross-fleet di un IP — log, username, ban status</p>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="pt-5">
          <form onSubmit={submit} className="flex gap-3">
            <Input
              value={ipInput}
              onChange={e => setIpInput(e.target.value)}
              placeholder="Es. 64.94.85.248"
              className="font-mono text-sm max-w-xs"
            />
            <Button type="submit" disabled={investigate.isPending} className="gap-1.5">
              {investigate.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Analizza
            </Button>
          </form>
        </CardContent>
      </Card>

      {investigate.isPending && (
        <div className="flex items-center gap-3 text-muted-foreground text-sm">
          <RefreshCw className="w-4 h-4 animate-spin" />
          Scansione di tutta la fleet in corso…
        </div>
      )}

      {result && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="text-2xl font-bold font-heading">{result.vpsResults.filter(v => v.count > 0).length}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                  <Server className="w-3 h-3" /> VPS con log
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="text-2xl font-bold font-heading">{result.totalRequests}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                  <Globe className="w-3 h-3" /> Richieste totali
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="text-2xl font-bold font-heading">{result.allUsernames.length}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                  <User className="w-3 h-3" /> Username unici
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="text-2xl font-bold font-heading">{bannedVpsCount}/{result.totalVps}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                  <ShieldBan className="w-3 h-3" /> VPS bannati
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Geo + username + actions */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Informazioni IP</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="font-mono text-lg font-bold">{result.ip}</div>
                {result.geoInfo ? (
                  <div className="text-sm space-y-1 text-muted-foreground">
                    <div>ASN: <span className="text-foreground font-mono">{result.geoInfo.asn}</span></div>
                    <div>ISP: <span className="text-foreground">{result.geoInfo.org}</span></div>
                    <div>Paese: <span className="text-foreground">{result.geoInfo.countryCode}</span></div>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">Geo info non disponibile</div>
                )}
                {result.totalVps === 0 ? (
                  <Badge variant="outline" className="text-green-500 border-green-500/30 mt-2">
                    Nessuna attività rilevata
                  </Badge>
                ) : isFullyBanned ? (
                  <Badge variant="outline" className="text-green-500 border-green-500/30 mt-2">
                    <ShieldCheck className="w-3 h-3 mr-1" /> Bannato su tutta la fleet
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-orange-500 border-orange-500/30 mt-2">
                    <AlertTriangle className="w-3 h-3 mr-1" /> Attività rilevata — non completamente bannato
                  </Badge>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Username trovati ({result.allUsernames.length})</CardTitle>
                <CardDescription className="text-xs">Da /player_api.php e /panel_api.php</CardDescription>
              </CardHeader>
              <CardContent>
                {result.allUsernames.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                    {result.allUsernames.map(u => (
                      <Badge key={u} variant="secondary" className="font-mono text-xs">{u}</Badge>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">Nessun username estratto</div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Actions */}
          {result.totalVps > 0 && (
            <div className="flex gap-3">
              <Button
                variant="destructive"
                disabled={banState === "running" || isFullyBanned === true}
                onClick={() => banFleet(result.ip)}
                className="gap-1.5"
              >
                {banState === "running" ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : banState === "ok" ? (
                  <CheckCircle2 className="w-4 h-4" />
                ) : (
                  <ShieldBan className="w-4 h-4" />
                )}
                {isFullyBanned ? "Già bannato su tutta la fleet" : "Banna su tutta la fleet"}
              </Button>
              <Button variant="outline" onClick={() => investigate.mutate(result.ip)} disabled={investigate.isPending} className="gap-1.5">
                <RefreshCw className={`w-4 h-4 ${investigate.isPending ? "animate-spin" : ""}`} />
                Rianalizza
              </Button>
            </div>
          )}

          {/* Per-VPS breakdown */}
          {result.totalVps > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Dettaglio per VPS</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {result.vpsResults.sort((a, b) => b.count - a.count).map(vps => (
                  <div key={vps.vpsId} className="border border-border rounded-lg overflow-hidden">
                    <button
                      className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-muted/40 transition-colors text-left"
                      onClick={() => setExpandedVps(expandedVps === vps.vpsId ? null : vps.vpsId)}
                    >
                      <div className="flex items-center gap-3">
                        {vps.banned ? (
                          <ShieldCheck className="w-4 h-4 text-green-500 shrink-0" />
                        ) : (
                          <XCircle className="w-4 h-4 text-orange-400 shrink-0" />
                        )}
                        <span className="text-sm font-medium">{vps.vpsName}</span>
                        {vps.count > 0 ? (
                          <Badge variant="secondary" className="text-xs">{vps.count} req</Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs text-muted-foreground">solo ban</Badge>
                        )}
                        {vps.usernames.length > 0 && (
                          <span className="text-xs text-muted-foreground">{vps.usernames.length} username</span>
                        )}
                      </div>
                      <div className="flex gap-1">
                        {[...new Set(vps.statuses)].map(s => (
                          <span key={s} className={`text-xs font-mono ${statusColor(s)}`}>{s}</span>
                        ))}
                      </div>
                    </button>

                    {expandedVps === vps.vpsId && (
                      <div className="border-t border-border px-4 py-3 bg-muted/20 space-y-3">
                        {vps.ua && (
                          <div className="text-xs text-muted-foreground">
                            User-Agent: <span className="font-mono text-foreground">{vps.ua}</span>
                          </div>
                        )}
                        {vps.usernames.length > 0 && (
                          <div>
                            <div className="text-xs text-muted-foreground mb-1">Username:</div>
                            <div className="flex flex-wrap gap-1">
                              {vps.usernames.map(u => (
                                <Badge key={u} variant="outline" className="font-mono text-xs">{u}</Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {vps.sample.length > 0 && (
                          <div>
                            <div className="text-xs text-muted-foreground mb-1">Righe log ({vps.sample.length}):</div>
                            <div className="bg-black/40 rounded p-2 space-y-0.5 max-h-96 overflow-y-auto">
                              {vps.sample.map((line, i) => (
                                <div key={i} className="text-[10px] font-mono text-green-400/80 break-all">{line}</div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {result.totalVps === 0 && (
            <Card>
              <CardContent className="pt-8 pb-8 text-center text-muted-foreground">
                <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-green-500" />
                <div className="text-sm">Nessuna attività rilevata per <span className="font-mono">{result.ip}</span></div>
                <div className="text-xs mt-1 opacity-60">Nessun log recente e non presente in iptv_ban</div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
