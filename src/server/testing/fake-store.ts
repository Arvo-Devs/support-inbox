import { randomUUID } from "node:crypto";

import type { ResolvedSupportInboxConfig } from "../../config";
import {
  ResendApiError,
  type ReceivedAttachmentLink,
  type ReceivedEmail,
  type ReceivedEmailSummary,
  type ResendApi,
  type SendReplyArgs,
} from "../resend-api";
import { parseAddress } from "../recipients";
import type { AttachmentRow, MessageRow, SupportStore, ThreadRow } from "../store";

// In-memory SupportStore + stub ResendApi for tests. transaction() runs
// against a deep-cloned snapshot and copies it back only on success, so a
// throw discards every write the transaction made — which is exactly what
// proves the duplicate-race rollback commits no orphan thread.

export type FakeState = {
  threads: ThreadRow[];
  messages: MessageRow[];
  attachments: AttachmentRow[];
};

export type FakeStore = SupportStore & {
  state: FakeState;
  syncLocked: boolean;
  failNextInsertOutbound: boolean;
  failNextOutboundRollup: boolean;
};

export function makeThread(partial: Partial<ThreadRow> = {}): ThreadRow {
  const now = new Date();
  return {
    id: randomUUID(),
    subject: "Help",
    normalizedSubject: "help",
    customerEmail: "customer@example.com",
    customerName: null,
    status: "open",
    unread: true,
    inboundAddress: "support@example.com",
    lastMessageAt: now,
    lastMessageSnippet: null,
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

export function makeMessage(partial: Partial<MessageRow> = {}): MessageRow {
  const now = new Date();
  return {
    id: randomUUID(),
    threadId: randomUUID(),
    direction: "inbound",
    resendInboundId: null,
    replyAttemptId: null,
    resendOutboundId: null,
    messageId: null,
    inReplyTo: null,
    referencesHeader: null,
    replyTo: null,
    fromEmail: "customer@example.com",
    fromName: null,
    toEmails: [],
    ccEmails: [],
    subject: "Help",
    textBody: null,
    htmlBody: null,
    bodyTruncated: false,
    snippet: null,
    actorId: null,
    actorLabel: null,
    sentAt: now,
    createdAt: now,
    ...partial,
  };
}

export function makeAttachment(partial: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: randomUUID(),
    messageId: randomUUID(),
    resendAttachmentId: randomUUID(),
    filename: "attachment",
    contentType: null,
    contentDisposition: null,
    contentId: null,
    sizeBytes: null,
    createdAt: new Date(),
    ...partial,
  };
}

type SharedFlags = {
  syncLocked: boolean;
  failNextInsertOutbound: boolean;
  failNextOutboundRollup: boolean;
};

function threadDesc(a: ThreadRow, b: ThreadRow): number {
  const diff = b.lastMessageAt.getTime() - a.lastMessageAt.getTime();
  if (diff !== 0) return diff;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

function messageAsc(a: MessageRow, b: MessageRow): number {
  const diff = a.sentAt.getTime() - b.sentAt.getTime();
  if (diff !== 0) return diff;
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

function attachmentAsc(a: AttachmentRow, b: AttachmentRow): number {
  const diff = a.createdAt.getTime() - b.createdAt.getTime();
  if (diff !== 0) return diff;
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

function storeFor(state: FakeState, flags: SharedFlags, isTransaction: boolean): SupportStore {
  return {
    async transaction(fn) {
      if (isTransaction) {
        // Nested transaction: reuse the current clone (savepoint-ish).
        return await fn(storeFor(state, flags, true));
      }
      const clone = structuredClone(state);
      const result = await fn(storeFor(clone, flags, true));
      // Commit: copy the clone back only on success. A throw above discards it.
      state.threads = clone.threads;
      state.messages = clone.messages;
      state.attachments = clone.attachments;
      return result;
    },

    async acquireIngestLock() {
      // The real lock serializes concurrent transactions; in-process tests
      // run transactions sequentially, so resolving immediately is enough.
    },

    async tryAcquireSyncLock() {
      return !flags.syncLocked;
    },

    async findMessageByInboundId(resendInboundId) {
      return state.messages.find((m) => m.resendInboundId === resendInboundId) ?? null;
    },

    async findMessageByReplyAttemptId(replyAttemptId) {
      return state.messages.find((m) => m.replyAttemptId === replyAttemptId) ?? null;
    },

    async findKnownInboundIds(resendInboundIds) {
      const wanted = new Set(resendInboundIds);
      const known = new Set<string>();
      for (const message of state.messages) {
        if (message.resendInboundId && wanted.has(message.resendInboundId)) {
          known.add(message.resendInboundId);
        }
      }
      return known;
    },

    async findMessagesByMessageIds(messageIds) {
      if (messageIds.length === 0) return [];
      const wanted = new Set(messageIds);
      return state.messages
        .filter((m) => m.messageId !== null && wanted.has(m.messageId))
        .sort((a, b) => messageAsc(b, a))
        .map((m) => ({ threadId: m.threadId, sentAt: m.sentAt }));
    },

    async findThreadIdBySubject({ customerEmail, normalizedSubject, activeSince }) {
      const candidates = state.threads
        .filter(
          (t) =>
            t.customerEmail === customerEmail &&
            t.normalizedSubject === normalizedSubject &&
            t.status !== "spam" &&
            t.lastMessageAt.getTime() >= activeSince.getTime(),
        )
        .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
      return candidates[0]?.id ?? null;
    },

    async getThread(threadId) {
      return state.threads.find((t) => t.id === threadId) ?? null;
    },

    async createThread(data) {
      const now = new Date();
      const row: ThreadRow = {
        id: randomUUID(),
        subject: data.subject,
        normalizedSubject: data.normalizedSubject,
        customerEmail: data.customerEmail,
        customerName: data.customerName,
        status: "open",
        unread: true,
        inboundAddress: data.inboundAddress,
        lastMessageAt: data.lastMessageAt,
        lastMessageSnippet: data.lastMessageSnippet,
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      state.threads.push(row);
      return row;
    },

    async listThreads({ status, q, cursor, limit }) {
      let rows = state.threads.filter((t) => (status === "all" ? true : t.status === status));
      if (q) {
        const needle = q.toLowerCase();
        rows = rows.filter(
          (t) =>
            t.subject.toLowerCase().includes(needle) ||
            t.customerEmail.toLowerCase().includes(needle),
        );
      }
      if (cursor) {
        rows = rows.filter(
          (t) =>
            t.lastMessageAt.getTime() < cursor.lastMessageAt.getTime() ||
            (t.lastMessageAt.getTime() === cursor.lastMessageAt.getTime() && t.id < cursor.id),
        );
      }
      return [...rows].sort(threadDesc).slice(0, limit);
    },

    async countUnreadOpen() {
      return state.threads.filter((t) => t.unread && t.status === "open").length;
    },

    async setThreadRead(threadId, read) {
      const thread = state.threads.find((t) => t.id === threadId);
      if (!thread) return null;
      thread.unread = !read;
      thread.updatedAt = new Date();
      return thread;
    },

    async setThreadStatus(threadId, status) {
      const thread = state.threads.find((t) => t.id === threadId);
      if (!thread) return null;
      thread.status = status;
      if (status === "closed" || status === "spam") thread.unread = false;
      thread.updatedAt = new Date();
      return thread;
    },

    async listMessages(threadId) {
      return state.messages.filter((m) => m.threadId === threadId).sort(messageAsc);
    },

    async listAttachmentsForMessages(messageIds) {
      if (messageIds.length === 0) return [];
      const wanted = new Set(messageIds);
      return state.attachments.filter((a) => wanted.has(a.messageId)).sort(attachmentAsc);
    },

    async listThreadMessageIdHeaders(threadId) {
      return state.messages
        .filter((m) => m.threadId === threadId)
        .sort(messageAsc)
        .map((m) => m.messageId)
        .filter((id): id is string => !!id);
    },

    async getLastInboundMessage(threadId) {
      const inbound = state.messages
        .filter((m) => m.threadId === threadId && m.direction === "inbound")
        .sort((a, b) => messageAsc(b, a));
      return inbound[0] ?? null;
    },

    async insertInboundMessage(data) {
      // Unique-index semantics on resend_inbound_id: conflict returns null.
      if (state.messages.some((m) => m.resendInboundId === data.resendInboundId)) {
        return null;
      }
      const row: MessageRow = {
        id: randomUUID(),
        threadId: data.threadId,
        direction: "inbound",
        resendInboundId: data.resendInboundId,
        replyAttemptId: null,
        resendOutboundId: null,
        messageId: data.messageId,
        inReplyTo: data.inReplyTo,
        referencesHeader: data.referencesHeader,
        replyTo: data.replyTo,
        fromEmail: data.fromEmail,
        fromName: data.fromName,
        toEmails: [...data.toEmails],
        ccEmails: [...data.ccEmails],
        subject: data.subject,
        textBody: data.textBody,
        htmlBody: data.htmlBody,
        bodyTruncated: data.bodyTruncated,
        snippet: data.snippet,
        actorId: null,
        actorLabel: null,
        sentAt: data.sentAt,
        createdAt: new Date(),
      };
      state.messages.push(row);
      return row;
    },

    async insertOutboundMessage(data) {
      if (flags.failNextInsertOutbound) {
        flags.failNextInsertOutbound = false;
        throw new Error("fake insertOutboundMessage failure");
      }
      const row: MessageRow = {
        id: randomUUID(),
        threadId: data.threadId,
        direction: "outbound",
        resendInboundId: null,
        replyAttemptId: data.replyAttemptId,
        resendOutboundId: data.resendOutboundId,
        messageId: data.messageId,
        inReplyTo: data.inReplyTo,
        referencesHeader: data.referencesHeader,
        replyTo: null,
        fromEmail: data.fromEmail,
        fromName: data.fromName,
        toEmails: [...data.toEmails],
        ccEmails: [],
        subject: data.subject,
        textBody: data.textBody,
        htmlBody: null,
        bodyTruncated: false,
        snippet: data.snippet,
        actorId: data.actorId,
        actorLabel: data.actorLabel,
        sentAt: data.sentAt,
        createdAt: new Date(),
      };
      state.messages.push(row);
      return row;
    },

    async insertAttachments(rows) {
      const inserted = rows.map((data) => ({
        id: randomUUID(),
        messageId: data.messageId,
        resendAttachmentId: data.resendAttachmentId,
        filename: data.filename,
        contentType: data.contentType,
        contentDisposition: data.contentDisposition,
        contentId: data.contentId,
        sizeBytes: data.sizeBytes,
        createdAt: new Date(),
      }));
      state.attachments.push(...inserted);
      return inserted;
    },

    async applyInboundRollup(threadId, { lastMessageAt, snippet }) {
      const thread = state.threads.find((t) => t.id === threadId);
      if (!thread) return;
      thread.messageCount += 1;
      thread.unread = true;
      // Spam stays spam; closed reopens.
      if (thread.status === "closed") thread.status = "open";
      // last_message_at/snippet only move forward so out-of-order sync
      // imports can't regress the list ordering.
      if (lastMessageAt.getTime() >= thread.lastMessageAt.getTime()) {
        thread.lastMessageAt = lastMessageAt;
        thread.lastMessageSnippet = snippet;
      }
      thread.updatedAt = new Date();
    },

    async applyOutboundRollup(threadId, { lastMessageAt, snippet }) {
      if (flags.failNextOutboundRollup) {
        flags.failNextOutboundRollup = false;
        throw new Error("fake applyOutboundRollup failure");
      }
      const thread = state.threads.find((t) => t.id === threadId);
      if (!thread) return;
      thread.messageCount += 1;
      thread.lastMessageAt = lastMessageAt;
      thread.lastMessageSnippet = snippet;
      thread.updatedAt = new Date();
    },

    async getAttachment(attachmentId) {
      const attachment = state.attachments.find((a) => a.id === attachmentId);
      if (!attachment) return null;
      // Inner-join semantics: no parent message, no row.
      const message = state.messages.find((m) => m.id === attachment.messageId);
      if (!message) return null;
      return { attachment, messageResendInboundId: message.resendInboundId };
    },
  };
}

export function createFakeStore(seed?: Partial<FakeState>): FakeStore {
  const state: FakeState = {
    threads: [...(seed?.threads ?? [])],
    messages: [...(seed?.messages ?? [])],
    attachments: [...(seed?.attachments ?? [])],
  };
  const flags: SharedFlags = {
    syncLocked: false,
    failNextInsertOutbound: false,
    failNextOutboundRollup: false,
  };
  return {
    ...storeFor(state, flags, false),
    state,
    get syncLocked() {
      return flags.syncLocked;
    },
    set syncLocked(value: boolean) {
      flags.syncLocked = value;
    },
    get failNextInsertOutbound() {
      return flags.failNextInsertOutbound;
    },
    set failNextInsertOutbound(value: boolean) {
      flags.failNextInsertOutbound = value;
    },
    get failNextOutboundRollup() {
      return flags.failNextOutboundRollup;
    },
    set failNextOutboundRollup(value: boolean) {
      flags.failNextOutboundRollup = value;
    },
  };
}

export type StubCalls = {
  getReceived: string[];
  list: Array<{ limit?: number; after?: string }>;
  send: Array<{ args: SendReplyArgs; idempotencyKey: string }>;
  attachments: string[];
};

export type StubResendApi = ResendApi & {
  calls: StubCalls;
  received: Map<string, ReceivedEmail>;
  pages: ReceivedEmailSummary[][];
  attachmentLinks: Map<string, ReceivedAttachmentLink[]>;
  failures: { getReceived?: Error; send?: Error; listOnPage?: number };
};

export function createStubResendApi(seed?: {
  received?: ReceivedEmail[];
  pages?: ReceivedEmailSummary[][];
  attachmentLinks?: Record<string, ReceivedAttachmentLink[]>;
}): StubResendApi {
  const calls: StubCalls = { getReceived: [], list: [], send: [], attachments: [] };
  let listCallIndex = 0;

  const stub: StubResendApi = {
    calls,
    received: new Map((seed?.received ?? []).map((email) => [email.id, email])),
    pages: (seed?.pages ?? []).map((page) => [...page]),
    attachmentLinks: new Map(Object.entries(seed?.attachmentLinks ?? {})),
    failures: {},

    async getReceivedEmail(id) {
      calls.getReceived.push(id);
      if (stub.failures.getReceived) throw stub.failures.getReceived;
      const email = stub.received.get(id);
      if (!email) throw new ResendApiError("not found", 404);
      return email;
    },

    async listReceivedEmails(args = {}) {
      const index = listCallIndex;
      listCallIndex += 1;
      calls.list.push({ ...args });
      if (stub.failures.listOnPage === index) {
        throw new ResendApiError("rate limited", 429);
      }
      const page = stub.pages[index] ?? [];
      const hasMore = index < stub.pages.length - 1;
      const last = page.length > 0 ? page[page.length - 1] : undefined;
      return { emails: page, hasMore, nextCursor: hasMore && last ? last.id : null };
    },

    async listAttachments(emailId) {
      calls.attachments.push(emailId);
      return stub.attachmentLinks.get(emailId) ?? [];
    },

    async sendReply(args, idempotencyKey) {
      if (stub.failures.send) throw stub.failures.send;
      calls.send.push({ args, idempotencyKey });
      return { id: `sent-${calls.send.length}` };
    },
  };
  return stub;
}

export function makeReceivedEmail(
  partial: Partial<ReceivedEmail> & { id: string },
): ReceivedEmail {
  return {
    from: "Customer <customer@example.com>",
    to: ["support@example.com"],
    cc: [],
    replyTo: null,
    receivedFor: [],
    subject: "Help",
    text: "hello",
    html: null,
    messageId: null,
    inReplyTo: null,
    references: null,
    createdAt: new Date().toISOString(),
    attachments: [],
    ...partial,
  };
}

export function makeConfig(
  partial: Partial<ResolvedSupportInboxConfig> = {},
): ResolvedSupportInboxConfig {
  // Derive the parsed-sender fields from a fromEmail override the same way
  // normalizeConfig does, so tests only need to pass fromEmail.
  const fromEmail = partial.fromEmail ?? "Acme Support <support@example.com>";
  const fromParsed = parseAddress(fromEmail);
  const fromAddress = fromParsed?.address ?? "support@example.com";
  return {
    db: {} as never, // tests never touch the drizzle handle
    resendApiKey: "re_test",
    fromEmail,
    fromAddress,
    fromName: fromParsed?.name ?? null,
    fromDomain: fromAddress.split("@")[1] ?? "example.com",
    inboundAddresses: ["support@example.com", "contact@example.com"],
    aliasMap: {},
    webhookSecret: `whsec_${Buffer.from("support-inbox-test-secret").toString("base64")}`,
    authorize: async () => ({ id: "admin-1", email: "admin@example.com", name: "Admin" }),
    lookupCustomer: null,
    basePath: "/api/admin/support",
    ...partial,
  };
}
