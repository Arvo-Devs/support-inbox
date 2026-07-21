// Vendored from infra-agent packages/ui/src/ui/badge.tsx at commit 1cbc809; only imports rewritten.
import * as React from "react";

import { cn } from "./utils";

const tones = {
  up: "border-success-border bg-success-soft text-success-strong",
  down: "border-danger-border bg-danger-soft text-danger-strong",
  degraded: "border-warning-border bg-warning-soft text-warning-strong",
  pending: "border-border bg-muted text-muted-foreground",
  paused: "border-border bg-muted text-muted-foreground",
  neutral: "border-border bg-card text-muted-foreground",
};

export function Badge({
  className,
  tone = "neutral",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof tones }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full border px-2.5 text-xs font-medium",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
