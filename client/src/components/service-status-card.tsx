import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Play, Square, RotateCw, RefreshCw } from "lucide-react";
import type { Service } from "@shared/schema";

interface ServiceStatusCardProps {
  service: Service;
  onAction: (service: string, action: 'start' | 'stop' | 'restart' | 'reload') => void;
  isLoading?: boolean;
}

const statusConfig = {
  running: {
    variant: "default" as const,
    label: "Attivo",
    color: "bg-green-500",
  },
  stopped: {
    variant: "secondary" as const,
    label: "Fermo",
    color: "bg-gray-400",
  },
  error: {
    variant: "destructive" as const,
    label: "Errore",
    color: "bg-red-500",
  },
  restarting: {
    variant: "secondary" as const,
    label: "Riavvio...",
    color: "bg-yellow-500",
  },
};

export function ServiceStatusCard({ service, onAction, isLoading }: ServiceStatusCardProps) {
  const config = statusConfig[service.status];

  return (
    <Card data-testid={`card-service-${service.name}`}>
      <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${config.color} ${service.status === 'running' ? 'animate-pulse' : ''}`} />
          <h3 className="text-lg font-semibold capitalize">{service.name}</h3>
        </div>
        <Badge variant={config.variant} data-testid={`status-${service.name}`}>
          {config.label}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {service.uptime && (
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Uptime</p>
            <p className="text-sm font-medium font-mono" data-testid={`uptime-${service.name}`}>
              {service.uptime}
            </p>
          </div>
        )}
        {service.pid && (
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">PID</p>
            <p className="text-sm font-medium font-mono" data-testid={`pid-${service.name}`}>
              {service.pid}
            </p>
          </div>
        )}
        <div className="flex flex-wrap gap-2 pt-2">
          {service.status !== 'running' && (
            <Button
              size="sm"
              variant="default"
              onClick={() => onAction(service.name, 'start')}
              disabled={isLoading}
              data-testid={`button-start-${service.name}`}
            >
              <Play className="w-3 h-3 mr-1" />
              Avvia
            </Button>
          )}
          {service.status === 'running' && (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onAction(service.name, 'stop')}
                disabled={isLoading}
                data-testid={`button-stop-${service.name}`}
              >
                <Square className="w-3 h-3 mr-1" />
                Ferma
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onAction(service.name, 'restart')}
                disabled={isLoading}
                data-testid={`button-restart-${service.name}`}
              >
                <RotateCw className="w-3 h-3 mr-1" />
                Riavvia
              </Button>
              {service.name === 'nginx' && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onAction(service.name, 'reload')}
                  disabled={isLoading}
                  data-testid={`button-reload-${service.name}`}
                >
                  <RefreshCw className="w-3 h-3 mr-1" />
                  Reload
                </Button>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
