"use client";

import { Badge, Card, CardContent, cn } from "../ui/ui-deps";
import type { MessageDto } from "../shared/types";
import { AttachmentChip } from "./attachment-chip";
import { formatFullDateTime, formatShortDateTime } from "./format";
import { HtmlBodyFrame } from "./html-body-frame";

export type MessageItemProps = { message: MessageDto };

export function MessageItem({ message }: MessageItemProps) {
  const outbound = message.direction === "outbound";

  return (
    <Card className={cn(outbound && "border-primary/20 bg-primary/5")}>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span
              className="min-w-0 truncate text-sm font-medium text-foreground"
              title={message.fromEmail}
            >
              {message.fromName ?? message.fromEmail}
            </span>
            {outbound ? (
              <>
                <Badge tone="neutral" className="h-5 px-1.5 text-[11px]">
                  Support
                </Badge>
                {message.actorLabel ? (
                  <span className="text-xs text-muted-foreground">{message.actorLabel}</span>
                ) : null}
              </>
            ) : null}
          </div>
          <span
            className="shrink-0 text-xs text-muted-foreground"
            title={formatFullDateTime(message.sentAt)}
          >
            {formatShortDateTime(message.sentAt)}
          </span>
        </div>

        {message.toEmails.length > 0 || message.ccEmails.length > 0 ? (
          // CC participants are displayed but v1 replies go to the sender only.
          <div className="text-xs text-muted-foreground">
            to {message.toEmails.join(", ")}
            {message.ccEmails.length > 0 ? ` · cc ${message.ccEmails.join(", ")}` : ""}
          </div>
        ) : null}

        {message.htmlBody ? (
          <HtmlBodyFrame html={message.htmlBody} />
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
      </CardContent>
    </Card>
  );
}
