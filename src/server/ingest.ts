import type { ResolvedSupportInboxConfig } from "../config";
import { addressList, isLoopMail, matchInboundAddress, parseAddress } from "./recipients";
import type { ResendApi } from "./resend-api";
import { makeSnippet, truncateBody } from "./snippet";
import type { SupportStore } from "./store";
import {
  candidateMessageIds,
  normalizeMessageId,
  normalizeSubject,
  pickThreadMatch,
} from "./threading";

/**
 * Control-flow error thrown INSIDE the ingest transaction when another
 * delivery of the same mail won the race: aborting the transaction rolls back
 * everything it did (including a just-created thread), so no orphan thread
 * ever commits.
 */
export class DuplicateInboundError extends Error {
  constructor() {
    super("received email was already ingested");
    this.name = "DuplicateInboundError";
  }
}

export type IngestDeps = {
  store: SupportStore;
  resendApi: ResendApi;
  config: ResolvedSupportInboxConfig;
};

export type IngestResult =
  | { outcome: "skipped"; reason: "duplicate" }
  | { outcome: "ignored"; reason: "recipient_mismatch" | "loop" }
  | { outcome: "ingested"; threadId: string; messageId: string };

/** Subject-fallback threading only considers threads active in the last 30 days. */
export const SUBJECT_FALLBACK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export async function ingestReceivedEmail(
  deps: IngestDeps,
  emailId: string,
): Promise<IngestResult> {
  const { store, resendApi, config } = deps;

  // 1. Cheap duplicate pre-check before spending a content fetch. The
  //    unique-index race is re-checked inside the transaction.
  if (await store.findMessageByInboundId(emailId)) {
    return { outcome: "skipped", reason: "duplicate" };
  }

  // 2. Full content. Errors propagate: the webhook maps them to a 500 so
  //    Resend retries the delivery.
  const email = await resendApi.getReceivedEmail(emailId);

  // 3. Recipient filter (with aliasMap translation).
  const toEmails = addressList(email.to);
  const ccEmails = addressList(email.cc);
  const receivedFor = addressList(email.receivedFor);
  const match = matchInboundAddress({
    to: toEmails,
    cc: ccEmails,
    receivedFor,
    inboundAddresses: config.inboundAddresses,
    aliasMap: config.aliasMap,
  });
  if (!match.matched) {
    return { outcome: "ignored", reason: "recipient_mismatch" };
  }

  // 4. Loop guard: our own outbound sender writing back to us. Bounce daemons
  //    are NOT dropped — they thread via References and surface delivery
  //    failures inline.
  const fromParsed = parseAddress(email.from);
  if (
    isLoopMail({
      fromAddress: fromParsed?.address ?? null,
      fromEmail: config.fromEmail,
      inboundAddresses: config.inboundAddresses,
    })
  ) {
    return { outcome: "ignored", reason: "loop" };
  }

  // 5. Derived fields.
  const customerEmail = fromParsed?.address ?? "unknown";
  const customerName = fromParsed?.name ?? null;
  const normalized = normalizeSubject(email.subject);
  const refIds = candidateMessageIds({
    references: email.references,
    inReplyTo: email.inReplyTo,
  });
  const text = truncateBody(email.text);
  const html = truncateBody(email.html);
  const bodyTruncated = text.truncated || html.truncated;
  const snippet = makeSnippet(text.value, html.value);
  const parsedSentAt = email.createdAt ? new Date(email.createdAt) : new Date();
  const sentAt = Number.isNaN(parsedSentAt.getTime()) ? new Date() : parsedSentAt;

  // 6. Thread match (read-only queries, outside the transaction).
  const referenceMatches = await store.findMessagesByMessageIds(refIds);
  const subjectFallbackThreadId =
    normalized !== ""
      ? await store.findThreadIdBySubject({
          customerEmail,
          normalizedSubject: normalized,
          activeSince: new Date(Date.now() - SUBJECT_FALLBACK_WINDOW_MS),
        })
      : null;
  const matchedThreadId = pickThreadMatch({ referenceMatches, subjectFallbackThreadId });

  // 7. Race-safe write: Resend webhooks are at-least-once and can arrive
  //    concurrently. DuplicateInboundError aborts the whole transaction so a
  //    just-created thread never commits as an orphan.
  try {
    const result = await store.transaction(async (tx) => {
      await tx.acquireIngestLock(emailId);
      if (await tx.findMessageByInboundId(emailId)) {
        throw new DuplicateInboundError();
      }

      const threadId =
        matchedThreadId ??
        (
          await tx.createThread({
            subject: email.subject?.trim() || "(no subject)",
            normalizedSubject: normalized,
            customerEmail,
            customerName,
            inboundAddress: match.inboundAddress,
            lastMessageAt: sentAt,
            lastMessageSnippet: snippet,
          })
        ).id;

      const message = await tx.insertInboundMessage({
        threadId,
        resendInboundId: emailId,
        // Bracket-normalized so future References/In-Reply-To lookups (which
        // always search bracketed forms) can match it.
        messageId: normalizeMessageId(email.messageId),
        inReplyTo: email.inReplyTo,
        referencesHeader: email.references,
        replyTo: email.replyTo,
        fromEmail: customerEmail === "unknown" ? (email.from ?? "unknown") : customerEmail,
        fromName: customerName,
        toEmails,
        ccEmails,
        subject: email.subject ?? "",
        textBody: text.value,
        htmlBody: html.value,
        bodyTruncated,
        snippet,
        sentAt,
      });
      // Unique-index race lost: another delivery inserted first. Roll
      // everything back, including the thread we may have just created.
      if (!message) {
        throw new DuplicateInboundError();
      }

      await tx.insertAttachments(
        email.attachments.map((attachment) => ({
          messageId: message.id,
          resendAttachmentId: attachment.id,
          filename: attachment.filename ?? "attachment",
          contentType: attachment.contentType,
          contentDisposition: attachment.contentDisposition,
          contentId: attachment.contentId,
          sizeBytes: attachment.sizeBytes,
        })),
      );

      await tx.applyInboundRollup(threadId, { lastMessageAt: sentAt, snippet });

      return { threadId, messageId: message.id };
    });
    return { outcome: "ingested", threadId: result.threadId, messageId: result.messageId };
  } catch (error) {
    if (error instanceof DuplicateInboundError) {
      return { outcome: "skipped", reason: "duplicate" };
    }
    throw error;
  }
}
