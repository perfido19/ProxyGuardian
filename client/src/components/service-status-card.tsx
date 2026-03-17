import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
    label: "ATTIVO",
    dotColor: "bg-emerald-400",
    glow: "shadow-[0_0_8px_theme(colors.emerald.500/0.5)]",
    textColor: "text-emerald-400",
  },
  stopped: {
    label: "FERMO",
    dotColor: "bg-zinc-500",
    glow: "",
    textColor: "text-zinc-400",
  },
  error: {
    label: "ERRORE",
    dotColor: "bg-red-500",
    glow: "shadow-[0_0_8px_theme(colors.red.500/0.5)]",
    textColor: "text-red-400",
  },
  restarting: {
    label: "RIAVVIO",
    dotColor: "bg-amber-400",
    glow: "shadow-[0_0_8px_theme(colors.amber.400/0.5)]",
    textColor: "text-amber-400",
  },
};

export function ServiceStatusCard({ service, onAction, isLoading }: ServiceStatusCardProps) {
  const config = statusConfig[service.status] ?? statusConfig.stopped;

  return (
    <Card
      data-testid={`card-service-${service.name}`}
      className="border-card-border hover:border-border transition-colors duration-200"
    >
      <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-3 pt-4 px-5">
        <div className="flex items-center gap-2.5">
          <div
            className={`w-2 h-2 rounded-full shrink-0 ${config.dotColor} ${config.glow} ${service.status === 'running' ? 'animate-pulse' : ''}`}
          />
          <h3 className="font-heading font-semibold capitalize tracking-wide text-sm">{service.name}</h3>
        </div>
        <span
          className={`text-[10px] font-mono font-semibold tracking-[0.1em] ${config.textColor}`}
          data-testid={`status-${service.name}`}
        >
          {config.label}
        </span>
      </CardHeader>
      <CardContent className="space-y-3 px-5 pb-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {service.uptime && (
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-heading mb-0.5">Uptime</p>
              <p className="text-xs font-mono" data-testid={`uptime-${service.name}`}>{service.uptime}</p>
            </div>
          )}
          {service.pid && (
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-heading mb-0.5">PID</p>
              <p className="text-xs font-mono" data-testid={`pid-${service.name}`}>{service.pid}</p>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border/60">
          {service.status !== 'running' && (
            <Button
              size="sm"
              variant="default"
              onClick={() => onAction(service.name, 'start')}
              disabled={isLoading}
              data-testid={`button-start-${service.name}`}
              className="h-7 text-xs font-heading tracking-wide"
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
                className="h-7 text-xs font-heading tracking-wide"
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
                className="h-7 text-xs font-heading tracking-wide"
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
                  className="h-7 text-xs font-heading tracking-wide"
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
