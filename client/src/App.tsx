import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ProtectedRoute } from "@/components/protected-route";
import { useAuth } from "@/hooks/use-auth";
import Dashboard from "@/pages/dashboard";
import Services from "@/pages/services";
import Firewall from "@/pages/firewall";
import Fail2banManagement from "@/pages/fail2ban-management";
import Logs from "@/pages/logs";
import Ricerca from "@/pages/ricerca";
import UserManagement from "@/pages/user-management";
import VpsManager from "@/pages/vps-manager";
import AsnBlock from "@/pages/asn-block";
import VpsDetail from "@/pages/vps-detail";
import FleetUpgrade from "@/pages/fleet-upgrade";
import FleetConfig from "@/pages/fleet-config";
import NotFound from "@/pages/not-found";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { LogOut, User, Rocket, CheckCircle2, XCircle, Loader2 } from "lucide-react";

const roleLabels = { admin: "Admin", operator: "Operator", viewer: "Viewer" } as const;

// ─── Banner upgrade persistente ───────────────────────────────────────────────

function UpgradeBanner() {
  const [location] = useLocation();

  const { data: active } = useQuery<{ id: string; status: string }>({
    queryKey: ["upgrade-active"],
    queryFn: async () => {
      const res = await fetch("/api/fleet/upgrade/active");
      if (!res.ok) throw new Error("no active job");
      return res.json();
    },
    refetchInterval: 4000,
    retry: false,
  });

  const { data: snap } = useQuery<{
    status: string; total: number; successCount: number; failCount: number;
    vpsJobs: Array<{ vpsId: string; vpsName: string; status: string }>;
  }>({
    queryKey: ["upgrade-snap", active?.id],
    queryFn: async () => {
      const res = await fetch(`/api/fleet/upgrade/${active!.id}/status`);
      if (!res.ok) throw new Error("no snap");
      return res.json();
    },
    enabled: !!active?.id,
    refetchInterval: 2000,
  });

  // Nascondi se già sulla pagina fleet-upgrade
  if (!active || location === "/fleet-upgrade") return null;

  const total = snap?.total ?? 0;
  const done = (snap?.successCount ?? 0) + (snap?.failCount ?? 0);
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;
  const isDone = snap?.status === "done";

  const vpsStatusIcon = (status: string) => {
    if (status === "success") return <CheckCircle2 className="w-2.5 h-2.5 text-green-500" />;
    if (status === "failed") return <XCircle className="w-2.5 h-2.5 text-red-500" />;
    if (status === "running") return <Loader2 className="w-2.5 h-2.5 animate-spin text-blue-400" />;
    return <div className="w-2.5 h-2.5 rounded-full bg-muted-foreground/30" />;
  };

  return (
    <a href="/fleet-upgrade" className="block">
      <div className={`px-4 py-1.5 border-b flex items-center gap-3 text-xs cursor-pointer transition-colors ${isDone ? "bg-green-950/40 border-green-500/30 hover:bg-green-950/60" : "bg-blue-950/40 border-blue-500/30 hover:bg-blue-950/60"}`}>
        <Rocket className="w-3 h-3 shrink-0 text-blue-400" />
        <span className="font-heading font-medium text-foreground/80 shrink-0">Fleet Upgrade</span>
        {total > 0 && (
          <>
            <div className="flex-1 max-w-40">
              <Progress value={progress} className="h-1.5" />
            </div>
            <span className="font-mono text-muted-foreground shrink-0">{done}/{total}</span>
          </>
        )}
        {snap?.vpsJobs && snap.vpsJobs.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {snap.vpsJobs.map((vj) => (
              <span key={vj.vpsId} className="flex items-center gap-1 font-mono text-[10px] bg-black/20 rounded px-1.5 py-0.5">
                {vpsStatusIcon(vj.status)}
                {vj.vpsName}
              </span>
            ))}
          </div>
        )}
        {!isDone && <Loader2 className="w-3 h-3 animate-spin text-blue-400 shrink-0 ml-auto" />}
        {isDone && <span className="text-green-400 font-heading shrink-0 ml-auto">Completato</span>}
      </div>
    </a>
  );
}

function Header() {
  const { user, logout } = useAuth();
  return (
    <header className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-sidebar/80 backdrop-blur-sm shrink-0">
      <SidebarTrigger data-testid="button-sidebar-toggle" className="text-muted-foreground hover:text-foreground" />
      <div className="flex items-center gap-3">
        <span className="text-[11px] text-muted-foreground font-mono tracking-wider hidden sm:block">
          {new Date().toLocaleString("it-IT", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" })}
        </span>
        {user && (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-sm border border-border rounded-md px-2.5 py-1">
              <User className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="font-heading font-medium text-xs tracking-wide hidden sm:block">{user.username}</span>
              <Badge
                variant={user.role === "admin" ? "default" : user.role === "operator" ? "secondary" : "outline"}
                className="text-[10px] font-heading tracking-wide h-4 px-1.5"
              >
                {roleLabels[user.role]}
              </Badge>
            </div>
            <Button variant="ghost" size="sm" onClick={() => logout()} data-testid="button-logout" className="gap-1.5 h-7 text-xs font-heading">
              <LogOut className="w-3.5 h-3.5" /><span className="hidden sm:block">Esci</span>
            </Button>
          </div>
        )}
      </div>
    </header>
  );
}

function Router() {
  const { user } = useAuth();
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/servizi" component={Services} />
      <Route path="/firewall" component={Firewall} />
      <Route path="/asn-block" component={AsnBlock} />
      <Route path="/fail2ban" component={Fail2banManagement} />
      <Route path="/log" component={Logs} />
      <Route path="/ricerca" component={Ricerca} />
      <Route path="/vps" component={VpsManager} />
      <Route path="/vps/:id" component={VpsDetail} />
      {user?.role === "admin" && <Route path="/utenti" component={UserManagement} />}
      {user?.role === "admin" && <Route path="/fleet-upgrade" component={FleetUpgrade} />}
      {user?.role === "admin" && <Route path="/fleet-config" component={FleetConfig} />}
      <Route component={NotFound} />
    </Switch>
  );
}

function AppLayout() {
  return (
    <SidebarProvider style={{ "--sidebar-width": "16rem", "--sidebar-width-icon": "3rem" } as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 overflow-hidden">
          <Header />
          <UpgradeBanner />
          <main className="flex-1 overflow-auto p-8 bg-background">
            <Router />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ProtectedRoute><AppLayout /></ProtectedRoute>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
