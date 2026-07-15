import type { AttachmentDto, MessageDto, ThreadSummary } from "../shared/types";
import type { AttachmentRow, MessageRow, ThreadRow } from "./store";

// Row -> wire DTO mappers. Dates cross the wire as ISO strings.

export function toThreadSummary(row: ThreadRow): ThreadSummary {
  return {
    id: row.id,
    subject: row.subject,
    customerEmail: row.customerEmail,
    customerName: row.customerName,
    status: row.status,
    unread: row.unread,
    inboundAddress: row.inboundAddress,
    lastMessageAt: row.lastMessageAt.toISOString(),
    lastMessageSnippet: row.lastMessageSnippet,
    messageCount: row.messageCount,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toAttachmentDto(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    contentDisposition: row.contentDisposition,
    contentId: row.contentId,
    sizeBytes: row.sizeBytes,
  };
}

export function toMessageDto(row: MessageRow, attachments: AttachmentRow[]): MessageDto {
  return {
    id: row.id,
    threadId: row.threadId,
    direction: row.direction,
    fromEmail: row.fromEmail,
    fromName: row.fromName,
    toEmails: row.toEmails,
    ccEmails: row.ccEmails,
    subject: row.subject,
    textBody: row.textBody,
    htmlBody: row.htmlBody,
    bodyTruncated: row.bodyTruncated,
    snippet: row.snippet,
    actorLabel: row.actorLabel,
    sentAt: row.sentAt.toISOString(),
    attachments: attachments.map(toAttachmentDto),
  };
}
