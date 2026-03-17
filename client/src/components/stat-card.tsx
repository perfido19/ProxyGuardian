import { LucideIcon } from "lucide-react";

interface StatCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  description?: string;
  testId?: string;
}

export function StatCard({ title, value, icon: Icon, description, testId }: StatCardProps) {
  return (
    <div className="relative bg-card border border-card-border rounded-md overflow-hidden group hover:border-primary/40 transition-all duration-200">
      {/* Left accent bar */}
      <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-primary opacity-70 group-hover:opacity-100 transition-opacity" />
      <div className="pl-5 pr-5 py-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-[0.12em] mb-2 font-heading">
              {title}
            </p>
            <p className="stat-number text-[2.25rem] leading-none font-bold text-foreground" data-testid={testId}>
              {value}
            </p>
            {description && (
              <p className="text-xs text-muted-foreground mt-2">{description}</p>
            )}
          </div>
          <div className="p-2.5 rounded-md bg-primary/10 text-primary shrink-0 mt-0.5 border border-primary/20">
            <Icon className="w-4 h-4" />
          </div>
        </div>
      </div>
    </div>
  );
}
