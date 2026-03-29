import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Terminal, Power, PowerOff } from "lucide-react";

interface SafeVps { id: string; name: string; host: string; enabled: boolean; }

// Carica xterm in modo lazy per non appesantire il bundle iniziale
async function loadXterm() {
  const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);
  return { XTerm, FitAddon };
}

export default function SshConsole() {
  const { data: vpsList = [] } = useQuery<SafeVps[]>({ queryKey: ["/api/vps"] });
  const enabledVps = vpsList.filter(v => v.enabled);

  const [selectedVpsId, setSelectedVpsId] = useState<string>("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Inizializza xterm al mount
  useEffect(() => {
    let term: any, fit: any;
    (async () => {
      if (!termRef.current) return;
      const { XTerm, FitAddon } = await loadXterm();

      // Importa CSS di xterm
      await import("@xterm/xterm/css/xterm.css");

      term = new XTerm({
        theme: { background: "#0a0a0a", foreground: "#e5e5e5", cursor: "#60a5fa" },
        fontFamily: "JetBrains Mono, Fira Code, monospace",
        fontSize: 13,
        lineHeight: 1.4,
        cursorBlink: true,
        scrollback: 5000,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(termRef.current);
      fit.fit();
      xtermRef.current = term;
      fitRef.current = fit;

      term.writeln("\x1b[2m# Seleziona un VPS e premi Connetti\x1b[0m");
    })();

    const handleResize = () => { fitRef.current?.fit(); };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      term?.dispose();
      wsRef.current?.close();
    };
  }, []);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
    setStatusMsg("");
    xtermRef.current?.writeln("\r\n\x1b[33m[Disconnesso]\x1b[0m");
  }, []);

  const connect = useCallback(async () => {
    if (!selectedVpsId || connecting) return;
    disconnect();
    setConnecting(true);

    try {
      const res = await apiRequest("POST", "/api/admin/ssh/token", { vpsId: selectedVpsId });
      const { token } = await res.json();

      const term = xtermRef.current;
      const fit = fitRef.current;
      const { cols, rows } = term ?? { cols: 120, rows: 30 };

      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/api/admin/ssh/ws?token=${token}&cols=${cols}&rows=${rows}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnecting(false);
        setConnected(true);
      };

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "stdout") term?.write(msg.data);
        else if (msg.type === "status") term?.writeln(`\x1b[2m${msg.data}\x1b[0m`);
        else if (msg.type === "error") term?.writeln(`\x1b[31m${msg.data}\x1b[0m`);
        else if (msg.type === "ready") {
          setStatusMsg("Connesso");
          // Invia input dell'utente al server
          term?.onData((data: string) => {
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ type: "stdin", data }));
          });
          // Invia resize al server
          term?.onResize(({ cols, rows }: { cols: number; rows: number }) => {
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ type: "resize", cols, rows }));
          });
          fit?.fit();
        }
      };

      ws.onclose = () => {
        setConnected(false);
        setConnecting(false);
        setStatusMsg("");
      };

      ws.onerror = () => {
        term?.writeln("\r\n\x1b[31m[Errore WebSocket]\x1b[0m");
        setConnecting(false);
        setConnected(false);
      };
    } catch (e: any) {
      xtermRef.current?.writeln(`\r\n\x1b[31m[Errore: ${e.message}]\x1b[0m`);
      setConnecting(false);
    }
  }, [selectedVpsId, connecting, disconnect]);

  const selectedVps = enabledVps.find(v => v.id === selectedVpsId);

  return (
    <div className="space-y-4 h-full flex flex-col">
      <div>
        <h1 className="text-2xl font-bold font-heading tracking-tight">Console SSH</h1>
        <p className="text-sm text-muted-foreground mt-1">Connessione SSH diretta ai VPS per troubleshooting</p>
      </div>

      <Card className="shrink-0">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-heading">Connessione</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 flex-wrap">
            <Select value={selectedVpsId} onValueChange={setSelectedVpsId} disabled={connected || connecting}>
              <SelectTrigger className="w-52 h-8 text-sm">
                <SelectValue placeholder="Seleziona VPS..." />
              </SelectTrigger>
              <SelectContent>
                {enabledVps.map(v => (
                  <SelectItem key={v.id} value={v.id}>
                    <span className="font-medium">{v.name}</span>
                    <span className="ml-2 text-muted-foreground font-mono text-xs">{v.host}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {!connected ? (
              <Button size="sm" onClick={connect} disabled={!selectedVpsId || connecting} className="gap-2 h-8">
                <Power className="w-3.5 h-3.5" />
                {connecting ? "Connessione..." : "Connetti"}
              </Button>
            ) : (
              <Button size="sm" variant="destructive" onClick={disconnect} className="gap-2 h-8">
                <PowerOff className="w-3.5 h-3.5" />Disconnetti
              </Button>
            )}

            {connected && selectedVps && (
              <Badge variant="secondary" className="bg-green-500/10 text-green-600 border-green-500/30 text-xs font-mono gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />
                root@{selectedVps.host}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Terminale */}
      <div className="flex-1 rounded-xl border border-border overflow-hidden bg-[#0a0a0a] min-h-[400px]">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border/40 bg-black/40">
          <Terminal className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground font-mono">
            {connected ? `SSH — ${selectedVps?.name} (${selectedVps?.host})` : "Terminale SSH"}
          </span>
          {statusMsg && <Badge variant="outline" className="ml-auto text-[10px] h-4 px-1.5 text-green-500 border-green-500/30">{statusMsg}</Badge>}
        </div>
        <div ref={termRef} className="h-[calc(100%-37px)] w-full" />
      </div>
    </div>
  );
}
