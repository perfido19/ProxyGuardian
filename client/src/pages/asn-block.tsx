import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useVpsList, useVpsHealth } from "@/hooks/use-vps";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LoadingState } from "@/components/loading-state";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Save, Search, RefreshCw, CheckCircle, XCircle } from "lucide-react";

interface AsnEntry { asn: string; description?: string; }
interface BulkResult { vpsId: string; vpsName: string; success: boolean; data?: any; error?: string; }

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

export default function AsnBlock() {
  const { toast } = useToast();
  const { data: vpsList } = useVpsList();
  const { data: healthMap } = useVpsHealth();
  const [search, setSearch] = useState("");
  const [newAsn, setNewAsn] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const onlineVps = (vpsList || []).filter(v => healthMap?.[v.id]);

  // Legge block_asn.conf da tutti i VPS online
  const { data: bulkResults, isLoading, refetch } = useQuery<BulkResult[]>({
    queryKey: ["asn-block-all"],
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

  // Costruisce mappa: asn → { description, vpsIds dove è presente }
  const asnMap = new Map<string, { description?: string; presentIn: Set<string> }>();
  const vpsConfigMap = new Map<string, AsnEntry[]>(); // vpsId → entries

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

  // Salva su tutti i VPS
  const saveAllMutation = useMutation({
    mutationFn: async ({ asn, remove }: { asn: string; remove: boolean }) => {
      const results = await Promise.all(onlineVps.map(async vps => {
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
      return results;
    },
    onSuccess: (_, vars) => {
      refetch();
      toast({ title: vars.remove ? `ASN ${vars.asn} rimosso da tutti i VPS` : `ASN ${vars.asn} aggiunto a tutti i VPS` });
      if (!vars.remove) { setNewAsn(""); setNewDesc(""); }
    },
    onError: (e: any) => toast({ title: "Errore", description: e.message, variant: "destructive" }),
  });

  const addAsn = () => {
    if (!newAsn || asnMap.has(newAsn)) return;
    saveAllMutation.mutate({ asn: newAsn, remove: false });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-heading font-bold tracking-tight">ASN Block</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Blocco Autonomous System Numbers su tutti i VPS — lettura e scrittura aggregata
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
          <RefreshCw className="w-4 h-4 mr-1" />Aggiorna
        </Button>
      </div>

      {/* Aggiungi nuovo ASN */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-heading uppercase tracking-wide text-muted-foreground">Aggiungi ASN</CardTitle>
          <CardDescription>Aggiunge il blocco su tutti i VPS online simultaneamente</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 flex-wrap">
            <Input
              placeholder="Numero ASN (es. 15169)"
              value={newAsn}
              onChange={e => setNewAsn(e.target.value)}
              className="w-48 font-mono"
              onKeyDown={e => e.key === "Enter" && addAsn()}
            />
            <Input
              placeholder="Descrizione (opzionale)"
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
              className="flex-1"
            />
            <Button onClick={addAsn} disabled={!newAsn || saveAllMutation.isPending}>
              <Plus className="w-4 h-4 mr-1" />Aggiungi su tutti i VPS
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Tabella ASN aggregata */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle>ASN Bloccati</CardTitle>
              <CardDescription>
                {allAsns.length} ASN univoci — {onlineVps.length} VPS online
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Cerca ASN o descrizione..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
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
                    {onlineVps.map(v => (
                      <TableHead key={v.id} className="text-center text-xs">{v.name}</TableHead>
                    ))}
                    <TableHead className="text-right">Azioni</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4 + onlineVps.length} className="text-center py-8 text-muted-foreground">
                        {search ? "Nessun risultato" : "Nessun ASN bloccato"}
                      </TableCell>
                    </TableRow>
                  ) : filtered.map(({ asn, description, presentIn }) => (
                    <TableRow key={asn}>
                      <TableCell className="font-mono font-semibold">{asn}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{description || "—"}</TableCell>
                      <TableCell>
                        <Badge variant={presentIn.size === onlineVps.length ? "destructive" : "outline"}>
                          {presentIn.size}/{onlineVps.length} VPS
                        </Badge>
                      </TableCell>
                      {onlineVps.map(v => (
                        <TableCell key={v.id} className="text-center">
                          {presentIn.has(v.id)
                            ? <CheckCircle className="w-4 h-4 text-green-500 inline" />
                            : <XCircle className="w-4 h-4 text-muted-foreground/30 inline" />}
                        </TableCell>
                      ))}
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={saveAllMutation.isPending}
                          onClick={() => saveAllMutation.mutate({ asn, remove: true })}
                        >
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
