"use client";

import { useState } from "react";
import { Maximize2, X } from "lucide-react";

import { Badge, Button, Card, Dialog, cn } from "../ui/ui-deps";
import type { MessageDto } from "../shared/types";
import { AttachmentChip } from "./attachment-chip";
import { messagePreview } from "./conversation";
import { formatFullDateTime, formatShortDateTime } from "./format";
import { HtmlBodyFrame } from "./html-body-frame";

export type MessageItemProps = {
  message: MessageDto;
  expanded: boolean;
  /** Absent when the message can't collapse (the only one in its conversation). */
  onToggle?: () => void;
};

export function MessageItem({ message, expanded, onToggle }: MessageItemProps) {
  const outbound = message.direction === "outbound";
  const sender = message.fromName ?? message.fromEmail;
  const [fullSize, setFullSize] = useState(false);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={false}
        className={cn(
          "flex w-full shrink-0 flex-col gap-0.5 rounded-2xl border border-border/70 bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/50",
          outbound && "border-primary/20 bg-primary/5",
        )}
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-sm font-medium text-foreground" title={message.fromEmail}>
            {sender}
            {outbound ? <span className="font-normal text-muted-foreground"> · Support</span> : null}
          </span>
          <span
            className="shrink-0 text-xs text-muted-foreground"
            title={formatFullDateTime(message.sentAt)}
          >
            {formatShortDateTime(message.sentAt)}
          </span>
        </span>
        <span className="truncate text-xs text-muted-foreground">{messagePreview(message)}</span>
      </button>
    );
  }

  // Sender, recipients and date share one line where they fit.
  const header = (
    <>
      <span className="min-w-0 truncate text-sm font-medium text-foreground" title={message.fromEmail}>
        {sender}
      </span>
      {outbound ? (
        <>
          <Badge tone="neutral" className="h-5 self-center px-1.5 text-[11px]">
            Support
          </Badge>
          {message.actorLabel ? (
            <span className="text-xs text-muted-foreground">{message.actorLabel}</span>
          ) : null}
        </>
      ) : null}
      {message.toEmails.length > 0 || message.ccEmails.length > 0 ? (
        // CC participants are displayed but v1 replies go to the sender only.
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          to {message.toEmails.join(", ")}
          {message.ccEmails.length > 0 ? ` · cc ${message.ccEmails.join(", ")}` : ""}
        </span>
      ) : null}
      <span
        className="ml-auto shrink-0 text-xs text-muted-foreground"
        title={formatFullDateTime(message.sentAt)}
      >
        {formatShortDateTime(message.sentAt)}
      </span>
    </>
  );
  const headerClass =
    "flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-left";

  return (
    // An HTML message takes the rest of the reading pane (a flex column in
    // thread-view.tsx), and its frame takes whatever the header leaves.
    <Card
      className={cn(
        "flex flex-col gap-2 p-3",
        message.htmlBody ? "flex-1" : "shrink-0",
        outbound && "border-primary/20 bg-primary/5",
      )}
    >
      <div className="flex items-center gap-2">
        {onToggle ? (
          <button type="button" onClick={onToggle} aria-expanded className={headerClass}>
            {header}
          </button>
        ) : (
          <div className={headerClass}>{header}</div>
        )}
        {message.htmlBody ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-my-1 shrink-0"
            onClick={() => setFullSize(true)}
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" /> Full size
          </Button>
        ) : null}
      </div>

      {message.htmlBody ? (
        <HtmlBodyFrame html={message.htmlBody} className="min-h-52 flex-1" />
      ) : (
        <pre className="whitespace-pre-wrap break-words font-sans text-sm text-foreground">
          {message.textBody ?? ""}
        </pre>
      )}

      {message.bodyTruncated ? (
        <div className="text-xs italic text-muted-foreground">Message truncated.</div>
      ) : null}

      {message.attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {message.attachments.map((attachment) => (
            <AttachmentChip key={attachment.id} attachment={attachment} />
          ))}
        </div>
      ) : null}

      {message.htmlBody ? (
        <Dialog
          open={fullSize}
          onOpenChange={setFullSize}
          title={<span className="block truncate pr-10">{message.subject}</span>}
          description={`${sender} · ${formatFullDateTime(message.sentAt)}`}
          className="flex h-[calc(100dvh-2rem)] max-h-none w-[min(72rem,calc(100vw-2rem))] flex-col overflow-hidden p-4 sm:p-5"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close"
            className="absolute right-2 top-2 sm:right-3 sm:top-3"
            onClick={() => setFullSize(false)}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
          <HtmlBodyFrame html={message.htmlBody} className="mt-3 min-h-0 flex-1" />
        </Dialog>
      ) : null}
    </Card>
  );
}
