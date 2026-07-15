import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Global tables (RLS disabled): the support inbox is an instance-admin
// surface, so no tenant scoping applies. The canonical DDL lives at
// migrations/0001_support_inbox.sql — hosts copy it verbatim into their own
// migration dir; this file exists for the query builder only and is never fed
// to drizzle-kit.

export const supportThreads = pgTable(
  "support_threads",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    subject: text("subject").notNull(),
    /** Lowercased, Re:/Fwd:-stripped subject used by the fallback matcher. */
    normalizedSubject: text("normalized_subject").notNull(),
    customerEmail: text("customer_email").notNull(),
    customerName: text("customer_name"),
    status: text("status").$type<"open" | "closed" | "spam">().notNull().default("open"),
    unread: boolean("unread").notNull().default(true),
    /** Public address the customer wrote to (post-aliasMap translation). */
    inboundAddress: text("inbound_address"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageSnippet: text("last_message_snippet"),
    messageCount: integer("message_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("support_threads_status_last_message_idx").on(table.status, table.lastMessageAt.desc()),
    index("support_threads_customer_subject_idx").on(table.customerEmail, table.normalizedSubject),
    index("support_threads_unread_idx")
      .on(table.lastMessageAt)
      .where(sql`${table.unread}`),
  ],
);

export const supportMessages = pgTable(
  "support_messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    threadId: text("thread_id")
      .notNull()
      .references(() => supportThreads.id, { onDelete: "cascade" }),
    direction: text("direction").$type<"inbound" | "outbound">().notNull(),
    /** Inbound idempotency arbiter (unique, nullable — PG allows many NULLs). */
    resendInboundId: text("resend_inbound_id"),
    /**
     * Outbound idempotency arbiter: client-generated UUID per reply attempt,
     * also passed to Resend as the send idempotency key.
     */
    replyAttemptId: text("reply_attempt_id"),
    resendOutboundId: text("resend_outbound_id"),
    /** RFC 5322 Message-ID, with angle brackets. */
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    /** `references` is a Postgres reserved word, hence the suffix. */
    referencesHeader: text("references_header"),
    replyTo: text("reply_to"),
    fromEmail: text("from_email").notNull(),
    fromName: text("from_name"),
    toEmails: jsonb("to_emails").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    ccEmails: jsonb("cc_emails").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    subject: text("subject").notNull().default(""),
    textBody: text("text_body"),
    htmlBody: text("html_body"),
    bodyTruncated: boolean("body_truncated").notNull().default(false),
    snippet: text("snippet"),
    actorId: text("actor_id"),
    actorLabel: text("actor_label"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("support_messages_resend_inbound_id_idx").on(table.resendInboundId),
    uniqueIndex("support_messages_reply_attempt_id_idx").on(table.replyAttemptId),
    index("support_messages_thread_sent_idx").on(table.threadId, table.sentAt),
    index("support_messages_message_id_idx").on(table.messageId),
  ],
);

export const supportAttachments = pgTable(
  "support_attachments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    messageId: text("message_id")
      .notNull()
      .references(() => supportMessages.id, { onDelete: "cascade" }),
    resendAttachmentId: text("resend_attachment_id").notNull(),
    filename: text("filename").notNull().default("attachment"),
    contentType: text("content_type"),
    contentDisposition: text("content_disposition"),
    contentId: text("content_id"),
    sizeBytes: integer("size_bytes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("support_attachments_message_id_idx").on(table.messageId)],
);
