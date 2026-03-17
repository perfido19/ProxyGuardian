import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
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
import Configurations from "@/pages/configurations";
import UserManagement from "@/pages/user-management";
import VpsManager from "@/pages/vps-manager";
import VpsDetail from "@/pages/vps-detail";
import BulkOperations from "@/pages/bulk-operations";
import NotFound from "@/pages/not-found";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LogOut, User } from "lucide-react";

const roleLabels = { admin: "Admin", operator: "Operator", viewer: "Viewer" } as const;

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
      <Route path="/fail2ban" component={Fail2banManagement} />
      <Route path="/log" component={Logs} />
      <Route path="/configurazioni" component={Configurations} />
      <Route path="/vps" component={VpsManager} />
      <Route path="/vps/:id" component={VpsDetail} />
      <Route path="/bulk" component={BulkOperations} />
      {user?.role === "admin" && <Route path="/utenti" component={UserManagement} />}
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
          <main className="flex-1 overflow-auto p-8 bg-background">
            <div className="mx-auto max-w-7xl"><Router /></div>
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
