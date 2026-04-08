import { MobileHeader } from "./mobile-header";
import { BottomTabBar } from "./bottom-tab-bar";
import { useUpgrade } from "@/contexts/upgrade-context";
import { useLocation } from "wouter";
import { Rocket, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Progress } from "@/components/ui/progress";

function MobileUpgradeBanner() {
  const [location] = useLocation();
  const { pageState, vpsStates } = useUpgrade();

  if (pageState === "idle" || location === "/fleet-upgrade") return null;

  const vpsArray = Array.from(vpsStates.values());
  const total = vpsArray.length;
  const done = vpsArray.filter(v => v.status === "success" || v.status === "failed").length;
  const successCount = vpsArray.filter(v => v.status === "success").length;
  const failCount = vpsArray.filter(v => v.status === "failed").length;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;
  const isDone = pageState === "done";

  return (
    <a href="/fleet-upgrade" className="block">
      <div className={`px-3 py-1.5 border-b flex items-center gap-2 text-xs cursor-pointer ${isDone ? "bg-green-950/40 border-green-500/30" : "bg-blue-950/40 border-blue-500/30"}`}>
        <Rocket className="w-3 h-3 shrink-0 text-blue-400" />
        <span className="font-heading font-medium text-foreground/80 shrink-0">Fleet Upgrade</span>
        {total > 0 && (
          <>
            <div className="flex-1">
              <Progress value={progress} className="h-1.5" />
            </div>
            <span className="font-mono text-muted-foreground shrink-0">{done}/{total}</span>
          </>
        )}
        {isDone
          ? <span className="text-green-400 font-heading shrink-0 ml-auto">
              <CheckCircle2 className="w-3 h-3 inline mr-0.5" />{successCount}✓{failCount > 0 && <span className="text-red-400 ml-1">{failCount}✗</span>}
            </span>
          : <Loader2 className="w-3 h-3 animate-spin text-blue-400 shrink-0 ml-auto" />
        }
      </div>
    </a>
  );
}

interface MobileShellProps {
  children: React.ReactNode;
}

export function MobileShell({ children }: MobileShellProps) {
  return (
    <div className="flex flex-col h-screen w-full bg-background">
      <MobileHeader />
      <MobileUpgradeBanner />
      <main className="flex-1 overflow-auto p-3">
        {children}
      </main>
      {/* Spacer per la bottom tab bar fissa (h-14 + safe area) */}
      <div className="h-14 shrink-0" />
      <BottomTabBar />
    </div>
  );
}
