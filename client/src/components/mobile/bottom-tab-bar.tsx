import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard, Server, Shield, Search, Menu,
  Globe, AlertTriangle, FileText, Network,
  Rocket, Settings2, TerminalSquare, RotateCw, CloudUpload, Users, LogOut, User,
} from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";

const mainTabs = [
  { label: "Dashboard", url: "/", icon: LayoutDashboard },
  { label: "Servizi", url: "/servizi", icon: Server },
  { label: "Firewall", url: "/firewall", icon: Shield },
  { label: "Ricerca", url: "/ricerca", icon: Search },
];

const secondaryItems = [
  { title: "ASN Block", url: "/asn-block", icon: Globe },
  { title: "Fail2ban", url: "/fail2ban", icon: AlertTriangle },
  { title: "Log", url: "/log", icon: FileText },
  { title: "VPS", url: "/vps", icon: Network },
];

const adminItems = [
  { title: "Fleet Upgrade", url: "/fleet-upgrade", icon: Rocket },
  { title: "Fleet Config", url: "/fleet-config", icon: Settings2 },
  { title: "Logrotate", url: "/logrotate", icon: RotateCw },
  { title: "Console SSH", url: "/ssh-console", icon: TerminalSquare },
  { title: "Deploy VPS", url: "/deploy", icon: CloudUpload },
  { title: "Utenti", url: "/utenti", icon: Users },
];

const roleLabels = { admin: "Admin", operator: "Operator", viewer: "Viewer" } as const;

export function BottomTabBar() {
  const [location] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const { user, logout } = useAuth();

  const isActive = (url: string) =>
    url === "/" ? location === "/" : location.startsWith(url);

  return (
    <>
      <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-sidebar/95 backdrop-blur-sm pb-safe">
        <div className="flex items-stretch h-14">
          {mainTabs.map(tab => (
            <Link
              key={tab.url}
              href={tab.url}
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors ${
                isActive(tab.url)
                  ? "text-primary"
                  : "text-muted-foreground active:text-foreground"
              }`}
            >
              <tab.icon className="w-5 h-5" />
              <span className="text-[10px] font-heading tracking-wide">{tab.label}</span>
            </Link>
          ))}
          <button
            onClick={() => setMenuOpen(true)}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors ${
              menuOpen ? "text-primary" : "text-muted-foreground active:text-foreground"
            }`}
          >
            <Menu className="w-5 h-5" />
            <span className="text-[10px] font-heading tracking-wide">Menu</span>
          </button>
        </div>
      </nav>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="bottom" className="h-auto max-h-[80vh] pb-safe rounded-t-xl">
          <SheetHeader className="pb-3 border-b border-border">
            <SheetTitle className="font-heading text-sm tracking-wide flex items-center justify-between">
              <span>Menu</span>
              {user && (
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 text-xs border border-border rounded-md px-2 py-1">
                    <User className="w-3 h-3 text-muted-foreground" />
                    <span className="font-heading font-medium">{user.username}</span>
                    <Badge
                      variant={user.role === "admin" ? "default" : user.role === "operator" ? "secondary" : "outline"}
                      className="text-[10px] font-heading h-4 px-1.5"
                    >
                      {roleLabels[user.role]}
                    </Badge>
                  </div>
                </div>
              )}
            </SheetTitle>
          </SheetHeader>
          <div className="overflow-y-auto py-3">
            <div className="grid grid-cols-3 gap-2">
              {secondaryItems.map(item => (
                <Link
                  key={item.url}
                  href={item.url}
                  onClick={() => setMenuOpen(false)}
                  className={`flex flex-col items-center gap-1.5 px-2 py-3 rounded-lg border transition-colors ${
                    isActive(item.url)
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "border-border bg-muted/20 text-muted-foreground active:bg-muted"
                  }`}
                >
                  <item.icon className="w-5 h-5" />
                  <span className="text-[11px] font-heading tracking-wide text-center leading-tight">{item.title}</span>
                </Link>
              ))}
              {user?.role === "admin" && adminItems.map(item => (
                <Link
                  key={item.url}
                  href={item.url}
                  onClick={() => setMenuOpen(false)}
                  className={`flex flex-col items-center gap-1.5 px-2 py-3 rounded-lg border transition-colors ${
                    isActive(item.url)
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "border-border bg-muted/20 text-muted-foreground active:bg-muted"
                  }`}
                >
                  <item.icon className="w-5 h-5" />
                  <span className="text-[11px] font-heading tracking-wide text-center leading-tight">{item.title}</span>
                </Link>
              ))}
            </div>
            <div className="mt-4 pt-3 border-t border-border">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { logout(); setMenuOpen(false); }}
                className="w-full justify-start gap-2 text-muted-foreground h-9"
              >
                <LogOut className="w-4 h-4" />
                <span className="font-heading text-sm">Esci</span>
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
