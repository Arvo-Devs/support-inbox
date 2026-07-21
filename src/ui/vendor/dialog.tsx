"use client";

// Vendored from infra-agent packages/ui/src/ui/dialog.tsx at commit 1cbc809; only imports rewritten.
import * as React from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";

import { cn } from "./utils";
import { Button } from "./button";

/**
 * Modal dialog built on Base UI's AlertDialog (no outside-click dismissal, so
 * an accidental click can't discard in-progress choices). Use `Dialog` for
 * rich content and `ConfirmDialog` for plain confirm/cancel prompts.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <AlertDialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2",
            "max-h-[calc(100vh-4rem)] overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-xl outline-none",
            className,
          )}
        >
          <AlertDialog.Title className="text-base font-semibold text-foreground">
            {title}
          </AlertDialog.Title>
          {description ? (
            <AlertDialog.Description className="mt-1 text-sm text-muted-foreground">
              {description}
            </AlertDialog.Description>
          ) : null}
          {children}
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  tone = "default",
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  body: React.ReactNode;
  confirmLabel: string;
  tone?: "default" | "danger";
  onConfirm: () => void;
  pending?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={body}>
      <div className="mt-5 flex justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant={tone === "danger" ? "danger" : "default"}
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? "Working…" : confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
