import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

interface MobileDataCardProps {
  title: string;
  subtitle?: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  expandable?: boolean;
  children?: React.ReactNode;
}

export function MobileDataCard({
  title,
  subtitle,
  badge,
  actions,
  expandable = false,
  children,
}: MobileDataCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border rounded-md bg-card overflow-hidden">
      <div
        className={`flex items-start justify-between gap-2 px-3 py-2.5 ${expandable ? "cursor-pointer active:bg-muted/50" : ""}`}
        onClick={expandable ? () => setExpanded(v => !v) : undefined}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm text-foreground truncate">{title}</span>
            {badge}
          </div>
          {subtitle && (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{subtitle}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {actions && <div onClick={e => e.stopPropagation()}>{actions}</div>}
          {expandable && (
            <button className="text-muted-foreground p-0.5">
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          )}
        </div>
      </div>
      {expandable && expanded && children && (
        <div className="border-t border-border px-3 py-2.5 bg-muted/20 text-xs space-y-1.5">
          {children}
        </div>
      )}
      {!expandable && children && (
        <div className="border-t border-border px-3 py-2.5 text-xs space-y-1.5">
          {children}
        </div>
      )}
    </div>
  );
}

export function MobileDataCardRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="font-mono text-foreground text-right">{value}</span>
    </div>
  );
}
