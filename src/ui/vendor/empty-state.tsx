// Vendored from infra-agent packages/ui/src/ui/empty-state.tsx at commit 1cbc809; only imports rewritten.
import type { LucideIcon } from "lucide-react";
import { Radar } from "lucide-react";

import { cn } from "./utils";

export function EmptyState({
  title,
  body,
  icon: Icon = Radar,
  action,
  compact = false,
  className,
}: {
  title: string;
  body: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card text-center",
        compact ? "p-6" : "min-h-52 p-8",
        className,
      )}
    >
      <Icon className={cn("text-muted-foreground", compact ? "mb-2 h-6 w-6" : "mb-3 h-8 w-8")} />
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
