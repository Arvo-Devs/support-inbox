import type { ResolvedSupportInboxConfig, SupportInboxActor } from "../../config";
import type { ComposeResponse, ReplyResponse, ThreadResponse } from "../../shared/types";
import { parseAddress } from "../recipients";
import type { RouterDeps } from "../router";
import { toMessageDto, toThreadSummary } from "../serialize";
import { makeSnippet } from "../snippet";
import { isUniqueViolation, REPLY_ATTEMPT_UNIQUE_INDEX } from "../store";
import type { MessageRow } from "../store";
import { buildReplyHeaders, normalizeSubject, replySubject } from "../threading";

// Mutating thread routes: compose (start a new thread), reply (send-then-store
// with client-supplied idempotency), read/unread toggling, status transitions.

const MAX_REPLY_LENGTH = 50_000;
const MAX_SUBJECT_LENGTH = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function reply(
  deps: RouterDeps,
  config: ResolvedSupportInboxConfig,
  actor: SupportInboxActor,
  threadId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const text = body.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    return Response.json({ error: "Reply text is required" }, { status: 400 });
  }
  if (text.length > MAX_REPLY_LENGTH) {
    return Response.json({ error: "Reply text is too long" }, { status: 400 });
  }
  const replyAttemptId = body.replyAttemptId;
  if (typeof replyAttemptId !== "string" || !UUID_PATTERN.test(replyAttemptId)) {
    return Response.json({ error: "replyAttemptId must be a UUID" }, { status: 400 });
  }

  // Idempotent replay: if this attempt already produced a message, return it
  // without contacting Resend again. Scoped to the thread — an attempt id
  // reused against a different thread must not read as a silent success.
  const existing = await deps.store.findMessageByReplyAttemptId(replyAttemptId);
  if (existing) {
    if (existing.threadId !== threadId) {
      return Response.json(
        { error: "replyAttemptId was already used for a different thread" },
        { status: 409 },
      );
    }
    return Response.json({ message: toMessageDto(existing, []) } satisfies ReplyResponse);
  }

  const thread = await deps.store.getThread(threadId);
  if (!thread) return Response.json({ error: "Thread not found" }, { status: 404 });

  const lastInbound = await deps.store.getLastInboundMessage(threadId);
  // v1 replies go to the sender only (their Reply-To when present); CC
  // participants are displayed but never auto-included.
  const to = parseAddress(lastInbound?.replyTo ?? null)?.address ?? thread.customerEmail;

  const headers = buildReplyHeaders({
    threadMessageIds: await deps.store.listThreadMessageIdHeaders(threadId),
    lastInboundMessageId: lastInbound?.messageId ?? null,
    fromDomain: config.fromDomain,
  });
  const subject = replySubject(thread.subject);
  const headerRecord: Record<string, string> = {
    "Message-ID": headers.messageId,
    ...(headers.inReplyTo ? { "In-Reply-To": headers.inReplyTo } : {}),
    ...(headers.references ? { References: headers.references } : {}),
  };

  // Send-then-store: nothing is persisted on a send failure, so a client
  // retry with the same attempt id is replay-safe — Resend's idempotency key
  // (24h window) guarantees the retry can't double-send.
  let sent: { id: string };
  try {
    sent = await deps.resendApi.sendReply(
      { from: config.fromEmail, to: [to], subject, text, headers: headerRecord },
      replyAttemptId,
    );
  } catch (error) {
    console.error("[support-inbox] reply send failed", { threadId, replyAttemptId, error });
    return Response.json({ error: "Reply could not be sent" }, { status: 502 });
  }

  let row: MessageRow;
  try {
    // Message insert and thread rollup commit atomically: a rollup failure
    // must not strand a recorded message whose rollup the replay path (which
    // returns early) would never repair.
    row = await deps.store.transaction(async (tx) => {
      const inserted = await tx.insertOutboundMessage({
        threadId,
        replyAttemptId,
        resendOutboundId: sent.id,
        messageId: headers.messageId,
        inReplyTo: headers.inReplyTo,
        referencesHeader: headers.references,
        fromEmail: config.fromAddress,
        fromName: config.fromName,
        toEmails: [to],
        subject,
        textBody: text,
        snippet: makeSnippet(text, null),
        actorId: actor.id,
        actorLabel: actor.name ?? actor.email ?? actor.id,
        sentAt: new Date(),
      });
      await tx.applyOutboundRollup(threadId, {
        lastMessageAt: inserted.sentAt,
        snippet: inserted.snippet,
      });
      return inserted;
    });
  } catch (error) {
    // Concurrent duplicate: two requests with the same attempt id can both
    // pass the replay pre-check above; the loser then trips the unique index
    // here. That is not a failure — Resend's idempotency key collapsed the
    // sends and the winner recorded the message and rollup — so re-read the
    // winner's row and answer exactly like the pre-check replay path.
    if (isUniqueViolation(error, REPLY_ATTEMPT_UNIQUE_INDEX)) {
      const winner = await deps.store.findMessageByReplyAttemptId(replyAttemptId);
      if (winner) {
        if (winner.threadId !== threadId) {
          return Response.json(
            { error: "replyAttemptId was already used for a different thread" },
            { status: 409 },
          );
        }
        return Response.json({ message: toMessageDto(winner, []) } satisfies ReplyResponse);
      }
    }
    console.error("[support-inbox] reply sent but not recorded", {
      threadId,
      replyAttemptId,
      error,
    });
    return Response.json(
      { error: "Reply was sent but could not be recorded; retrying will not re-send" },
      { status: 500 },
    );
  }

  return Response.json({ message: toMessageDto(row, []) } satisfies ReplyResponse);
}

export async function compose(
  deps: RouterDeps,
  config: ResolvedSupportInboxConfig,
  actor: SupportInboxActor,
  body: Record<string, unknown>,
): Promise<Response> {
  const recipient = typeof body.to === "string" ? parseAddress(body.to) : null;
  if (!recipient) {
    return Response.json({ error: "A valid recipient address is required" }, { status: 400 });
  }
  // Composing to our own address would loop back through inbound ingest.
  if (recipient.address === config.fromAddress) {
    return Response.json(
      { error: "Cannot compose to the support address itself" },
      { status: 400 },
    );
  }

  const subjectRaw = body.subject;
  if (typeof subjectRaw !== "string" || subjectRaw.trim().length === 0) {
    return Response.json({ error: "Subject is required" }, { status: 400 });
  }
  if (subjectRaw.length > MAX_SUBJECT_LENGTH) {
    return Response.json({ error: "Subject is too long" }, { status: 400 });
  }
  const subject = subjectRaw.trim();

  const text = body.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    return Response.json({ error: "Message text is required" }, { status: 400 });
  }
  if (text.length > MAX_REPLY_LENGTH) {
    return Response.json({ error: "Message text is too long" }, { status: 400 });
  }

  const replyAttemptId = body.replyAttemptId;
  if (typeof replyAttemptId !== "string" || !UUID_PATTERN.test(replyAttemptId)) {
    return Response.json({ error: "replyAttemptId must be a UUID" }, { status: 400 });
  }

  // Idempotent replay: a resent attempt returns the already-created thread +
  // message without contacting Resend or creating a second thread.
  const existing = await deps.store.findMessageByReplyAttemptId(replyAttemptId);
  if (existing) {
    const thread = await deps.store.getThread(existing.threadId);
    if (!thread) return Response.json({ error: "Composed thread is missing" }, { status: 500 });
    return Response.json({
      thread: toThreadSummary(thread),
      message: toMessageDto(existing, []),
    } satisfies ComposeResponse);
  }

  // New thread => no prior message ids; buildReplyHeaders just mints a fresh
  // Message-ID (inReplyTo/references stay null).
  const headers = buildReplyHeaders({
    threadMessageIds: [],
    lastInboundMessageId: null,
    fromDomain: config.fromDomain,
  });
  const snippet = makeSnippet(text, null);
  const sentAt = new Date();

  let sent: { id: string };
  try {
    sent = await deps.resendApi.sendReply(
      {
        from: config.fromEmail,
        to: [recipient.address],
        subject,
        text,
        headers: { "Message-ID": headers.messageId },
      },
      replyAttemptId,
    );
  } catch (error) {
    console.error("[support-inbox] compose send failed", { replyAttemptId, error });
    return Response.json({ error: "Message could not be sent" }, { status: 502 });
  }

  try {
    // Thread + message + rollup commit atomically. On the concurrent-duplicate
    // path the unique index trips inside the tx, rolling back the just-created
    // thread too — so a losing racer never leaves an orphan thread.
    const result = await deps.store.transaction(async (tx) => {
      const thread = await tx.createThread({
        subject,
        normalizedSubject: normalizeSubject(subject),
        customerEmail: recipient.address,
        customerName: recipient.name,
        inboundAddress: null,
        lastMessageAt: sentAt,
        lastMessageSnippet: snippet,
      });
      const message = await tx.insertOutboundMessage({
        threadId: thread.id,
        replyAttemptId,
        resendOutboundId: sent.id,
        messageId: headers.messageId,
        inReplyTo: null,
        referencesHeader: null,
        fromEmail: config.fromAddress,
        fromName: config.fromName,
        toEmails: [recipient.address],
        subject,
        textBody: text,
        snippet,
        actorId: actor.id,
        actorLabel: actor.name ?? actor.email ?? actor.id,
        sentAt,
      });
      await tx.applyOutboundRollup(thread.id, { lastMessageAt: sentAt, snippet });
      const fresh = await tx.getThread(thread.id);
      return { thread: fresh ?? thread, message };
    });
    return Response.json({
      thread: toThreadSummary(result.thread),
      message: toMessageDto(result.message, []),
    } satisfies ComposeResponse);
  } catch (error) {
    if (isUniqueViolation(error, REPLY_ATTEMPT_UNIQUE_INDEX)) {
      const winner = await deps.store.findMessageByReplyAttemptId(replyAttemptId);
      const thread = winner ? await deps.store.getThread(winner.threadId) : null;
      if (winner && thread) {
        return Response.json({
          thread: toThreadSummary(thread),
          message: toMessageDto(winner, []),
        } satisfies ComposeResponse);
      }
    }
    console.error("[support-inbox] compose sent but not recorded", { replyAttemptId, error });
    return Response.json(
      { error: "Message was sent but could not be recorded; retrying will not re-send" },
      { status: 500 },
    );
  }
}

export async function setRead(
  deps: RouterDeps,
  threadId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const read = body.read;
  if (typeof read !== "boolean") {
    return Response.json({ error: "read must be a boolean" }, { status: 400 });
  }
  const row = await deps.store.setThreadRead(threadId, read);
  if (!row) return Response.json({ error: "Thread not found" }, { status: 404 });
  return Response.json({ thread: toThreadSummary(row) } satisfies ThreadResponse);
}

export async function setStatus(
  deps: RouterDeps,
  threadId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const status = body.status;
  if (status !== "open" && status !== "closed" && status !== "spam") {
    return Response.json({ error: "Invalid status" }, { status: 400 });
  }
  // The store clears unread when transitioning to closed/spam.
  const row = await deps.store.setThreadStatus(threadId, status);
  if (!row) return Response.json({ error: "Thread not found" }, { status: 404 });
  return Response.json({ thread: toThreadSummary(row) } satisfies ThreadResponse);
}
