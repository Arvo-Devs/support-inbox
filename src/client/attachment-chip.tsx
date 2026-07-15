"use client";

import { useState } from "react";
import { Loader2, Paperclip } from "lucide-react";

import { toast } from "../ui/ui-deps";
import type { AttachmentDto } from "../shared/types";
import { ApiRequestError, getApiErrorMessage, getAttachmentUrl } from "./api";
import { useSupportInboxBasePath } from "./context";
import { formatBytes } from "./format";

export type AttachmentChipProps = { attachment: AttachmentDto };

export function AttachmentChip({ attachment }: AttachmentChipProps) {
  const basePath = useSupportInboxBasePath();
  const [pending, setPending] = useState(false);

  async function handleOpen() {
    if (pending) return;
    setPending(true);
    try {
      const { url } = await getAttachmentUrl(basePath, attachment.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 410) {
        toast.error("This attachment is no longer available");
      } else {
        toast.error(getApiErrorMessage(error, "Could not open the attachment"));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleOpen}
      disabled={pending}
      aria-busy={pending}
      title={attachment.filename}
      aria-label={`Open attachment ${attachment.filename}`}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-60"
    >
      {pending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
      ) : (
        <Paperclip className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="max-w-48 truncate">{attachment.filename}</span>
      {attachment.sizeBytes != null ? (
        <span className="shrink-0 text-muted-foreground">{formatBytes(attachment.sizeBytes)}</span>
      ) : null}
    </button>
  );
}
