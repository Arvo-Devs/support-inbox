import type { ResolvedSupportInboxConfig, SupportInboxActor } from "../../config";
import type { ReplyResponse, ThreadResponse } from "../../shared/types";
import { parseAddress } from "../recipients";
import type { RouterDeps } from "../router";
import { toMessageDto, toThreadSummary } from "../serialize";
import { makeSnippet } from "../snippet";
import { isUniqueViolation, REPLY_ATTEMPT_UNIQUE_INDEX } from "../store";
import type { MessageRow } from "../store";
import { buildReplyHeaders, replySubject } from "../threading";

// Mutating thread routes: reply (send-then-store with client-supplied
// idempotency), read/unread toggling, and status transitions.

const MAX_REPLY_LENGTH = 50_000;
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
