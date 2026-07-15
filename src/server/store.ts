import { and, asc, desc, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";

import type { SupportInboxDb } from "../config";
import { supportAttachments, supportMessages, supportThreads } from "../schema";

// ALL drizzle queries live behind this interface so ingest/routes stay
// testable against a fake. Everything uses the query-builder API (never
// db.query.*), so any drizzle handle works without registering our schema.

export type ThreadRow = typeof supportThreads.$inferSelect;
export type MessageRow = typeof supportMessages.$inferSelect;
export type AttachmentRow = typeof supportAttachments.$inferSelect;

export type ThreadStatusValue = ThreadRow["status"];

export type NewThreadData = {
  subject: string;
  normalizedSubject: string;
  customerEmail: string;
  customerName: string | null;
  inboundAddress: string | null;
  lastMessageAt: Date;
  lastMessageSnippet: string | null;
};

export type NewInboundMessageData = {
  threadId: string;
  resendInboundId: string;
  messageId: string | null;
  inReplyTo: string | null;
  referencesHeader: string | null;
  replyTo: string | null;
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  bodyTruncated: boolean;
  snippet: string | null;
  sentAt: Date;
};

export type NewOutboundMessageData = {
  threadId: string;
  replyAttemptId: string;
  resendOutboundId: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  referencesHeader: string | null;
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  subject: string;
  textBody: string;
  snippet: string | null;
  actorId: string;
  actorLabel: string;
  sentAt: Date;
};

export type NewAttachmentData = {
  messageId: string;
  resendAttachmentId: string;
  filename: string;
  contentType: string | null;
  contentDisposition: string | null;
  contentId: string | null;
  sizeBytes: number | null;
};

export type ThreadListFilter = {
  status: ThreadStatusValue | "all";
  q: string | null;
  cursor: { lastMessageAt: Date; id: string } | null;
  /** Rows to return; callers pass pageSize + 1 to detect another page. */
  limit: number;
};

export type RollupData = {
  lastMessageAt: Date;
  snippet: string | null;
};

export interface SupportStore {
  /**
   * Run `fn` against a store bound to a transaction. Nested calls become
   * savepoints (drizzle behavior), which the sync path relies on.
   */
  transaction<T>(fn: (tx: SupportStore) => Promise<T>): Promise<T>;
  /**
   * Serialize concurrent ingests of the same mail. Transaction-scoped
   * (pg_advisory_xact_lock) — only call inside transaction().
   */
  acquireIngestLock(key: string): Promise<void>;
  /**
   * Serialize /sync runs (two admins can't race it). Transaction-scoped
   * try-lock; false = another sync holds it.
   */
  tryAcquireSyncLock(): Promise<boolean>;

  findMessageByInboundId(resendInboundId: string): Promise<MessageRow | null>;
  findMessageByReplyAttemptId(replyAttemptId: string): Promise<MessageRow | null>;
  /** Which of these resend email ids are already stored (sync page dedup). */
  findKnownInboundIds(resendInboundIds: string[]): Promise<Set<string>>;
  /**
   * Messages whose Message-ID header is in `messageIds`. The pure
   * threading.pickThreadMatch decides which thread wins (newest).
   */
  findMessagesByMessageIds(
    messageIds: string[],
  ): Promise<Array<{ threadId: string; sentAt: Date }>>;
  /** Subject fallback: same customer, not spam, active since `activeSince`. */
  findThreadIdBySubject(args: {
    customerEmail: string;
    normalizedSubject: string;
    activeSince: Date;
  }): Promise<string | null>;

  getThread(threadId: string): Promise<ThreadRow | null>;
  createThread(data: NewThreadData): Promise<ThreadRow>;
  listThreads(filter: ThreadListFilter): Promise<ThreadRow[]>;
  countUnreadOpen(): Promise<number>;
  setThreadRead(threadId: string, read: boolean): Promise<ThreadRow | null>;
  /** Closing or spamming also clears unread. */
  setThreadStatus(threadId: string, status: ThreadStatusValue): Promise<ThreadRow | null>;

  /** ASC by sent_at (then id) for the detail view. */
  listMessages(threadId: string): Promise<MessageRow[]>;
  listAttachmentsForMessages(messageIds: string[]): Promise<AttachmentRow[]>;
  /** Non-null Message-ID headers of a thread, ASC by sent_at (References building). */
  listThreadMessageIdHeaders(threadId: string): Promise<string[]>;
  getLastInboundMessage(threadId: string): Promise<MessageRow | null>;

  /** Returns null when the unique resend_inbound_id already exists (conflict). */
  insertInboundMessage(data: NewInboundMessageData): Promise<MessageRow | null>;
  insertOutboundMessage(data: NewOutboundMessageData): Promise<MessageRow>;
  insertAttachments(rows: NewAttachmentData[]): Promise<AttachmentRow[]>;
  /**
   * Inbound rollup: count+1, unread=true, closed reopens (spam stays spam).
   * last_message_at/snippet only move forward so out-of-order sync imports
   * can't regress the list ordering.
   */
  applyInboundRollup(threadId: string, data: RollupData): Promise<void>;
  /** Outbound rollup: count+1, snippet/last_message_at; unread untouched. */
  applyOutboundRollup(threadId: string, data: RollupData): Promise<void>;

  getAttachment(
    attachmentId: string,
  ): Promise<{ attachment: AttachmentRow; messageResendInboundId: string | null } | null>;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function createSupportStore(db: SupportInboxDb): SupportStore {
  return {
    async transaction(fn) {
      return await db.transaction(async (tx) => fn(createSupportStore(tx as SupportInboxDb)));
    },

    async acquireIngestLock(key) {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
    },

    async tryAcquireSyncLock() {
      const result = (await db.execute(
        sql`SELECT pg_try_advisory_xact_lock(hashtext('support-inbox-sync')) AS locked`,
      )) as unknown;
      // Raw-execute result shape differs by driver: postgres-js returns an
      // array-like RowList, node-postgres/neon return { rows: [...] }.
      const rows = Array.isArray(result)
        ? (result as Array<{ locked?: unknown }>)
        : ((result as { rows?: Array<{ locked?: unknown }> }).rows ?? []);
      return rows[0]?.locked === true;
    },

    async findMessageByInboundId(resendInboundId) {
      const [row] = await db
        .select()
        .from(supportMessages)
        .where(eq(supportMessages.resendInboundId, resendInboundId))
        .limit(1);
      return row ?? null;
    },

    async findMessageByReplyAttemptId(replyAttemptId) {
      const [row] = await db
        .select()
        .from(supportMessages)
        .where(eq(supportMessages.replyAttemptId, replyAttemptId))
        .limit(1);
      return row ?? null;
    },

    async findKnownInboundIds(resendInboundIds) {
      if (resendInboundIds.length === 0) return new Set();
      const rows = await db
        .select({ resendInboundId: supportMessages.resendInboundId })
        .from(supportMessages)
        .where(inArray(supportMessages.resendInboundId, resendInboundIds));
      return new Set(rows.map((row) => row.resendInboundId).filter((id): id is string => !!id));
    },

    async findMessagesByMessageIds(messageIds) {
      if (messageIds.length === 0) return [];
      return await db
        .select({ threadId: supportMessages.threadId, sentAt: supportMessages.sentAt })
        .from(supportMessages)
        .where(inArray(supportMessages.messageId, messageIds))
        .orderBy(desc(supportMessages.sentAt), desc(supportMessages.id));
    },

    async findThreadIdBySubject({ customerEmail, normalizedSubject, activeSince }) {
      const [row] = await db
        .select({ id: supportThreads.id })
        .from(supportThreads)
        .where(
          and(
            eq(supportThreads.customerEmail, customerEmail),
            eq(supportThreads.normalizedSubject, normalizedSubject),
            ne(supportThreads.status, "spam"),
            gte(supportThreads.lastMessageAt, activeSince),
          ),
        )
        .orderBy(desc(supportThreads.lastMessageAt))
        .limit(1);
      return row?.id ?? null;
    },

    async getThread(threadId) {
      const [row] = await db
        .select()
        .from(supportThreads)
        .where(eq(supportThreads.id, threadId))
        .limit(1);
      return row ?? null;
    },

    async createThread(data) {
      const [row] = await db
        .insert(supportThreads)
        .values({
          subject: data.subject,
          normalizedSubject: data.normalizedSubject,
          customerEmail: data.customerEmail,
          customerName: data.customerName,
          inboundAddress: data.inboundAddress,
          lastMessageAt: data.lastMessageAt,
          lastMessageSnippet: data.lastMessageSnippet,
        })
        .returning();
      if (!row) throw new Error("support_threads insert returned no row");
      return row;
    },

    async listThreads({ status, q, cursor, limit }) {
      const conditions = [];
      if (status !== "all") conditions.push(eq(supportThreads.status, status));
      if (q) {
        const pattern = `%${escapeLikePattern(q)}%`;
        conditions.push(
          or(
            sql`${supportThreads.subject} ILIKE ${pattern}`,
            sql`${supportThreads.customerEmail} ILIKE ${pattern}`,
          ),
        );
      }
      if (cursor) {
        conditions.push(
          or(
            lt(supportThreads.lastMessageAt, cursor.lastMessageAt),
            and(
              eq(supportThreads.lastMessageAt, cursor.lastMessageAt),
              lt(supportThreads.id, cursor.id),
            ),
          ),
        );
      }
      return await db
        .select()
        .from(supportThreads)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(supportThreads.lastMessageAt), desc(supportThreads.id))
        .limit(limit);
    },

    async countUnreadOpen() {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(supportThreads)
        .where(and(eq(supportThreads.unread, true), eq(supportThreads.status, "open")));
      return row?.count ?? 0;
    },

    async setThreadRead(threadId, read) {
      const [row] = await db
        .update(supportThreads)
        .set({ unread: !read, updatedAt: new Date() })
        .where(eq(supportThreads.id, threadId))
        .returning();
      return row ?? null;
    },

    async setThreadStatus(threadId, status) {
      const [row] = await db
        .update(supportThreads)
        .set({
          status,
          ...(status === "closed" || status === "spam" ? { unread: false } : {}),
          updatedAt: new Date(),
        })
        .where(eq(supportThreads.id, threadId))
        .returning();
      return row ?? null;
    },

    async listMessages(threadId) {
      return await db
        .select()
        .from(supportMessages)
        .where(eq(supportMessages.threadId, threadId))
        .orderBy(asc(supportMessages.sentAt), asc(supportMessages.id));
    },

    async listAttachmentsForMessages(messageIds) {
      if (messageIds.length === 0) return [];
      return await db
        .select()
        .from(supportAttachments)
        .where(inArray(supportAttachments.messageId, messageIds))
        .orderBy(asc(supportAttachments.createdAt), asc(supportAttachments.id));
    },

    async listThreadMessageIdHeaders(threadId) {
      const rows = await db
        .select({ messageId: supportMessages.messageId })
        .from(supportMessages)
        .where(eq(supportMessages.threadId, threadId))
        .orderBy(asc(supportMessages.sentAt), asc(supportMessages.id));
      return rows.map((row) => row.messageId).filter((id): id is string => !!id);
    },

    async getLastInboundMessage(threadId) {
      const [row] = await db
        .select()
        .from(supportMessages)
        .where(
          and(eq(supportMessages.threadId, threadId), eq(supportMessages.direction, "inbound")),
        )
        .orderBy(desc(supportMessages.sentAt), desc(supportMessages.id))
        .limit(1);
      return row ?? null;
    },

    async insertInboundMessage(data) {
      const [row] = await db
        .insert(supportMessages)
        .values({
          threadId: data.threadId,
          direction: "inbound",
          resendInboundId: data.resendInboundId,
          messageId: data.messageId,
          inReplyTo: data.inReplyTo,
          referencesHeader: data.referencesHeader,
          replyTo: data.replyTo,
          fromEmail: data.fromEmail,
          fromName: data.fromName,
          toEmails: data.toEmails,
          ccEmails: data.ccEmails,
          subject: data.subject,
          textBody: data.textBody,
          htmlBody: data.htmlBody,
          bodyTruncated: data.bodyTruncated,
          snippet: data.snippet,
          sentAt: data.sentAt,
        })
        .onConflictDoNothing({ target: supportMessages.resendInboundId })
        .returning();
      return row ?? null;
    },

    async insertOutboundMessage(data) {
      const [row] = await db
        .insert(supportMessages)
        .values({
          threadId: data.threadId,
          direction: "outbound",
          replyAttemptId: data.replyAttemptId,
          resendOutboundId: data.resendOutboundId,
          messageId: data.messageId,
          inReplyTo: data.inReplyTo,
          referencesHeader: data.referencesHeader,
          fromEmail: data.fromEmail,
          fromName: data.fromName,
          toEmails: data.toEmails,
          ccEmails: [],
          subject: data.subject,
          textBody: data.textBody,
          snippet: data.snippet,
          actorId: data.actorId,
          actorLabel: data.actorLabel,
          sentAt: data.sentAt,
        })
        .returning();
      if (!row) throw new Error("support_messages insert returned no row");
      return row;
    },

    async insertAttachments(rows) {
      if (rows.length === 0) return [];
      return await db.insert(supportAttachments).values(rows).returning();
    },

    async applyInboundRollup(threadId, { lastMessageAt, snippet }) {
      const at = lastMessageAt.toISOString();
      await db
        .update(supportThreads)
        .set({
          messageCount: sql`${supportThreads.messageCount} + 1`,
          unread: true,
          // Spam stays spam; closed reopens.
          status: sql`CASE WHEN ${supportThreads.status} = 'closed' THEN 'open' ELSE ${supportThreads.status} END`,
          // Only move forward so out-of-order imports can't regress ordering.
          lastMessageAt: sql`GREATEST(${supportThreads.lastMessageAt}, ${at}::timestamptz)`,
          lastMessageSnippet: sql`CASE WHEN ${at}::timestamptz >= ${supportThreads.lastMessageAt} THEN ${snippet} ELSE ${supportThreads.lastMessageSnippet} END`,
          updatedAt: new Date(),
        })
        .where(eq(supportThreads.id, threadId));
    },

    async applyOutboundRollup(threadId, { lastMessageAt, snippet }) {
      await db
        .update(supportThreads)
        .set({
          messageCount: sql`${supportThreads.messageCount} + 1`,
          lastMessageAt,
          lastMessageSnippet: snippet,
          updatedAt: new Date(),
        })
        .where(eq(supportThreads.id, threadId));
    },

    async getAttachment(attachmentId) {
      const [row] = await db
        .select({
          attachment: supportAttachments,
          messageResendInboundId: supportMessages.resendInboundId,
        })
        .from(supportAttachments)
        .innerJoin(supportMessages, eq(supportAttachments.messageId, supportMessages.id))
        .where(eq(supportAttachments.id, attachmentId))
        .limit(1);
      return row ?? null;
    },
  };
}
