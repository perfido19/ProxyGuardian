import { useQuery, useMutation } from "@tanstack/react-query";
import { ServiceStatusCard } from "@/components/service-status-card";
import { LoadingState } from "@/components/loading-state";
import type { Service } from "@shared/schema";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";

export default function Services() {
  const { toast } = useToast();

  const { data: services, isLoading } = useQuery<Service[]>({
    queryKey: ['/api/services'],
    refetchInterval: 5000,
  });

  const serviceActionMutation = useMutation({
    mutationFn: async ({ service, action }: { service: string; action: string }) => {
      return apiRequest('POST', '/api/services/action', { service, action });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/services'] });
      toast({
        title: "Azione completata",
        description: `Servizio ${data.name} aggiornato con successo`,
      });
    },
    onError: () => {
      toast({
        title: "Errore",
        description: "Impossibile eseguire l'azione sul servizio",
        variant: "destructive",
      });
    },
  });

  const handleServiceAction = (service: string, action: string) => {
    serviceActionMutation.mutate({ service, action });
  };

  if (isLoading) {
    return <LoadingState message="Caricamento servizi..." />;
  }

  const displayServices = services || [];

  const serviceInfo = {
    nginx: {
      description: "Server web e reverse proxy ad alte prestazioni",
      details: [
        "Gestisce il traffico HTTP/HTTPS in ingresso",
        "Implementa rate limiting e filtering",
        "Integrato con ModSecurity per la sicurezza",
        "Utilizza GeoIP2 per il blocco geografico",
      ],
    },
    fail2ban: {
      description: "Sistema di prevenzione intrusioni basato su log",
      details: [
        "Monitora i log di nginx per attività sospette",
        "Banna automaticamente IP che superano le soglie",
        "Gestisce le jail nginx-req-limit e nginx-4xx",
        "Salva gli IP bannati nel database MariaDB",
      ],
    },
    mariadb: {
      description: "Database relazionale per archiviazione dati",
      details: [
        "Memorizza la cronologia degli IP bannati",
        "Utilizzato da fail2ban per persistenza",
        "Fornisce dati per statistiche e report",
      ],
    },
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Gestione Servizi</h1>
        <p className="text-muted-foreground">
          Controlla e monitora i servizi del sistema
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {displayServices.map((service) => (
          <ServiceStatusCard
            key={service.name}
            service={service}
            onAction={handleServiceAction}
            isLoading={serviceActionMutation.isPending}
          />
        ))}
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-4">Informazioni Servizi</h2>
        <Accordion type="single" collapsible className="space-y-4">
          {displayServices.map((service) => {
            const info = serviceInfo[service.name as keyof typeof serviceInfo];
            if (!info) return null;

            return (
              <AccordionItem
                key={service.name}
                value={service.name}
                className="border rounded-md px-4"
              >
                <AccordionTrigger className="hover:no-underline" data-testid={`accordion-${service.name}`}>
                  <div className="flex items-center gap-3">
                    <span className="text-base font-semibold capitalize">
                      {service.name}
                    </span>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <Card className="mt-2">
                    <CardContent className="p-4 space-y-4">
                      <p className="text-sm text-muted-foreground">{info.description}</p>
                      <div>
                        <p className="text-sm font-medium mb-2">Funzionalità:</p>
                        <ul className="space-y-1">
                          {info.details.map((detail, idx) => (
                            <li key={idx} className="text-sm text-muted-foreground flex items-start gap-2">
                              <span className="text-primary mt-1">•</span>
                              <span>{detail}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </CardContent>
                  </Card>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </div>
    </div>
  );
}
