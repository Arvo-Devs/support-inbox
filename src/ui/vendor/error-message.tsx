"use client";

// Vendored from infra-agent packages/ui/src/ui/error-message.tsx at commit 1cbc809; only imports rewritten.
import { AlertCircle } from "lucide-react";

import { getErrorMessage } from "./client-errors";

export function ErrorMessage({
  error,
  title = "Something went wrong",
}: {
  error: unknown;
  title?: string;
}) {
  return (
    <div className="rounded-lg border border-danger-border bg-danger-soft p-3 text-sm">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
        <div>
          <div className="font-semibold text-foreground">{title}</div>
          <div className="mt-1 text-danger-strong">{getErrorMessage(error, title)}</div>
        </div>
      </div>
    </div>
  );
}
