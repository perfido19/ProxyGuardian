import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { LoadingState } from "@/components/loading-state";
import {
  Copy, Check, Download, Server, Settings2, Shield, Globe,
  AlertTriangle, FileText, Terminal, Info, ChevronDown, ChevronUp,
} from "lucide-react";

export default function DeployVps() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [vpsName, setVpsName] = useState("");
  const [backendIp, setBackendIp] = useState("main.netbird.cloud");
  const [backendPort, setBackendPort] = useState("8880");
  const [proxyPort, setProxyPort] = useState("8880");
  const [generating, setGenerating] = useState(false);
  const [script, setScript] = useState("");
  const [copied, setCopied] = useState(false);
  const [showScript, setShowScript] = useState(false);
  const [embeddedConfigs, setEmbeddedConfigs] = useState<Record<string, boolean>>({});

  const handleGenerate = async () => {
    if (!vpsName.trim()) {
      toast({ title: "Nome richiesto", description: "Inserisci un nome per il VPS", variant: "destructive" });
      return;
    }
    setGenerating(true);
    setScript("");
    setShowScript(false);
    try {
      const res = await apiRequest("POST", "/api/deploy/generate-script", {
        vpsName: vpsName.trim(),
        backendIp: backendIp.trim(),
        backendPort: parseInt(backendPort) || 8880,
        proxyPort: parseInt(proxyPort) || 8880,
      });
      const data = await res.json();
      setScript(data.script);
      setEmbeddedConfigs(data.embeddedConfigs || {});
      setShowScript(true);
      toast({ title: "Script generato", description: `Script pronto per ${vpsName.trim()}` });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message || "Impossibile generare lo script", variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(script);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({ title: "Copiato!", description: "Script copiato negli appunti" });
  };

  const handleDownload = () => {
    const blob = new Blob([script], { type: "text/x-sh" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `deploy-${vpsName.trim().toLowerCase().replace(/\s+/g, "-") || "proxy"}.sh`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast({ title: "Scaricato", description: "Script scaricato" });
  };

  const configItems = [
    { key: "nginxOptimized", label: "Nginx ottimizzato", icon: Settings2 },
    { key: "modsecRelaxed", label: "ModSec relaxed (API)", icon: Shield },
    { key: "countryWhitelist", label: "Country whitelist", icon: Globe },
    { key: "blockAsn", label: "ASN blacklist", icon: AlertTriangle },
    { key: "blockIsp", label: "ISP blacklist", icon: AlertTriangle },
    { key: "blockBadAgents", label: "Bad agents block", icon: Shield },
    { key: "ipWhitelist", label: "IP whitelist", icon: FileText },
    { key: "exclusionIp", label: "IP exclusion", icon: FileText },
  ];

  if (user?.role !== "admin") {
    return (
      <div className="space-y-6">
        <Alert variant="destructive">
          <AlertTriangle className="w-4 h-4" />
          <AlertTitle>Accesso negato</AlertTitle>
          <AlertDescription>Solo gli admin possono accedere a questa sezione.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-heading font-bold tracking-tight">Deploy VPS</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Genera script completo per installare Nginx + ModSecurity + Fail2ban + NetBird + Agent su un nuovo VPS
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="w-5 h-5" />
            Configurazione Deploy
          </CardTitle>
          <CardDescription>
            Parametri per il nuovo VPS proxy. Il backend IP è l'indirizzo del server Xtream e NetBird verra` installato/joinato automaticamente.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <Info className="w-4 h-4" />
            <AlertTitle>NetBird obbligatorio</AlertTitle>
            <AlertDescription>
              Lo script installa NetBird usando la setup key del dashboard e si interrompe se non ottiene un IP mesh `100.x.x.x`.
            </AlertDescription>
          </Alert>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Nome VPS</Label>
              <Input
                value={vpsName}
                onChange={e => setVpsName(e.target.value)}
                placeholder="es. VPS Milano 02"
              />
            </div>
            <div className="space-y-2">
              <Label>Backend IP / Hostname</Label>
              <Input
                value={backendIp}
                onChange={e => setBackendIp(e.target.value)}
                placeholder="main.netbird.cloud"
              />
            </div>
            <div className="space-y-2">
              <Label>Backend Port</Label>
              <Input
                value={backendPort}
                onChange={e => setBackendPort(e.target.value)}
                placeholder="8880"
                type="number"
              />
            </div>
            <div className="space-y-2">
              <Label>Proxy Listen Port</Label>
              <Input
                value={proxyPort}
                onChange={e => setProxyPort(e.target.value)}
                placeholder="8880"
                type="number"
              />
            </div>
          </div>

          <Button onClick={handleGenerate} disabled={generating} className="w-full md:w-auto">
            {generating ? (
              <LoadingState message="Generazione..." />
            ) : (
              <>
                <Terminal className="w-4 h-4 mr-2" />
                Genera Script Deploy
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {script && (
        <>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Terminal className="w-5 h-5" />
                    Script Generato
                  </CardTitle>
                  <CardDescription>
                    Script autocontenuto con tutte le config attuali della dashboard
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={handleCopy}>
                    {copied ? <Check className="w-4 h-4 mr-1 text-green-500" /> : <Copy className="w-4 h-4 mr-1" />}
                    {copied ? "Copiato!" : "Copia"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleDownload}>
                    <Download className="w-4 h-4 mr-1" />
                    Scarica .sh
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Button
                variant="ghost"
                size="sm"
                className="mb-2"
                onClick={() => setShowScript(!showScript)}
              >
                {showScript ? <ChevronUp className="w-4 h-4 mr-1" /> : <ChevronDown className="w-4 h-4 mr-1" />}
                {showScript ? "Nascondi script" : "Mostra script"}
              </Button>
              {showScript && (
                <Textarea
                  value={script}
                  readOnly
                  className="font-mono text-xs h-96 resize-none"
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Info className="w-5 h-5" />
                Configurazioni Embeddate
              </CardTitle>
              <CardDescription>
                Queste configurazioni sono state incluse automaticamente dallo stato attuale della dashboard
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {configItems.map(item => (
                  <div
                    key={item.key}
                    className={`flex items-center gap-2 p-3 rounded-lg border ${
                      embeddedConfigs[item.key]
                        ? "bg-green-950/30 border-green-800/50"
                        : "bg-muted/30 border-border"
                    }`}
                  >
                    <item.icon className={`w-4 h-4 ${embeddedConfigs[item.key] ? "text-green-400" : "text-muted-foreground"}`} />
                    <span className="text-xs font-medium">{item.label}</span>
                    {embeddedConfigs[item.key] && (
                      <Badge variant="outline" className="ml-auto text-[10px] text-green-400 border-green-700">
                        ✓
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">
                Istruzioni
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="install">
                <TabsList>
                  <TabsTrigger value="install">Installazione</TabsTrigger>
                  <TabsTrigger value="register">Registrazione Dashboard</TabsTrigger>
                </TabsList>
                <TabsContent value="install" className="space-y-3 mt-4">
                  <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
                    <li>Scarica o copia lo script generato</li>
                    <li>Trasferiscilo sul nuovo VPS (scp, sftp, o copia-incolla)</li>
                    <li>Rendi eseguibile: <code className="bg-muted px-1.5 py-0.5 rounded text-xs">chmod +x deploy-*.sh</code></li>
                    <li>Esegui come root: <code className="bg-muted px-1.5 py-0.5 rounded text-xs">sudo ./deploy-*.sh</code></li>
                    <li>Lo script installa e connette NetBird prima dell'agent</li>
                    <li>Se NetBird non si connette o non compare un IP `100.x.x.x`, il deploy si ferma</li>
                    <li>Al termine, lo script mostrerà l'IP NetBird e l'API Key generata</li>
                  </ol>
                  <Alert>
                    <Info className="w-4 h-4" />
                    <AlertTitle>Tempo stimato</AlertTitle>
                    <AlertDescription>
                        L'installazione richiede 10-20 minuti su una VPS pulita Ubuntu 20.04/22.04.
                    </AlertDescription>
                  </Alert>
                </TabsContent>
                <TabsContent value="register" className="space-y-3 mt-4">
                  <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
                    <li>Vai su <strong>VPS</strong> nella sidebar</li>
                    <li>Clicca <strong>"Aggiungi VPS"</strong></li>
                    <li>Inserisci il nome del VPS</li>
                    <li>Inserisci l'IP NetBird (100.x.x.x) mostrato dallo script, non l'IP pubblico</li>
                    <li>Porta: <strong>3001</strong> (default dell'agent)</li>
                    <li>Incolla l'API Key mostrata dallo script</li>
                    <li>Clicca <strong>"Aggiungi VPS"</strong> e verifica la connessione</li>
                  </ol>
                  <Alert>
                    <AlertTriangle className="w-4 h-4" />
                    <AlertTitle>Importante</AlertTitle>
                    <AlertDescription>
                      L'API Key viene mostrata UNA SOLA volta alla fine dell'installazione. Salvala subito!
                    </AlertDescription>
                  </Alert>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
