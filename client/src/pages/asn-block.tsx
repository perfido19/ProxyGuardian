import { useState } from "react";
import { copyToClipboard } from "@/lib/clipboard";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useVpsList, useVpsHealth } from "@/hooks/use-vps";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LoadingState } from "@/components/loading-state";
import { useToast } from "@/hooks/use-toast";
import { ComposableMap, Geographies, Geography } from "react-simple-maps";
import {
  Plus, Trash2, Search, RefreshCw, CheckCircle, XCircle,
  Shield, Activity, Settings, FileText, AlertTriangle, Play, Database, Copy,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AsnEntry { asn: string; description?: string; }
interface BulkResult { vpsId: string; vpsName: string; success: boolean; data?: any; error?: string; }
interface AsnStat { asn: string; org: string; country: string; countryCode: string; packets: number; bytes: number; }
interface AsnStats { updatedAt: string; totalPrefixes: number; top: AsnStat[]; }
interface AsnStatus { ipsetRestore: string; whitelistWatcher: string; totalPrefixes: number; lastUpdate: string; installed?: boolean; }
interface WhitelistEntry { value: string; comment: string; type: "cidr" | "domain"; }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseAsnConfig(content: string): AsnEntry[] {
  return content.split("\n").map(line => {
    const t = line.trim();
    if (t.startsWith("#") || !t || !/^\S+\s+\S+;/.test(t)) return null;
    const parts = t.split(/\s+/);
    const comment = t.includes("#") ? t.split("#").slice(1).join("#").trim() : undefined;
    return { asn: parts[0], description: comment };
  }).filter(Boolean) as AsnEntry[];
}

function buildAsnConfig(entries: AsnEntry[]): string {
  return entries.map(({ asn, description }) => `${asn} 1;${description ? ` # ${description}` : ""}`).join("\n") + "\n";
}

function ServiceBadge({ state }: { state: string }) {
  const active = state === "active";
  return (
    <Badge className={active ? "bg-green-600 text-white" : "bg-destructive text-white"}>
      {active ? <CheckCircle className="w-3 h-3 mr-1 inline" /> : <XCircle className="w-3 h-3 mr-1 inline" />}
      {state || "unknown"}
    </Badge>
  );
}

// ─── Map helpers ──────────────────────────────────────────────────────────────

const GEO_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

// ISO Alpha-2 → ISO Numeric (for topojson geo.id matching)
const ISO2_NUMERIC: Record<string, string> = {
  AF:"004",AX:"248",AL:"008",DZ:"012",AS:"016",AD:"020",AO:"024",AI:"660",AQ:"010",AG:"028",
  AR:"032",AM:"051",AW:"533",AU:"036",AT:"040",AZ:"031",BS:"044",BH:"048",BD:"050",BB:"052",
  BY:"112",BE:"056",BZ:"084",BJ:"204",BM:"060",BT:"064",BO:"068",BQ:"535",BA:"070",BW:"072",
  BV:"074",BR:"076",IO:"086",BN:"096",BG:"100",BF:"854",BI:"108",CV:"132",KH:"116",CM:"120",
  CA:"124",KY:"136",CF:"140",TD:"148",CL:"152",CN:"156",CX:"162",CC:"166",CO:"170",KM:"174",
  CG:"178",CD:"180",CK:"184",CR:"188",CI:"384",HR:"191",CU:"192",CW:"531",CY:"196",CZ:"203",
  DK:"208",DJ:"262",DM:"212",DO:"214",EC:"218",EG:"818",SV:"222",GQ:"226",ER:"232",EE:"233",
  SZ:"748",ET:"231",FK:"238",FO:"234",FJ:"242",FI:"246",FR:"250",GF:"254",PF:"258",TF:"260",
  GA:"266",GM:"270",GE:"268",DE:"276",GH:"288",GI:"292",GR:"300",GL:"304",GD:"308",GP:"312",
  GU:"316",GT:"320",GG:"831",GN:"324",GW:"624",GY:"328",HT:"332",HM:"334",VA:"336",HN:"340",
  HK:"344",HU:"348",IS:"352",IN:"356",ID:"360",IR:"364",IQ:"368",IE:"372",IM:"833",IL:"376",
  IT:"380",JM:"388",JP:"392",JE:"832",JO:"400",KZ:"398",KE:"404",KI:"296",KP:"408",KR:"410",
  KW:"414",KG:"417",LA:"418",LV:"428",LB:"422",LS:"426",LR:"430",LY:"434",LI:"438",LT:"440",
  LU:"442",MO:"446",MG:"450",MW:"454",MY:"458",MV:"462",ML:"466",MT:"470",MH:"584",MQ:"474",
  MR:"478",MU:"480",YT:"175",MX:"484",FM:"583",MD:"498",MC:"492",MN:"496",ME:"499",MS:"500",
  MA:"504",MZ:"508",MM:"104",NA:"516",NR:"520",NP:"524",NL:"528",NC:"540",NZ:"554",NI:"558",
  NE:"562",NG:"566",NU:"570",NF:"574",MK:"807",MP:"580",NO:"578",OM:"512",PK:"586",PW:"585",
  PS:"275",PA:"591",PG:"598",PY:"600",PE:"604",PH:"608",PN:"612",PL:"616",PT:"620",PR:"630",
  QA:"634",RE:"638",RO:"642",RU:"643",RW:"646",BL:"652",SH:"654",KN:"659",LC:"662",MF:"663",
  PM:"666",VC:"670",WS:"882",SM:"674",ST:"678",SA:"682",SN:"686",RS:"688",SC:"690",SL:"694",
  SG:"702",SX:"534",SK:"703",SI:"705",SB:"090",SO:"706",ZA:"710",GS:"239",SS:"728",ES:"724",
  LK:"144",SD:"729",SR:"740",SJ:"744",SE:"752",CH:"756",SY:"760",TW:"158",TJ:"762",TZ:"834",
  TH:"764",TL:"626",TG:"768",TK:"772",TO:"776",TT:"780",TN:"788",TR:"792",TM:"795",TC:"796",
  TV:"798",UG:"800",UA:"804",AE:"784",GB:"826",US:"840",UM:"581",UY:"858",UZ:"860",VU:"548",
  VE:"862",VN:"704",VG:"092",VI:"850",WF:"876",EH:"732",YE:"887",ZM:"894",ZW:"716",
};

function flagEmoji(code: string): string {
  if (!code || code.length !== 2) return "🌐";
  const base = 127397;
  return String.fromCodePoint(...code.toUpperCase().split("").map(c => base + c.charCodeAt(0)));
}

function fmtBytes(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + " GB";
  if (b >= 1e6) return (b / 1e6).toFixed(1) + " MB";
  if (b >= 1e3) return (b / 1e3).toFixed(1) + " KB";
  return b + " B";
}

function mapColor(packets: number, maxPackets: number): string {
  const pct = packets / Math.max(maxPackets, 1);
  if (pct < 0.05) return "#334155";
  if (pct < 0.2)  return "#b45309";
  if (pct < 0.5)  return "#ea580c";
  if (pct < 0.8)  return "#dc2626";
  return "#991b1b";
}

// ─── AsnBlock not-installed banner ────────────────────────────────────────────

const ASNBLOCK_INSTALL_CMD = "bash <(curl -fsSL https://raw.githubusercontent.com/perfido19/AsnBlock/master/install.sh)";

function AsnBlockNotInstalledBanner() {
  const { toast } = useToast();
  return (
    <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-4 space-y-3">
      <div className="flex items-center gap-2 text-yellow-400 font-medium text-sm">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        AsnBlock non è installato su questo VPS.
      </div>
      <p className="text-xs text-muted-foreground">Installa con il seguente comando sul VPS:</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 bg-zinc-950 text-zinc-200 text-xs font-mono px-3 py-2 rounded-md overflow-auto whitespace-nowrap">
          {ASNBLOCK_INSTALL_CMD}
        </code>
        <Button variant="ghost" size="sm" className="shrink-0"
          onClick={() => { copyToClipboard(ASNBLOCK_INSTALL_CMD); toast({ title: "Copiato" }); }}>
          <Copy className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ─── Panoramica Tab ───────────────────────────────────────────────────────────

function TabPanoramica({ vpsId }: { vpsId: string }) {
  const proxy = (path: string) => `/api/vps/${vpsId}/proxy${path}`;
  const [asnPage, setAsnPage] = useState(0);
  const [tooltip, setTooltip] = useState<{ name: string; packets: number; pct: number; flag: string } | null>(null);

  const { data: status, isLoading: statusLoading } = useQuery<AsnStatus>({
    queryKey: [`asn-status-${vpsId}`],
    queryFn: async () => { const r = await apiRequest("GET", proxy("/api/asn/status")); return r.json(); },
    refetchInterval: 60000,
  });

  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useQuery<AsnStats>({
    queryKey: [`asn-stats-${vpsId}`],
    queryFn: async () => { const r = await apiRequest("GET", proxy("/api/asn/stats")); return r.json(); },
    refetchInterval: 300000,
  });

  // Build numeric ISO → country packet aggregation for map coloring
  const countryPackets = new Map<string, { country: string; code2: string; packets: number }>();
  (stats?.top || []).forEach(s => {
    const num = ISO2_NUMERIC[s.countryCode];
    if (!num) return;
    // Store with both string and numeric key since geo.id type varies
    const entry = { country: s.country, code2: s.countryCode, packets: (countryPackets.get(num)?.packets || 0) + s.packets };
    countryPackets.set(num, entry);
    countryPackets.set(String(Number(num)), entry);
  });
  const totalMapPackets = Array.from(countryPackets.values()).reduce((a, b) => a + b.packets, 0) || 1;
  const maxCountryPackets = Math.max(...Array.from(countryPackets.values()).map(v => v.packets), 1);

  const topAsn = stats?.top || [];
  const maxPackets = topAsn[0]?.packets || 1;
  const PAGE_SIZE = 10;
  const pageCount = Math.ceil(Math.min(topAsn.length, 50) / PAGE_SIZE);
  const pagedAsn = topAsn.slice(asnPage * PAGE_SIZE, (asnPage + 1) * PAGE_SIZE);

  const notInstalled = !statusLoading && status !== undefined && status.installed === false;

  return (
    <div className="space-y-4">
      {notInstalled && <AsnBlockNotInstalledBanner />}
      {/* Row 1: 4 status cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <p style={{ fontSize: 12 }} className="text-muted-foreground uppercase tracking-wide mb-2">ipset-restore</p>
            {statusLoading ? <div className="h-6 bg-muted rounded animate-pulse" /> : <ServiceBadge state={status?.ipsetRestore ?? "unknown"} />}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p style={{ fontSize: 12 }} className="text-muted-foreground uppercase tracking-wide mb-2">whitelist-watcher</p>
            {statusLoading ? <div className="h-6 bg-muted rounded animate-pulse" /> : <ServiceBadge state={status?.whitelistWatcher ?? "unknown"} />}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p style={{ fontSize: 12 }} className="text-muted-foreground uppercase tracking-wide mb-1">Prefissi bloccati</p>
            <p style={{ fontSize: 32 }} className="font-bold font-heading text-foreground leading-none">
              {statusLoading ? "…" : (status?.totalPrefixes ?? 0).toLocaleString()}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p style={{ fontSize: 12 }} className="text-muted-foreground uppercase tracking-wide mb-1">Ultimo aggiornamento</p>
            <p style={{ fontSize: 14 }} className="font-mono text-foreground leading-snug">
              {statusLoading ? "…" : status?.lastUpdate
                ? (() => { const d = new Date(status.lastUpdate); return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; })()
                : "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Row 2: World map */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Traffico Bloccato per Paese</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => refetchStats()}>
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0 relative">
          {statsLoading ? (
            <div className="h-[560px] flex items-center justify-center"><LoadingState message="Caricamento..." /></div>
          ) : (
            <>
              <div className="relative w-full" style={{ height: 560 }}>
                {tooltip && (
                  <div className="absolute top-3 left-3 z-10 bg-background/90 border rounded px-3 py-2 shadow pointer-events-none" style={{ fontSize: 13 }}>
                    <span className="text-base mr-1">{tooltip.flag}</span>
                    <span className="font-semibold">{tooltip.name}</span>
                    <br />
                    <span className="text-muted-foreground">{tooltip.packets.toLocaleString()} pacchetti · {tooltip.pct.toFixed(1)}%</span>
                  </div>
                )}
                <ComposableMap projection="geoMercator" projectionConfig={{ scale: 180, center: [10, 20] }} width={800} height={500} style={{ width: "100%", height: "100%" }}>
                  <Geographies geography={GEO_URL}>
                    {({ geographies }) =>
                      geographies.map(geo => {
                        const d = countryPackets.get(String(geo.id));
                        const fill = d ? mapColor(d.packets, maxCountryPackets) : "#1e293b";
                        return (
                          <Geography
                            key={geo.rsmKey}
                            geography={geo}
                            fill={fill}
                            stroke="#0f172a"
                            strokeWidth={0.5}
                            style={{
                              default: { outline: "none" },
                              hover: { outline: "none", fill: d ? "#f97316" : "#334155", cursor: d ? "pointer" : "default" },
                              pressed: { outline: "none" },
                            }}
                            onMouseEnter={() => {
                              if (d) {
                                setTooltip({
                                  name: d.country,
                                  packets: d.packets,
                                  pct: (d.packets / totalMapPackets) * 100,
                                  flag: flagEmoji(d.code2),
                                });
                              }
                            }}
                            onMouseLeave={() => setTooltip(null)}
                          />
                        );
                      })
                    }
                  </Geographies>
                </ComposableMap>
              </div>
              <div className="flex items-center gap-2 px-4 pb-3 text-muted-foreground" style={{ fontSize: 13 }}>
                <span>Basso</span>
                {["#334155","#b45309","#ea580c","#dc2626","#991b1b"].map(c => (
                  <div key={c} className="rounded-sm" style={{ background: c, width: 16, height: 16 }} />
                ))}
                <span>Alto</span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Row 3: Top ASN table full width with pagination */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Top ASN</CardTitle>
            {stats?.updatedAt && (
              <span className="text-xs text-muted-foreground">{new Date(stats.updatedAt).toLocaleTimeString("it-IT")}</span>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {statsLoading ? <LoadingState message="Caricamento..." /> : !topAsn.length ? (
            <p className="text-center text-muted-foreground py-8 text-sm">Nessun dato disponibile</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" style={{ fontSize: 13 }}>#</TableHead>
                    <TableHead style={{ fontSize: 13 }}>ASN</TableHead>
                    <TableHead style={{ fontSize: 13 }}>Organizzazione</TableHead>
                    <TableHead style={{ fontSize: 13 }}>Paese</TableHead>
                    <TableHead className="text-right" style={{ fontSize: 13 }}>Pacchetti</TableHead>
                    <TableHead className="text-right" style={{ fontSize: 13 }}>Bytes</TableHead>
                    <TableHead className="w-28"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedAsn.map((s, i) => (
                    <TableRow key={s.asn}>
                      <TableCell className="py-3 text-muted-foreground" style={{ fontSize: 14 }}>{asnPage * PAGE_SIZE + i + 1}</TableCell>
                      <TableCell className="py-3 font-mono font-medium" style={{ fontSize: 15 }}>{s.asn}</TableCell>
                      <TableCell className="py-3 text-muted-foreground max-w-xs truncate" style={{ fontSize: 13 }}>{s.org}</TableCell>
                      <TableCell className="py-3 whitespace-nowrap" style={{ fontSize: 14 }}>{flagEmoji(s.countryCode)} {s.country}</TableCell>
                      <TableCell className="py-3 text-right font-mono" style={{ fontSize: 14 }}>{s.packets.toLocaleString()}</TableCell>
                      <TableCell className="py-3 text-right font-mono" style={{ fontSize: 14 }}>{fmtBytes(s.bytes)}</TableCell>
                      <TableCell className="py-3">
                        <div className="h-1.5 rounded bg-muted overflow-hidden">
                          <div className="h-full bg-orange-500 rounded" style={{ width: `${Math.round((s.packets / maxPackets) * 100)}%` }} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {pageCount > 1 && (
                <div className="flex items-center justify-between px-4 py-2 border-t text-xs text-muted-foreground">
                  <span>Pagina {asnPage + 1} di {pageCount}</span>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" disabled={asnPage === 0} onClick={() => setAsnPage(p => p - 1)}>‹ Prec</Button>
                    <Button variant="ghost" size="sm" disabled={asnPage >= pageCount - 1} onClick={() => setAsnPage(p => p + 1)}>Succ ›</Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Gestione Tab ─────────────────────────────────────────────────────────────

function TabGestione({ vpsId, canWrite }: { vpsId: string; canWrite: boolean }) {
  const { toast } = useToast();
  const proxy = (path: string) => `/api/vps/${vpsId}/proxy${path}`;
  const [testIp, setTestIp] = useState("");
  const [testResult, setTestResult] = useState<boolean | null>(null);
  const [updateListsOutput, setUpdateListsOutput] = useState("");
  const [updateSetOutput, setUpdateSetOutput] = useState("");

  const { data: status, isLoading: statusLoading } = useQuery<AsnStatus>({
    queryKey: [`asn-status-${vpsId}`],
    queryFn: async () => { const r = await apiRequest("GET", proxy("/api/asn/status")); return r.json(); },
    refetchInterval: 60000,
  });
  const notInstalled = !statusLoading && status !== undefined && status.installed === false;

  const updateListsMutation = useMutation({
    mutationFn: async () => { const r = await apiRequest("POST", proxy("/api/asn/update-lists"), {}); return r.json(); },
    onSuccess: (data: any) => {
      setUpdateListsOutput(data.output || "");
      toast({ title: data.success ? "Liste aggiornate" : "Errore aggiornamento liste", variant: data.success ? "default" : "destructive" });
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const updateSetMutation = useMutation({
    mutationFn: async () => { const r = await apiRequest("POST", proxy("/api/asn/update-set"), {}); return r.json(); },
    onSuccess: (data: any) => {
      setUpdateSetOutput(data.output || "");
      toast({ title: data.success ? "Set rigenerato" : "Errore rigenerazione set", variant: data.success ? "default" : "destructive" });
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const testIpMutation = useMutation({
    mutationFn: async () => { const r = await apiRequest("POST", proxy("/api/asn/test-ip"), { ip: testIp }); return r.json(); },
    onSuccess: (data: any) => setTestResult(data.blocked),
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      {notInstalled && <AsnBlockNotInstalledBanner />}
      {/* Test IP */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Testa IP</CardTitle>
          <CardDescription>Verifica se un IP è bloccato nell'ipset blocked_asn</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 flex-wrap items-center">
            <Input
              placeholder="es. 8.8.8.8"
              value={testIp}
              onChange={e => { setTestIp(e.target.value); setTestResult(null); }}
              className="w-48 font-mono"
              onKeyDown={e => e.key === "Enter" && testIp && testIpMutation.mutate()}
            />
            <Button size="sm" onClick={() => testIpMutation.mutate()} disabled={!testIp || testIpMutation.isPending}>
              <Search className="w-4 h-4 mr-1" />Testa
            </Button>
            {testResult !== null && (
              <Badge className={testResult ? "bg-destructive text-white text-sm px-3 py-1" : "bg-green-600 text-white text-sm px-3 py-1"}>
                {testResult ? "BLOCCATO" : "LIBERO"}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Aggiorna liste */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Aggiorna liste da GitHub</CardTitle>
              <CardDescription>Scarica i file di configurazione aggiornati dal repository</CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite || notInstalled || updateListsMutation.isPending}
              onClick={() => {
                if (!confirm("Aggiornare le liste da GitHub?")) return;
                setUpdateListsOutput("");
                updateListsMutation.mutate();
              }}
            >
              <RefreshCw className={`w-4 h-4 mr-1 ${updateListsMutation.isPending ? "animate-spin" : ""}`} />
              {updateListsMutation.isPending ? "Aggiornamento..." : "Aggiorna liste"}
            </Button>
          </div>
        </CardHeader>
        {updateListsOutput && (
          <CardContent>
            <pre className="bg-zinc-950 text-zinc-200 text-xs font-mono p-3 rounded-md overflow-auto max-h-48 whitespace-pre-wrap">
              {updateListsOutput}
            </pre>
          </CardContent>
        )}
      </Card>

      {/* Rigenera set */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Rigenera set ipset</CardTitle>
              <CardDescription className="flex items-center gap-1">
                <AlertTriangle className="w-3 h-3 text-yellow-500" />
                Operazione lenta — rigenera l'intero set blocked_asn (può richiedere 1–2 minuti)
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite || notInstalled || updateSetMutation.isPending}
              onClick={() => {
                if (!confirm("Rigenerare l'intero set ipset? L'operazione può richiedere 1-2 minuti.")) return;
                setUpdateSetOutput("");
                updateSetMutation.mutate();
              }}
            >
              <Database className={`w-4 h-4 mr-1 ${updateSetMutation.isPending ? "animate-spin" : ""}`} />
              {updateSetMutation.isPending ? "Rigenerazione..." : "Rigenera set"}
            </Button>
          </div>
        </CardHeader>
        {updateSetOutput && (
          <CardContent>
            <pre className="bg-zinc-950 text-zinc-200 text-xs font-mono p-3 rounded-md overflow-auto max-h-64 whitespace-pre-wrap">
              {updateSetOutput}
            </pre>
          </CardContent>
        )}
      </Card>
    </div>
  );
}

// ─── Whitelist Tab ────────────────────────────────────────────────────────────

function TabWhitelist({ vpsId, canWrite }: { vpsId: string; canWrite: boolean }) {
  const { toast } = useToast();
  const proxy = (path: string) => `/api/vps/${vpsId}/proxy${path}`;
  const [newValue, setNewValue] = useState("");
  const [newComment, setNewComment] = useState("");

  const { data: entries, isLoading, refetch } = useQuery<WhitelistEntry[]>({
    queryKey: [`asn-whitelist-${vpsId}`],
    queryFn: async () => { const r = await apiRequest("GET", proxy("/api/asn/whitelist")); const d = await r.json(); return d.entries || []; },
    refetchInterval: 60000,
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", proxy("/api/asn/whitelist"), { value: newValue, comment: newComment });
      return r.json();
    },
    onSuccess: (data: any) => {
      if (data.ok) {
        refetch();
        setNewValue(""); setNewComment("");
        toast({ title: "Voce aggiunta alla whitelist" });
      } else {
        toast({ title: "Errore", description: data.error, variant: "destructive" });
      }
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (value: string) => {
      const r = await apiRequest("DELETE", proxy("/api/asn/whitelist"), { value });
      return r.json();
    },
    onSuccess: () => { refetch(); toast({ title: "Voce rimossa dalla whitelist" }); },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <Card className="border-blue-500/20 bg-blue-500/5">
        <CardContent className="pt-4">
          <p className="text-sm text-muted-foreground">
            Il set si aggiorna automaticamente entro pochi secondi grazie al watcher inotify. Aggiungi CIDR (es. <code className="font-mono text-xs bg-muted px-1 rounded">1.2.3.0/24</code>) o domini.
          </p>
        </CardContent>
      </Card>

      {canWrite && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Aggiungi alla whitelist</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2 flex-wrap">
              <Input
                placeholder="CIDR o dominio (es. 1.2.3.0/24)"
                value={newValue}
                onChange={e => setNewValue(e.target.value)}
                className="w-52 font-mono"
                onKeyDown={e => e.key === "Enter" && newValue && addMutation.mutate()}
              />
              <Input
                placeholder="Commento (opzionale)"
                value={newComment}
                onChange={e => setNewComment(e.target.value)}
                className="flex-1 min-w-40"
              />
              <Button size="sm" onClick={() => addMutation.mutate()} disabled={!newValue || addMutation.isPending}>
                <Plus className="w-4 h-4 mr-1" />Aggiungi
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Whitelist attuale</CardTitle>
              <CardDescription>{entries?.length ?? 0} voci</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => refetch()}><RefreshCw className="w-4 h-4" /></Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? <LoadingState message="Caricamento..." /> : !entries?.length ? (
            <p className="text-center text-muted-foreground py-8">Whitelist vuota</p>
          ) : (
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Valore</TableHead>
                    <TableHead>Commento</TableHead>
                    {canWrite && <TableHead className="text-right">Azioni</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <Badge variant="outline" className={entry.type === "cidr" ? "border-blue-500 text-blue-400" : "border-purple-500 text-purple-400"}>
                          {entry.type.toUpperCase()}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{entry.value}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{entry.comment || "—"}</TableCell>
                      {canWrite && (
                        <TableCell className="text-right">
                          <Button size="icon" variant="ghost" disabled={deleteMutation.isPending}
                            onClick={() => deleteMutation.mutate(entry.value)}>
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Log Tab ──────────────────────────────────────────────────────────────────

function TabLog({ vpsId }: { vpsId: string }) {
  const proxy = (path: string) => `/api/vps/${vpsId}/proxy${path}`;
  const { data, isLoading, refetch } = useQuery<{ lines: string[] }>({
    queryKey: [`asn-log-${vpsId}`],
    queryFn: async () => { const r = await apiRequest("GET", proxy("/api/asn/log")); return r.json(); },
    refetchInterval: 60000,
  });

  function lineColor(line: string) {
    if (/error|fail|ERR/i.test(line)) return "text-red-400";
    if (/ok|success|done|complet/i.test(line)) return "text-green-400";
    if (/warn/i.test(line)) return "text-yellow-400";
    return "text-zinc-400";
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Log aggiornamenti</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => refetch()}>
            <RefreshCw className="w-4 h-4 mr-1" />Aggiorna
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? <LoadingState message="Caricamento log..." /> : (
          <div className="bg-zinc-950 rounded-md p-3 font-mono text-xs h-96 overflow-y-auto space-y-0.5">
            {(data?.lines || []).length === 0 ? (
              <p className="text-zinc-500 py-4 text-center">Nessun log disponibile</p>
            ) : (
              [...(data?.lines || [])].reverse().map((line, i) => (
                <div key={i} className={lineColor(line)}>{line}</div>
              ))
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Blocklist Tab (existing functionality) ───────────────────────────────────

function TabBlocklist({ selectedVps, setSelectedVps, vpsList, onlineVps }: {
  selectedVps: string;
  setSelectedVps: (v: string) => void;
  vpsList: any[];
  onlineVps: any[];
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [newAsn, setNewAsn] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const { data: bulkResults, isLoading, refetch } = useQuery<BulkResult[]>({
    queryKey: ["asn-block-all", selectedVps],
    queryFn: async () => {
      const r = await apiRequest("POST", "/api/vps/bulk/get", {
        vpsIds: onlineVps.map(v => v.id),
        path: "/api/config/block_asn.conf",
      });
      return r.json();
    },
    enabled: onlineVps.length > 0,
    refetchInterval: 120000,
  });

  const asnMap = new Map<string, { description?: string; presentIn: Set<string> }>();
  const vpsConfigMap = new Map<string, AsnEntry[]>();
  (bulkResults || []).filter(r => r.success && r.data?.content).forEach(r => {
    const entries = parseAsnConfig(r.data.content);
    vpsConfigMap.set(r.vpsId, entries);
    entries.forEach(({ asn, description }) => {
      if (!asnMap.has(asn)) asnMap.set(asn, { description, presentIn: new Set() });
      asnMap.get(asn)!.presentIn.add(r.vpsId);
      if (description && !asnMap.get(asn)!.description) asnMap.get(asn)!.description = description;
    });
  });

  const allAsns = Array.from(asnMap.entries()).map(([asn, data]) => ({ asn, ...data }));
  const filtered = search
    ? allAsns.filter(e => e.asn.includes(search) || (e.description ?? "").toLowerCase().includes(search.toLowerCase()))
    : allAsns;

  const saveAllMutation = useMutation({
    mutationFn: async ({ asn, remove }: { asn: string; remove: boolean }) => {
      return Promise.all(onlineVps.map(async vps => {
        const current = vpsConfigMap.get(vps.id) || [];
        let updated: AsnEntry[];
        if (remove) {
          updated = current.filter(e => e.asn !== asn);
        } else {
          if (current.find(e => e.asn === asn)) return { vpsId: vps.id, vpsName: vps.name, success: true };
          updated = [...current, { asn, description: newDesc || undefined }];
        }
        const r = await apiRequest("POST", `/api/vps/${vps.id}/proxy/api/config/block_asn.conf`, { content: buildAsnConfig(updated) });
        return r.json();
      }));
    },
    onSuccess: (_, vars) => {
      refetch();
      const target = selectedVps === "all" ? "tutti i VPS" : onlineVps[0]?.name ?? "VPS selezionato";
      toast({ title: vars.remove ? `ASN ${vars.asn} rimosso da ${target}` : `ASN ${vars.asn} aggiunto a ${target}` });
      if (!vars.remove) { setNewAsn(""); setNewDesc(""); }
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Aggiungi ASN</CardTitle>
          <CardDescription>{selectedVps === "all" ? "Aggiunge su tutti i VPS online" : `Solo su ${onlineVps[0]?.name ?? "VPS selezionato"}`}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 flex-wrap">
            <Input placeholder="Numero ASN (es. 15169)" value={newAsn} onChange={e => setNewAsn(e.target.value)}
              className="w-48 font-mono" onKeyDown={e => e.key === "Enter" && newAsn && !asnMap.has(newAsn) && saveAllMutation.mutate({ asn: newAsn, remove: false })} />
            <Input placeholder="Descrizione (opzionale)" value={newDesc} onChange={e => setNewDesc(e.target.value)} className="flex-1" />
            <Button onClick={() => saveAllMutation.mutate({ asn: newAsn, remove: false })} disabled={!newAsn || asnMap.has(newAsn) || saveAllMutation.isPending}>
              <Plus className="w-4 h-4 mr-1" />Aggiungi
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle>ASN Bloccati</CardTitle>
              <CardDescription>{allAsns.length} ASN — {selectedVps === "all" ? `${onlineVps.length} VPS online` : onlineVps[0]?.name}</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
              <RefreshCw className="w-4 h-4 mr-1" />Aggiorna
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Cerca ASN o descrizione..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
          </div>
          {search && <p className="text-xs text-muted-foreground">{filtered.length} / {allAsns.length} risultati</p>}
          {isLoading ? <LoadingState message="Caricamento ASN da tutti i VPS..." /> : (
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ASN</TableHead>
                    <TableHead>Descrizione</TableHead>
                    <TableHead>Copertura VPS</TableHead>
                    <TableHead className="text-right">Azioni</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">{search ? "Nessun risultato" : "Nessun ASN bloccato"}</TableCell></TableRow>
                  ) : filtered.map(({ asn, description, presentIn }) => (
                    <TableRow key={asn}>
                      <TableCell className="font-mono font-semibold">{asn}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{description || "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-xs ${presentIn.size === onlineVps.length ? "border-green-600/40 text-green-600" : "border-yellow-500/40 text-yellow-600"}`}>
                          {presentIn.size}/{onlineVps.length} VPS
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" disabled={saveAllMutation.isPending}
                          onClick={() => saveAllMutation.mutate({ asn, remove: true })}>
                          <Trash2 className="w-4 h-4 text-destructive" />
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
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AsnBlock() {
  const { user } = useAuth();
  const { data: vpsList } = useVpsList();
  const { data: healthMap } = useVpsHealth();
  const [selectedVps, setSelectedVps] = useState("all");

  const canWrite = user?.role === "admin" || user?.role === "operator";

  const allOnlineVps = (vpsList || []).filter(v => healthMap?.[v.id]);
  const onlineVps = selectedVps === "all" ? allOnlineVps : allOnlineVps.filter(v => v.id === selectedVps);

  // For per-VPS tabs: use the first online VPS or selected one
  const activeVpsId = selectedVps !== "all"
    ? selectedVps
    : allOnlineVps[0]?.id ?? "";

  const activeVpsName = (vpsList || []).find(v => v.id === activeVpsId)?.name ?? "";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-heading font-bold tracking-tight">ASN Block</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Gestione blocco ASN — script ipset su VPS</p>
        </div>
        <Select value={selectedVps} onValueChange={setSelectedVps}>
          <SelectTrigger className="w-44 h-8 text-sm">
            <SelectValue placeholder="Seleziona VPS" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutti i VPS</SelectItem>
            {(vpsList || []).map(v => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Tabs defaultValue="panoramica">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="panoramica"><Activity className="w-3.5 h-3.5 mr-1.5" />Panoramica</TabsTrigger>
          <TabsTrigger value="gestione"><Settings className="w-3.5 h-3.5 mr-1.5" />Gestione</TabsTrigger>
          <TabsTrigger value="whitelist"><Shield className="w-3.5 h-3.5 mr-1.5" />Whitelist</TabsTrigger>
          <TabsTrigger value="log"><FileText className="w-3.5 h-3.5 mr-1.5" />Log</TabsTrigger>
          <TabsTrigger value="blocklist"><Database className="w-3.5 h-3.5 mr-1.5" />Blocklist ASN</TabsTrigger>
        </TabsList>

        {/* Per-VPS banner */}
        {activeVpsId ? (
          <>
            <TabsContent value="panoramica" className="pt-4">
              {activeVpsName && <p className="text-xs text-muted-foreground mb-3 font-mono">VPS: {activeVpsName}</p>}
              <TabPanoramica vpsId={activeVpsId} />
            </TabsContent>
            <TabsContent value="gestione" className="pt-4">
              {activeVpsName && <p className="text-xs text-muted-foreground mb-3 font-mono">VPS: {activeVpsName}</p>}
              <TabGestione vpsId={activeVpsId} canWrite={canWrite} />
            </TabsContent>
            <TabsContent value="whitelist" className="pt-4">
              {activeVpsName && <p className="text-xs text-muted-foreground mb-3 font-mono">VPS: {activeVpsName}</p>}
              <TabWhitelist vpsId={activeVpsId} canWrite={canWrite} />
            </TabsContent>
            <TabsContent value="log" className="pt-4">
              {activeVpsName && <p className="text-xs text-muted-foreground mb-3 font-mono">VPS: {activeVpsName}</p>}
              <TabLog vpsId={activeVpsId} />
            </TabsContent>
          </>
        ) : (
          <>
            {["panoramica", "gestione", "whitelist", "log"].map(tab => (
              <TabsContent key={tab} value={tab} className="pt-4">
                <p className="text-center text-muted-foreground py-12">Nessun VPS online disponibile</p>
              </TabsContent>
            ))}
          </>
        )}

        <TabsContent value="blocklist" className="pt-4">
          <TabBlocklist
            selectedVps={selectedVps}
            setSelectedVps={setSelectedVps}
            vpsList={vpsList || []}
            onlineVps={onlineVps}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
