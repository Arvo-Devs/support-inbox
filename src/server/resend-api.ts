import { Resend } from "resend";

import { isRecord, readString } from "./json";

// Typed wrapper over Resend. Sending goes through the official SDK (same
// idiom as apps/dashboard/src/server/notifications/dispatch.ts, including the
// idempotencyKey second-arg options object); receiving endpoints go through
// raw fetch against https://api.resend.com because the SDK may not cover
// inbound mail yet.
//
// FIELD-MAPPING ASSUMPTIONS (the inbound API surface is young; a captured
// live fixture will validate these later):
// - `from` may be a raw string ("Name <a@b.c>"), or an object with
//   `email`/`address` (+ optional `name`). Raw strings are kept verbatim;
//   objects are composed as `name <email>` or the bare email.
// - `to` / `cc` / `received_for` may be a single string or an array of
//   strings (object entries with `email`/`name` are tolerated too).
// - `reply_to` may be a string or an array of strings; we take the first.
// - `message_id` / `in_reply_to` / `references` may appear top-level in
//   snake_case (camelCase tolerated) OR inside a `headers` array of
//   `{ name, value }` entries — both are checked, header names
//   case-insensitively.
// - `created_at` is top-level.
// - Attachment metadata may come embedded on the email object as an
//   `attachments` array: `id`, `filename`, `content_type`,
//   `content_disposition`, `content_id`, `size` (or `size_bytes`).
// - List responses may be `{ data: [...] }` or `{ data: { data: [...] } }`,
//   optionally carrying `has_more` at either level; we unwrap defensively.
//   Pagination uses `after=<last email id>`.

const RESEND_API_BASE_URL = "https://api.resend.com";

const DEFAULT_LIST_LIMIT = 50;

export class ResendApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ResendApiError";
    this.status = status;
  }
}

export type ReceivedEmailSummary = {
  id: string;
  from: string | null;
  createdAt: string | null;
};

export type ReceivedAttachmentMeta = {
  id: string;
  filename: string | null;
  contentType: string | null;
  contentDisposition: string | null;
  contentId: string | null;
  sizeBytes: number | null;
};

export type ReceivedEmail = {
  id: string;
  from: string | null;
  to: string[];
  cc: string[];
  replyTo: string | null;
  receivedFor: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  createdAt: string | null;
  attachments: ReceivedAttachmentMeta[];
};

export type ReceivedAttachmentLink = {
  id: string;
  filename: string | null;
  contentType: string | null;
  url: string | null;
  expiresAt: string | null;
};

export type SendReplyArgs = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  headers: Record<string, string>;
};

export type ResendApi = {
  /** GET /emails/receiving/{id} — full inbound email content. */
  getReceivedEmail(id: string): Promise<ReceivedEmail>;
  /** GET /emails/receiving — newest first, paginated with `after=<id>`. */
  listReceivedEmails(args?: {
    limit?: number;
    after?: string;
  }): Promise<{ emails: ReceivedEmailSummary[]; hasMore: boolean; nextCursor: string | null }>;
  /** GET /emails/receiving/{id}/attachments — fresh signed URLs + expires_at. */
  listAttachments(emailId: string): Promise<ReceivedAttachmentLink[]>;
  sendReply(args: SendReplyArgs, idempotencyKey: string): Promise<{ id: string }>;
};

/** Bodies are kept verbatim (no trimming); empty strings collapse to null. */
function readBody(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Prefer the snake_case field, tolerate camelCase. */
function readField(raw: Record<string, unknown>, snake: string, camel: string): unknown {
  return raw[snake] !== undefined ? raw[snake] : raw[camel];
}

/** from: raw string kept verbatim; {email|address, name?} composed. */
function readAddressString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value.trim() : null;
  if (isRecord(value)) {
    const email = readString(value.email) ?? readString(value.address);
    if (!email) return null;
    const name = readString(value.name);
    return name ? `${name} <${email}>` : email;
  }
  return null;
}

/** to/cc/received_for/reply_to: string | string[] (object entries tolerated). */
function readStringList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const entry of value) {
      const address = readAddressString(entry);
      if (address) out.push(address);
    }
    return out;
  }
  return [];
}

/** Case-insensitive lookup inside a `headers` array of { name, value }. */
function readHeaderValue(raw: Record<string, unknown>, name: string): string | null {
  const headers = raw.headers;
  if (!Array.isArray(headers)) return null;
  const wanted = name.toLowerCase();
  for (const entry of headers) {
    if (!isRecord(entry)) continue;
    if (readString(entry.name)?.toLowerCase() !== wanted) continue;
    const value = readString(entry.value);
    if (value) return value;
  }
  return null;
}

function mapAttachmentMeta(value: unknown): ReceivedAttachmentMeta[] {
  if (!Array.isArray(value)) return [];
  const out: ReceivedAttachmentMeta[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    // A signed download URL can't be fetched later without an id.
    const id = readString(entry.id);
    if (!id) continue;
    out.push({
      id,
      filename: readString(readField(entry, "filename", "fileName")) ?? readString(entry.name),
      contentType: readString(readField(entry, "content_type", "contentType")),
      contentDisposition: readString(readField(entry, "content_disposition", "contentDisposition")),
      contentId: readString(readField(entry, "content_id", "contentId")),
      sizeBytes: readNumber(readField(entry, "size", "sizeBytes")) ?? readNumber(entry.size_bytes),
    });
  }
  return out;
}

function mapReceivedEmail(raw: unknown): ReceivedEmail {
  if (!isRecord(raw)) {
    throw new ResendApiError("resend returned an unexpected received email shape", 502);
  }
  const id = readString(raw.id);
  if (!id) {
    throw new ResendApiError("resend returned a received email without an id", 502);
  }
  return {
    id,
    from: readAddressString(raw.from),
    to: readStringList(raw.to),
    cc: readStringList(raw.cc),
    replyTo: readStringList(readField(raw, "reply_to", "replyTo"))[0] ?? null,
    receivedFor: readStringList(readField(raw, "received_for", "receivedFor")),
    subject: readString(raw.subject),
    text: readBody(raw.text),
    html: readBody(raw.html),
    messageId:
      readString(readField(raw, "message_id", "messageId")) ?? readHeaderValue(raw, "message-id"),
    inReplyTo:
      readString(readField(raw, "in_reply_to", "inReplyTo")) ?? readHeaderValue(raw, "in-reply-to"),
    references: readString(raw.references) ?? readHeaderValue(raw, "references"),
    createdAt: readString(readField(raw, "created_at", "createdAt")),
    attachments: mapAttachmentMeta(raw.attachments),
  };
}

function errorMessageFromBody(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    return (
      readString(parsed.message) ??
      (isRecord(parsed.error) ? readString(parsed.error.message) : readString(parsed.error))
    );
  } catch {
    return null;
  }
}

/** { data: [...] } or { data: { data: [...] } }, has_more at either level. */
function unwrapListPayload(body: unknown): { items: unknown[]; hasMore: boolean | null } {
  if (!isRecord(body)) return { items: [], hasMore: null };
  let level: Record<string, unknown> = body;
  if (isRecord(body.data) && !Array.isArray(body.data)) {
    level = body.data;
  }
  const items = Array.isArray(level.data) ? level.data : Array.isArray(body.data) ? body.data : [];
  const hasMore =
    typeof level.has_more === "boolean"
      ? level.has_more
      : typeof body.has_more === "boolean"
        ? body.has_more
        : null;
  return { items, hasMore };
}

export function createResendApi(apiKey: string): ResendApi {
  const resend = new Resend(apiKey);

  async function getJson(path: string): Promise<unknown> {
    const response = await fetch(`${RESEND_API_BASE_URL}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ResendApiError(
        errorMessageFromBody(text) ?? `resend responded ${response.status}`,
        response.status,
      );
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ResendApiError("resend returned a non-JSON response body", 502);
    }
  }

  return {
    async getReceivedEmail(id) {
      const body = await getJson(`/emails/receiving/${encodeURIComponent(id)}`);
      // The email object may come direct or wrapped in { data: {...} }.
      const raw =
        isRecord(body) && !readString(body.id) && isRecord(body.data) ? body.data : body;
      return mapReceivedEmail(raw);
    },

    async listReceivedEmails(args = {}) {
      const limit = args.limit ?? DEFAULT_LIST_LIMIT;
      const params = new URLSearchParams({ limit: String(limit) });
      if (args.after) params.set("after", args.after);
      const body = await getJson(`/emails/receiving?${params.toString()}`);
      const { items, hasMore: reportedHasMore } = unwrapListPayload(body);
      const emails: ReceivedEmailSummary[] = [];
      for (const item of items) {
        if (!isRecord(item)) continue;
        const id = readString(item.id);
        if (!id) continue;
        emails.push({
          id,
          from: readAddressString(item.from),
          createdAt: readString(readField(item, "created_at", "createdAt")),
        });
      }
      const hasMore = reportedHasMore ?? emails.length === limit;
      const last = emails.length > 0 ? emails[emails.length - 1] : undefined;
      return { emails, hasMore, nextCursor: hasMore && last ? last.id : null };
    },

    async listAttachments(emailId) {
      const body = await getJson(`/emails/receiving/${encodeURIComponent(emailId)}/attachments`);
      const { items } = unwrapListPayload(body);
      const links: ReceivedAttachmentLink[] = [];
      for (const item of items) {
        if (!isRecord(item)) continue;
        const id = readString(item.id);
        if (!id) continue;
        links.push({
          id,
          filename: readString(readField(item, "filename", "fileName")) ?? readString(item.name),
          contentType: readString(readField(item, "content_type", "contentType")),
          url: readString(readField(item, "url", "downloadUrl")) ?? readString(item.download_url),
          expiresAt: readString(readField(item, "expires_at", "expiresAt")),
        });
      }
      return links;
    },

    async sendReply(args, idempotencyKey) {
      const response = await resend.emails.send(
        {
          from: args.from,
          to: args.to,
          subject: args.subject,
          text: args.text,
          headers: args.headers,
        },
        { idempotencyKey },
      );
      if (response.error) {
        throw new ResendApiError(response.error.message, 502);
      }
      if (!response.data) {
        throw new ResendApiError("resend send returned no data", 502);
      }
      return { id: response.data.id };
    },
  };
}
