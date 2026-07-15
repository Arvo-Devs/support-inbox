import type { ResolvedSupportInboxConfig, SupportInboxCustomerLink } from "../../config";
import type {
  ThreadDetailResponse,
  ThreadListResponse,
  UnreadCountResponse,
} from "../../shared/types";
import type { RouterDeps } from "../router";
import { toMessageDto, toThreadSummary } from "../serialize";
import type { AttachmentRow, ThreadListFilter, ThreadRow } from "../store";

// Read-side thread routes: list (cursor-paginated), unread badge count, and
// the detail view (messages ASC with grouped attachments).

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MAX_QUERY_LENGTH = 200;

/** Opaque list cursor: base64url of `${lastMessageAt ISO}|${threadId}`. */
export function encodeCursor(row: ThreadRow): string {
  return Buffer.from(`${row.lastMessageAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

export function decodeCursor(value: string): { lastMessageAt: Date; id: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf("|");
  if (separator <= 0 || separator === decoded.length - 1) return null;
  const lastMessageAt = new Date(decoded.slice(0, separator));
  if (Number.isNaN(lastMessageAt.getTime())) return null;
  return { lastMessageAt, id: decoded.slice(separator + 1) };
}

export async function listThreads(
  deps: RouterDeps,
  config: ResolvedSupportInboxConfig,
  url: URL,
): Promise<Response> {
  const statusRaw = url.searchParams.get("status");
  const status = statusRaw ?? "open";
  if (status !== "open" && status !== "closed" && status !== "spam" && status !== "all") {
    return Response.json({ error: "Invalid status" }, { status: 400 });
  }

  const qRaw = url.searchParams.get("q");
  let q: string | null = null;
  if (qRaw !== null) {
    const trimmed = qRaw.trim().slice(0, MAX_QUERY_LENGTH);
    q = trimmed.length > 0 ? trimmed : null;
  }

  const limitRaw = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isNaN(parsed)) limit = Math.min(MAX_LIMIT, Math.max(1, parsed));
  }

  const cursorRaw = url.searchParams.get("cursor");
  let cursor: ThreadListFilter["cursor"] = null;
  if (cursorRaw !== null && cursorRaw !== "") {
    cursor = decodeCursor(cursorRaw);
    if (!cursor) return Response.json({ error: "Invalid cursor" }, { status: 400 });
  }

  // Over-fetch by one row to detect whether another page exists.
  const rows = await deps.store.listThreads({ status, q, cursor, limit: limit + 1 });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last) : null;

  return Response.json({
    threads: page.map(toThreadSummary),
    nextCursor,
  } satisfies ThreadListResponse);
}

export async function unreadCount(deps: RouterDeps): Promise<Response> {
  const count = await deps.store.countUnreadOpen();
  return Response.json({ count } satisfies UnreadCountResponse);
}

export async function threadDetail(
  deps: RouterDeps,
  config: ResolvedSupportInboxConfig,
  threadId: string,
): Promise<Response> {
  const thread = await deps.store.getThread(threadId);
  if (!thread) return Response.json({ error: "Thread not found" }, { status: 404 });

  const messages = await deps.store.listMessages(threadId);
  const attachmentRows = await deps.store.listAttachmentsForMessages(
    messages.map((message) => message.id),
  );
  const grouped = new Map<string, AttachmentRow[]>();
  for (const attachment of attachmentRows) {
    const bucket = grouped.get(attachment.messageId);
    if (bucket) bucket.push(attachment);
    else grouped.set(attachment.messageId, [attachment]);
  }

  // A customer-lookup failure must never break the thread view.
  let customer: SupportInboxCustomerLink | null = null;
  if (config.lookupCustomer) {
    try {
      customer = await config.lookupCustomer(thread.customerEmail);
    } catch {
      customer = null;
    }
  }

  return Response.json({
    thread: toThreadSummary(thread),
    customer,
    messages: messages.map((message) => toMessageDto(message, grouped.get(message.id) ?? [])),
  } satisfies ThreadDetailResponse);
}
