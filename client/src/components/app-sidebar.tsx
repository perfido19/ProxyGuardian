import { LayoutDashboard, Server, Shield, AlertTriangle, FileText, Users, Network, Search, ShieldCheck, Globe, Rocket, Settings2, TerminalSquare, RotateCw, CloudUpload } from "lucide-react";
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarHeader, SidebarFooter } from "@/components/ui/sidebar";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";

const menuItems = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "Servizi", url: "/servizi", icon: Server },
  { title: "Firewall", url: "/firewall", icon: Shield },
  { title: "ASN Block", url: "/asn-block", icon: Globe },
  { title: "Fail2ban", url: "/fail2ban", icon: AlertTriangle },
  { title: "Log", url: "/log", icon: FileText },
  { title: "Ricerca", url: "/ricerca", icon: Search },
  { title: "VPS", url: "/vps", icon: Network },
];

export function AppSidebar() {
  const [location] = useLocation();
  const { user } = useAuth();
  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-5 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary/15 border border-primary/30">
            <ShieldCheck className="w-4 h-4 text-primary" />
          </div>
          <div>
            <div className="text-sm font-bold font-heading tracking-wide text-foreground leading-none">ProxyGuardian</div>
            <div className="text-[10px] text-muted-foreground tracking-widest uppercase mt-0.5">Security Ops</div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="pt-4">
          <SidebarGroupLabel className="text-[10px] tracking-widest uppercase text-muted-foreground px-4 mb-1 font-heading">
            Navigazione
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {menuItems.map(item => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={location === item.url}
                    data-testid={`link-${item.title.toLowerCase().replace(" ", "-")}`}
                    className="font-heading text-sm tracking-wide"
                  >
                    <Link href={item.url}>
                      <item.icon className="w-4 h-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {user?.role === "admin" && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location === "/utenti"}
                    data-testid="link-utenti"
                    className="font-heading text-sm tracking-wide"
                  >
                    <Link href="/utenti">
                      <Users className="w-4 h-4" />
                      <span>Utenti</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {user?.role === "admin" && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location === "/fleet-upgrade"}
                    data-testid="link-fleet-upgrade"
                    className="font-heading text-sm tracking-wide"
                  >
                    <Link href="/fleet-upgrade">
                      <Rocket className="w-4 h-4" />
                      <span>Fleet Upgrade</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {user?.role === "admin" && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location === "/fleet-config"}
                    data-testid="link-fleet-config"
                    className="font-heading text-sm tracking-wide"
                  >
                    <Link href="/fleet-config">
                      <Settings2 className="w-4 h-4" />
                      <span>Fleet Config</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {user?.role === "admin" && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location === "/logrotate"}
                    data-testid="link-logrotate"
                    className="font-heading text-sm tracking-wide"
                  >
                    <Link href="/logrotate">
                      <RotateCw className="w-4 h-4" />
                      <span>Logrotate</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {user?.role === "admin" && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location === "/ssh-console"}
                    data-testid="link-ssh-console"
                    className="font-heading text-sm tracking-wide"
                  >
                    <Link href="/ssh-console">
                      <TerminalSquare className="w-4 h-4" />
                      <span>Console SSH</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {user?.role === "admin" && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location === "/deploy"}
                    data-testid="link-deploy"
                    className="font-heading text-sm tracking-wide"
                  >
                    <Link href="/deploy">
                      <CloudUpload className="w-4 h-4" />
                      <span>Deploy VPS</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="px-4 py-3 border-t border-sidebar-border">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
          <span className="text-[10px] text-muted-foreground font-mono tracking-wider">SISTEMA ONLINE</span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
