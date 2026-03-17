import { LayoutDashboard, Server, Shield, AlertTriangle, FileText, Settings, Users, Network, Zap } from "lucide-react";
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";

const menuItems = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "Servizi", url: "/servizi", icon: Server },
  { title: "Firewall", url: "/firewall", icon: Shield },
  { title: "Fail2ban", url: "/fail2ban", icon: AlertTriangle },
  { title: "Log", url: "/log", icon: FileText },
  { title: "Configurazioni", url: "/configurazioni", icon: Settings },
  { title: "VPS", url: "/vps", icon: Network },
  { title: "Bulk Ops", url: "/bulk", icon: Zap },
];

export function AppSidebar() {
  const [location] = useLocation();
  const { user } = useAuth();
  return (
    <Sidebar>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-base font-semibold px-4 py-4">ProxyGuardian</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {menuItems.map(item => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild isActive={location === item.url} data-testid={`link-${item.title.toLowerCase().replace(" ", "-")}`}>
                    <Link href={item.url}><item.icon className="w-4 h-4" /><span>{item.title}</span></Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {user?.role === "admin" && (
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={location === "/utenti"} data-testid="link-utenti">
                    <Link href="/utenti"><Users className="w-4 h-4" /><span>Utenti</span></Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
