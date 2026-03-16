import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Save, RotateCcw, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ConfigFile } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { LoadingState } from "@/components/loading-state";

const configFiles = [
  {
    filename: "country_whitelist.conf",
    path: "/etc/nginx/country_whitelist.conf",
    description: "Whitelist paesi autorizzati (codici ISO 3166-1 alpha-2)",
  },
  {
    filename: "block_asn.conf",
    path: "/etc/nginx/block_asn.conf",
    description: "Blacklist ASN (Autonomous System Numbers)",
  },
  {
    filename: "block_isp.conf",
    path: "/etc/nginx/block_isp.conf",
    description: "Blacklist provider internet (ISP)",
  },
  {
    filename: "useragent.rules",
    path: "/etc/nginx/useragent.rules",
    description: "Regole per bloccare user-agent specifici",
  },
  {
    filename: "ip_whitelist.conf",
    path: "/etc/nginx/ip_whitelist.conf",
    description: "IP esclusi dal rate limiting",
  },
  {
    filename: "exclusion_ip.conf",
    path: "/etc/nginx/exclusion_ip.conf",
    description: "IP/range esclusi dal blocco geografico",
  },
];

export default function Configurations() {
  const { toast } = useToast();
  const [selectedFile, setSelectedFile] = useState(configFiles[0].filename);
  const [editedContent, setEditedContent] = useState("");
  const [hasChanges, setHasChanges] = useState(false);

  const { data: configContent, isLoading } = useQuery<ConfigFile>({
    queryKey: ['/api/config', selectedFile],
  });

  const updateConfigMutation = useMutation({
    mutationFn: async ({ filename, content }: { filename: string; content: string }) => {
      return apiRequest('POST', '/api/config/update', { filename, content });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/config'] });
      setHasChanges(false);
      toast({
        title: "Configurazione salvata",
        description: data.message,
      });
    },
    onError: () => {
      toast({
        title: "Errore",
        description: "Impossibile salvare la configurazione",
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    if (configContent) {
      setEditedContent(configContent.content);
      setHasChanges(false);
    }
  }, [configContent]);

  const currentFile = configFiles.find(f => f.filename === selectedFile);

  const handleContentChange = (value: string) => {
    setEditedContent(value);
    setHasChanges(true);
  };

  const handleSave = () => {
    updateConfigMutation.mutate({ filename: selectedFile, content: editedContent });
  };

  const handleReset = () => {
    setEditedContent(configContent?.content || "");
    setHasChanges(false);
  };

  const handleFileChange = (newFile: string) => {
    if (hasChanges) {
      if (!confirm("Hai modifiche non salvate. Vuoi davvero cambiare file?")) {
        return;
      }
    }
    setSelectedFile(newFile);
  };

  if (isLoading) {
    return <LoadingState message="Caricamento configurazione..." />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">File di Configurazione</h1>
        <p className="text-muted-foreground">
          Modifica i file di configurazione del sistema
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex-1">
              <CardTitle className="flex items-center gap-2">
                <FileText className="w-5 h-5" />
                Editor Configurazione
              </CardTitle>
              <CardDescription className="mt-2">
                Seleziona un file e modifica il contenuto direttamente
              </CardDescription>
            </div>
            {hasChanges && (
              <Badge variant="secondary" className="self-start">
                Modifiche non salvate
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-2 block">
              Seleziona File
            </label>
            <Select value={selectedFile} onValueChange={handleFileChange}>
              <SelectTrigger data-testid="select-config-file">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {configFiles.map((file) => (
                  <SelectItem key={file.filename} value={file.filename}>
                    {file.filename}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {currentFile && (
            <div className="space-y-2">
              <div className="flex items-start gap-2 text-sm">
                <span className="font-medium text-muted-foreground">Percorso:</span>
                <span className="font-mono text-xs">{currentFile.path}</span>
              </div>
              <p className="text-sm text-muted-foreground">
                {currentFile.description}
              </p>
            </div>
          )}

          <div>
            <label className="text-sm font-medium mb-2 block">
              Contenuto File
            </label>
            <Textarea
              value={editedContent}
              onChange={(e) => handleContentChange(e.target.value)}
              className="font-mono text-sm min-h-[400px]"
              placeholder={`# ${currentFile?.description}\n# Aggiungi le tue configurazioni qui...`}
              data-testid="textarea-config-content"
            />
          </div>

          <div className="flex flex-col sm:flex-row gap-2 justify-between">
            <Button
              variant="secondary"
              onClick={handleReset}
              disabled={!hasChanges || updateConfigMutation.isPending}
              data-testid="button-reset-config"
            >
              <RotateCcw className="w-4 h-4 mr-1" />
              Ripristina
            </Button>
            <Button
              variant="default"
              onClick={handleSave}
              disabled={!hasChanges || updateConfigMutation.isPending}
              data-testid="button-save-config"
            >
              <Save className="w-4 h-4 mr-1" />
              {updateConfigMutation.isPending ? "Salvataggio..." : "Salva Modifiche"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Importante</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            • Dopo aver modificato i file di configurazione, è necessario ricaricare nginx per applicare le modifiche.
          </p>
          <p>
            • Usa il comando <code className="bg-muted px-1 py-0.5 rounded font-mono text-xs">systemctl reload nginx</code> oppure 
            vai alla sezione Servizi e clicca su "Reload" per nginx.
          </p>
          <p>
            • Verifica sempre la sintassi prima di salvare per evitare errori di configurazione.
          </p>
          <p>
            • Fai un backup delle configurazioni prima di apportare modifiche importanti.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
