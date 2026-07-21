import assert from "node:assert/strict";
import test from "node:test";

import type { ResolvedSupportInboxConfig } from "../config";
import { ingestReceivedEmail, SUBJECT_FALLBACK_WINDOW_MS, type IngestResult } from "./ingest";
import type { ReceivedEmail } from "./resend-api";
import type { SupportStore } from "./store";
import {
  createFakeStore,
  createStubResendApi,
  makeConfig,
  makeMessage,
  makeReceivedEmail,
  makeThread,
  type FakeStore,
} from "./testing/fake-store";
import { normalizeSubject } from "./threading";

const DAY_MS = 24 * 60 * 60 * 1000;

function setup(options: {
  email: ReceivedEmail;
  store?: FakeStore;
  config?: ResolvedSupportInboxConfig;
}) {
  const store = options.store ?? createFakeStore();
  const resendApi = createStubResendApi({ received: [options.email] });
  const config = options.config ?? makeConfig();
  return { store, resendApi, config, deps: { store, resendApi, config } };
}

function expectIngested(result: IngestResult): { threadId: string; messageId: string } {
  assert.equal(result.outcome, "ingested");
  if (result.outcome !== "ingested") throw new Error("unreachable");
  return { threadId: result.threadId, messageId: result.messageId };
}

test("new inbound mail creates a thread with parsed fields, attachments, and rollup", async () => {
  const email = makeReceivedEmail({
    id: "email-1",
    from: "Jane Doe <jane@example.com>",
    to: ["Support@Example.Com"],
    cc: ["Ops Team <OPS@Example.com>"],
    subject: "  Widget broken  ",
    text: "The widget fell apart",
    messageId: "<incoming-1@example.com>",
    createdAt: "2026-07-10T12:00:00.000Z",
    attachments: [
      {
        id: "att-1",
        filename: "log.txt",
        contentType: "text/plain",
        contentDisposition: "attachment",
        contentId: null,
        sizeBytes: 123,
      },
    ],
  });
  const { deps, store } = setup({ email });

  const result = await ingestReceivedEmail(deps, "email-1");
  const { threadId, messageId } = expectIngested(result);

  assert.equal(store.state.threads.length, 1);
  const thread = store.state.threads[0];
  assert.equal(thread.id, threadId);
  assert.equal(thread.subject, "Widget broken");
  assert.equal(thread.normalizedSubject, normalizeSubject("  Widget broken  "));
  assert.equal(thread.customerEmail, "jane@example.com");
  assert.equal(thread.customerName, "Jane Doe");
  assert.equal(thread.inboundAddress, "support@example.com");
  assert.equal(thread.status, "open");
  assert.equal(thread.unread, true);
  assert.equal(thread.messageCount, 1);
  assert.equal(thread.lastMessageAt.toISOString(), "2026-07-10T12:00:00.000Z");
  assert.ok(thread.lastMessageSnippet);

  assert.equal(store.state.messages.length, 1);
  const message = store.state.messages[0];
  assert.equal(message.id, messageId);
  assert.equal(message.threadId, threadId);
  assert.equal(message.direction, "inbound");
  assert.equal(message.resendInboundId, "email-1");
  assert.equal(message.messageId, "<incoming-1@example.com>");
  assert.equal(message.fromEmail, "jane@example.com");
  assert.equal(message.fromName, "Jane Doe");
  assert.deepEqual(message.toEmails, ["support@example.com"]);
  assert.deepEqual(message.ccEmails, ["ops@example.com"]);
  assert.equal(message.subject, "  Widget broken  ");
  assert.equal(message.textBody, "The widget fell apart");
  assert.equal(message.htmlBody, null);
  assert.equal(message.bodyTruncated, false);
  assert.equal(message.sentAt.toISOString(), "2026-07-10T12:00:00.000Z");
  assert.equal(message.snippet, thread.lastMessageSnippet);

  assert.equal(store.state.attachments.length, 1);
  const attachment = store.state.attachments[0];
  assert.equal(attachment.messageId, messageId);
  assert.equal(attachment.resendAttachmentId, "att-1");
  assert.equal(attachment.filename, "log.txt");
  assert.equal(attachment.contentType, "text/plain");
  assert.equal(attachment.contentDisposition, "attachment");
  assert.equal(attachment.sizeBytes, 123);
});

test("aliasMap translates a managed alias to the public inbound address", async () => {
  const email = makeReceivedEmail({ id: "email-2", to: ["support@abc123.resend.app"] });
  const config = makeConfig({
    inboundAddresses: ["support@example.com"],
    aliasMap: { "support@abc123.resend.app": "support@example.com" },
  });
  const { deps, store } = setup({ email, config });

  const result = await ingestReceivedEmail(deps, "email-2");
  expectIngested(result);

  assert.equal(store.state.threads.length, 1);
  assert.equal(store.state.threads[0].inboundAddress, "support@example.com");
});

test("References match routes the mail into the existing thread", async () => {
  const thread = makeThread({ normalizedSubject: "unrelated subject" });
  const seeded = makeMessage({
    threadId: thread.id,
    resendInboundId: "email-prev",
    messageId: "<orig@example.com>",
    sentAt: new Date("2026-07-01T00:00:00.000Z"),
  });
  const store = createFakeStore({ threads: [thread], messages: [seeded] });
  const email = makeReceivedEmail({
    id: "email-3",
    subject: "Re: something else entirely",
    references: "<other@example.com> <orig@example.com>",
  });
  const { deps } = setup({ email, store });

  const result = await ingestReceivedEmail(deps, "email-3");
  const { threadId } = expectIngested(result);
  assert.equal(threadId, thread.id);
  assert.equal(store.state.threads.length, 1);
  assert.equal(store.state.messages.length, 2);
});

test("In-Reply-To alone routes the mail into the existing thread", async () => {
  const thread = makeThread({ normalizedSubject: "unrelated subject" });
  const seeded = makeMessage({
    threadId: thread.id,
    resendInboundId: "email-prev",
    messageId: "<orig@example.com>",
    sentAt: new Date("2026-07-01T00:00:00.000Z"),
  });
  const store = createFakeStore({ threads: [thread], messages: [seeded] });
  const email = makeReceivedEmail({
    id: "email-4",
    subject: "Re: something else entirely",
    references: null,
    inReplyTo: "<orig@example.com>",
  });
  const { deps } = setup({ email, store });

  const result = await ingestReceivedEmail(deps, "email-4");
  const { threadId } = expectIngested(result);
  assert.equal(threadId, thread.id);
  assert.equal(store.state.threads.length, 1);
});

test("References match beats the subject fallback", async () => {
  const refThread = makeThread({ normalizedSubject: "totally different" });
  const refMessage = makeMessage({
    threadId: refThread.id,
    messageId: "<ref@example.com>",
    sentAt: new Date("2026-07-01T00:00:00.000Z"),
  });
  const subjectThread = makeThread({
    customerEmail: "customer@example.com",
    normalizedSubject: normalizeSubject("Help"),
    lastMessageAt: new Date(Date.now() - DAY_MS),
  });
  const store = createFakeStore({ threads: [refThread, subjectThread], messages: [refMessage] });
  const email = makeReceivedEmail({
    id: "email-5",
    subject: "Re: Help",
    references: "<ref@example.com>",
  });
  const { deps } = setup({ email, store });

  const result = await ingestReceivedEmail(deps, "email-5");
  const { threadId } = expectIngested(result);
  assert.equal(threadId, refThread.id);
});

test("newest reference match wins when References hits multiple threads", async () => {
  const olderThread = makeThread({ normalizedSubject: "thread a" });
  const newerThread = makeThread({ normalizedSubject: "thread b" });
  const olderMessage = makeMessage({
    threadId: olderThread.id,
    messageId: "<m1@example.com>",
    sentAt: new Date("2026-07-01T00:00:00.000Z"),
  });
  const newerMessage = makeMessage({
    threadId: newerThread.id,
    messageId: "<m2@example.com>",
    sentAt: new Date("2026-07-05T00:00:00.000Z"),
  });
  const store = createFakeStore({
    threads: [olderThread, newerThread],
    messages: [olderMessage, newerMessage],
  });
  const email = makeReceivedEmail({
    id: "email-6",
    subject: "Re: neither",
    references: "<m1@example.com> <m2@example.com>",
  });
  const { deps } = setup({ email, store });

  const result = await ingestReceivedEmail(deps, "email-6");
  const { threadId } = expectIngested(result);
  assert.equal(threadId, newerThread.id);
});

test("subject fallback threads same customer + subject within the window", async () => {
  const thread = makeThread({
    customerEmail: "customer@example.com",
    normalizedSubject: normalizeSubject("Help"),
    lastMessageAt: new Date(Date.now() - DAY_MS),
  });
  const store = createFakeStore({ threads: [thread] });
  const email = makeReceivedEmail({ id: "email-7a", subject: "Re: Help" });
  const { deps } = setup({ email, store });

  const result = await ingestReceivedEmail(deps, "email-7a");
  const { threadId } = expectIngested(result);
  assert.equal(threadId, thread.id);
  assert.equal(store.state.threads.length, 1);
});

test("subject fallback ignores threads older than the 30-day window", async () => {
  const thread = makeThread({
    customerEmail: "customer@example.com",
    normalizedSubject: normalizeSubject("Help"),
    lastMessageAt: new Date(Date.now() - SUBJECT_FALLBACK_WINDOW_MS - DAY_MS),
  });
  const store = createFakeStore({ threads: [thread] });
  const email = makeReceivedEmail({ id: "email-7b", subject: "Re: Help" });
  const { deps } = setup({ email, store });

  const result = await ingestReceivedEmail(deps, "email-7b");
  const { threadId } = expectIngested(result);
  assert.notEqual(threadId, thread.id);
  assert.equal(store.state.threads.length, 2);
});

test("subject fallback ignores threads of a different customer", async () => {
  const thread = makeThread({
    customerEmail: "someone-else@example.com",
    normalizedSubject: normalizeSubject("Help"),
    lastMessageAt: new Date(Date.now() - DAY_MS),
  });
  const store = createFakeStore({ threads: [thread] });
  const email = makeReceivedEmail({ id: "email-7c", subject: "Re: Help" });
  const { deps } = setup({ email, store });

  const result = await ingestReceivedEmail(deps, "email-7c");
  const { threadId } = expectIngested(result);
  assert.notEqual(threadId, thread.id);
  assert.equal(store.state.threads.length, 2);
});

test("subject fallback ignores spam threads", async () => {
  const thread = makeThread({
    customerEmail: "customer@example.com",
    normalizedSubject: normalizeSubject("Help"),
    lastMessageAt: new Date(Date.now() - DAY_MS),
    status: "spam",
  });
  const store = createFakeStore({ threads: [thread] });
  const email = makeReceivedEmail({ id: "email-7d", subject: "Re: Help" });
  const { deps } = setup({ email, store });

  const result = await ingestReceivedEmail(deps, "email-7d");
  const { threadId } = expectIngested(result);
  assert.notEqual(threadId, thread.id);
  assert.equal(store.state.threads.length, 2);
});

test("bare Re: never subject-matches, even against an empty normalized subject thread", async () => {
  const thread = makeThread({
    customerEmail: "customer@example.com",
    normalizedSubject: "",
    lastMessageAt: new Date(Date.now() - DAY_MS),
  });
  const store = createFakeStore({ threads: [thread] });
  const email = makeReceivedEmail({ id: "email-7e", subject: "Re:" });
  const { deps } = setup({ email, store });

  const result = await ingestReceivedEmail(deps, "email-7e");
  const { threadId } = expectIngested(result);
  assert.notEqual(threadId, thread.id);
  assert.equal(store.state.threads.length, 2);
});

test("duplicate pre-check skips without spending a content fetch", async () => {
  const thread = makeThread();
  const seeded = makeMessage({ threadId: thread.id, resendInboundId: "email-8" });
  const store = createFakeStore({ threads: [thread], messages: [seeded] });
  const email = makeReceivedEmail({ id: "email-8" });
  const { deps, resendApi } = setup({ email, store });

  const result = await ingestReceivedEmail(deps, "email-8");
  assert.deepEqual(result, { outcome: "skipped", reason: "duplicate" });
  assert.deepEqual(resendApi.calls.getReceived, []);
});

test("duplicate race rolls back the transaction so no orphan thread commits", async () => {
  const thread = makeThread({ normalizedSubject: "unrelated subject" });
  const seeded = makeMessage({ threadId: thread.id, resendInboundId: "email-9" });
  const store = createFakeStore({ threads: [thread], messages: [seeded] });

  // Simulate a concurrent delivery landing between the pre-check and the
  // insert: both duplicate reads miss while the unique index still conflicts.
  store.findMessageByInboundId = async () => null;
  const originalTransaction = store.transaction.bind(store);
  store.transaction = async <T>(fn: (tx: SupportStore) => Promise<T>): Promise<T> =>
    originalTransaction(async (tx) => {
      tx.findMessageByInboundId = async () => null;
      return await fn(tx);
    });

  const email = makeReceivedEmail({ id: "email-9", subject: "A fresh subject" });
  const { deps } = setup({ email, store });

  const result = await ingestReceivedEmail(deps, "email-9");
  assert.deepEqual(result, { outcome: "skipped", reason: "duplicate" });
  // The thread created inside the losing transaction never committed.
  assert.equal(store.state.threads.length, 1);
  assert.equal(store.state.messages.length, 1);
});

test("new inbound reopens a closed thread", async () => {
  const thread = makeThread({
    customerEmail: "customer@example.com",
    normalizedSubject: normalizeSubject("Help"),
    lastMessageAt: new Date(Date.now() - DAY_MS),
    status: "closed",
    unread: false,
  });
  const store = createFakeStore({ threads: [thread] });
  const email = makeReceivedEmail({ id: "email-10", subject: "Re: Help" });
  const { deps } = setup({ email, store });

  const result = await ingestReceivedEmail(deps, "email-10");
  const { threadId } = expectIngested(result);
  assert.equal(threadId, thread.id);
  const updated = store.state.threads[0];
  assert.equal(updated.status, "open");
  assert.equal(updated.unread, true);
});

test("spam thread stays spam but still receives the message", async () => {
  const thread = makeThread({ status: "spam", unread: false, normalizedSubject: "spam stuff" });
  const seeded = makeMessage({
    threadId: thread.id,
    resendInboundId: "email-prev-spam",
    messageId: "<spam-orig@example.com>",
    sentAt: new Date("2026-07-01T00:00:00.000Z"),
  });
  const store = createFakeStore({ threads: [thread], messages: [seeded] });
  const email = makeReceivedEmail({ id: "email-11", references: "<spam-orig@example.com>" });
  const { deps } = setup({ email, store });

  const result = await ingestReceivedEmail(deps, "email-11");
  const { threadId } = expectIngested(result);
  assert.equal(threadId, thread.id);
  assert.equal(store.state.threads[0].status, "spam");
  assert.equal(store.state.messages.length, 2);
});

test("over-cap text body is stored capped with bodyTruncated", async () => {
  const hugeText = "a".repeat(2_000_000);
  const email = makeReceivedEmail({ id: "email-12", text: hugeText });
  const { deps, store } = setup({ email });

  const result = await ingestReceivedEmail(deps, "email-12");
  expectIngested(result);

  const message = store.state.messages[0];
  assert.equal(message.bodyTruncated, true);
  assert.ok(message.textBody);
  assert.ok(message.textBody.length < hugeText.length);
});

test("mail from our own from address is ignored as a loop", async () => {
  const email = makeReceivedEmail({
    id: "email-13a",
    from: "Acme Support <support@example.com>",
  });
  const { deps, store } = setup({ email });

  const result = await ingestReceivedEmail(deps, "email-13a");
  assert.deepEqual(result, { outcome: "ignored", reason: "loop" });
  assert.equal(store.state.threads.length, 0);
  assert.equal(store.state.messages.length, 0);
});

test("mail from an inbound address is ignored as a loop", async () => {
  const email = makeReceivedEmail({ id: "email-13b", from: "contact@example.com" });
  const { deps, store } = setup({ email });

  const result = await ingestReceivedEmail(deps, "email-13b");
  assert.deepEqual(result, { outcome: "ignored", reason: "loop" });
  assert.equal(store.state.threads.length, 0);
});

test("mail to an unrecognized recipient is ignored", async () => {
  const email = makeReceivedEmail({
    id: "email-14",
    to: ["random@elsewhere.dev"],
    cc: [],
    receivedFor: [],
  });
  const { deps, store } = setup({ email });

  const result = await ingestReceivedEmail(deps, "email-14");
  assert.deepEqual(result, { outcome: "ignored", reason: "recipient_mismatch" });
  assert.equal(store.state.threads.length, 0);
});

test("inboundAddresses null accepts mail to any recipient", async () => {
  const email = makeReceivedEmail({ id: "email-15", to: ["whoever@random.dev"] });
  const config = makeConfig({ inboundAddresses: null });
  const { deps, store } = setup({ email, config });

  const result = await ingestReceivedEmail(deps, "email-15");
  expectIngested(result);
  assert.equal(store.state.threads.length, 1);
});

test("missing createdAt defaults sentAt to now", async () => {
  const email = makeReceivedEmail({ id: "email-16", createdAt: null });
  const { deps, store } = setup({ email });

  const before = Date.now();
  const result = await ingestReceivedEmail(deps, "email-16");
  const after = Date.now();
  expectIngested(result);

  const sentAt = store.state.messages[0].sentAt.getTime();
  assert.ok(sentAt >= before - 1000 && sentAt <= after + 1000);
});

test("invalid createdAt defaults sentAt to now", async () => {
  const email = makeReceivedEmail({ id: "email-16b", createdAt: "not-a-date" });
  const { deps, store } = setup({ email });

  const before = Date.now();
  const result = await ingestReceivedEmail(deps, "email-16b");
  const after = Date.now();
  expectIngested(result);

  const sentAt = store.state.messages[0].sentAt.getTime();
  assert.ok(sentAt >= before - 1000 && sentAt <= after + 1000);
});

test("a bare (bracket-less) message_id is stored bracket-normalized so replies thread", async () => {
  const original = makeReceivedEmail({
    id: "email-17",
    messageId: "bare-id@customer.example",
    subject: "Original subject",
  });
  const { deps, store } = setup({ email: original });
  const { threadId } = expectIngested(await ingestReceivedEmail(deps, "email-17"));
  assert.equal(store.state.messages[0].messageId, "<bare-id@customer.example>");

  // The reply references the bracketed form (as compliant senders do) and has
  // an unrelated subject, so only the References match can thread it.
  const reply = makeReceivedEmail({
    id: "email-18",
    references: "<bare-id@customer.example>",
    subject: "totally different",
  });
  deps.resendApi.received.set("email-18", reply);
  const result = await ingestReceivedEmail(deps, "email-18");
  const ingested = expectIngested(result);
  assert.equal(ingested.threadId, threadId);
  assert.equal(store.state.threads.length, 1);
});
