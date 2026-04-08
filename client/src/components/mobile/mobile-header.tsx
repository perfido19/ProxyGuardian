import { useLocation } from "wouter";
import { ShieldCheck, Wifi } from "lucide-react";
import { useVpsList, useVpsHealth } from "@/hooks/use-vps";

const pageTitles: Record<string, string> = {
  "/": "Fleet Overview",
  "/servizi": "Servizi",
  "/firewall": "Firewall",
  "/asn-block": "ASN Block",
  "/fail2ban": "Fail2ban",
  "/log": "Log",
  "/ricerca": "Ricerca",
  "/vps": "VPS",
  "/utenti": "Utenti",
  "/fleet-upgrade": "Fleet Upgrade",
  "/fleet-config": "Fleet Config",
  "/logrotate": "Logrotate",
  "/ssh-console": "Console SSH",
  "/deploy": "Deploy VPS",
};

export function MobileHeader() {
  const [location] = useLocation();
  const { data: vpsList } = useVpsList();
  const { data: healthMap } = useVpsHealth();

  const title = pageTitles[location] ?? (location.startsWith("/vps/") ? "Dettaglio VPS" : "ProxyGuardian");
  const totalOnline = (vpsList || []).filter(v => healthMap?.[v.id]).length;
  const total = (vpsList || []).length;

  return (
    <header className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-sidebar/80 backdrop-blur-sm shrink-0">
      <div className="flex items-center gap-2.5">
        <div className="flex items-center justify-center w-7 h-7 rounded-md bg-primary/15 border border-primary/30">
          <ShieldCheck className="w-3.5 h-3.5 text-primary" />
        </div>
        <h1 className="text-sm font-heading font-bold tracking-wide text-foreground">{title}</h1>
      </div>
      {total > 0 && (
        <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
          <Wifi className="w-3.5 h-3.5 text-green-500" />
          <span className="text-green-400 font-medium">{totalOnline}</span>
          <span>/ {total}</span>
        </div>
      )}
    </header>
  );
}
