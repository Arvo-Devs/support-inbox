// Wire DTOs shared between the REST routes and the client components.
// Dates cross the wire as ISO strings; the server serializes rows via
// server/serialize.ts and the client consumes these shapes verbatim.

export type ThreadStatus = "open" | "closed" | "spam";

export type MessageDirection = "inbound" | "outbound";

export type ThreadSummary = {
  id: string;
  subject: string;
  customerEmail: string;
  customerName: string | null;
  status: ThreadStatus;
  unread: boolean;
  inboundAddress: string | null;
  lastMessageAt: string;
  lastMessageSnippet: string | null;
  messageCount: number;
  createdAt: string;
};

export type AttachmentDto = {
  id: string;
  filename: string;
  contentType: string | null;
  contentDisposition: string | null;
  contentId: string | null;
  sizeBytes: number | null;
};

export type MessageDto = {
  id: string;
  threadId: string;
  direction: MessageDirection;
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  bodyTruncated: boolean;
  snippet: string | null;
  actorLabel: string | null;
  sentAt: string;
  attachments: AttachmentDto[];
};

export type CustomerLink = { label: string; href: string };

export type ThreadListResponse = {
  threads: ThreadSummary[];
  nextCursor: string | null;
};

export type UnreadCountResponse = { count: number };

export type ThreadDetailResponse = {
  thread: ThreadSummary;
  customer: CustomerLink | null;
  messages: MessageDto[];
};

export type ReplyResponse = { message: MessageDto };

/** POST /threads — a newly composed thread and its first outbound message. */
export type ComposeResponse = { thread: ThreadSummary; message: MessageDto };

export type ThreadResponse = { thread: ThreadSummary };

export type SyncResponse = {
  scanned: number;
  imported: number;
  skipped: number;
  /** Emails whose ingest errored this run; they stay unknown and retry next run. */
  failed: number;
};

export type AttachmentUrlResponse = {
  url: string;
  filename: string;
  contentType: string | null;
  expiresAt: string | null;
};

/**
 * GET and POST `/connection` (Reacharound mode only): what the Email page's
 * Settings shows. Never the key itself; its last four characters at most.
 */
export type ConnectionProblem = "no_key" | "key_unreadable" | "key_refused" | "unreachable";

export type ConnectionResponse = {
  /** A key is saved and Reacharound accepted it just now. */
  connected: boolean;
  problem: ConnectionProblem | null;
  key: { hint: string; savedAt: string; savedBy: string | null } | null;
};

/** `code` says why Reacharound mode can't answer (server/reacharound.ts); absent otherwise. */
export type ApiError = { error: string; code?: string };
