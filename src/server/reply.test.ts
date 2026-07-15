import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { ReplyResponse } from "../shared/types";
import { createRouter } from "./router";
import {
  createFakeStore,
  createStubResendApi,
  makeConfig,
  makeMessage,
  makeThread,
} from "./testing/fake-store";

const BASE = "https://admin.example/api/admin/support";
const REPLY_URL = `${BASE}/threads/t-1/reply`;

type ThreadSeedOptions = { replyTo?: string | null };

function threadSeed(options: ThreadSeedOptions = {}) {
  return {
    threads: [
      makeThread({
        id: "t-1",
        subject: "Help needed",
        customerEmail: "cust@example.com",
        status: "open",
        messageCount: 2,
        lastMessageAt: new Date("2026-07-01T11:00:00Z"),
      }),
    ],
    messages: [
      makeMessage({
        id: "m-1",
        threadId: "t-1",
        direction: "inbound",
        messageId: "<a@customer.example>",
        sentAt: new Date("2026-07-01T10:00:00Z"),
      }),
      makeMessage({
        id: "m-2",
        threadId: "t-1",
        direction: "inbound",
        messageId: "<b@customer.example>",
        replyTo: options.replyTo ?? null,
        sentAt: new Date("2026-07-01T11:00:00Z"),
      }),
    ],
  };
}

function setup(seed = threadSeed()) {
  const store = createFakeStore(seed);
  const resendApi = createStubResendApi();
  const handler = createRouter(makeConfig(), { store, resendApi });
  return { handler, store, resendApi };
}

function replyRequest(body: unknown): Request {
  return new Request(REPLY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("reply sends once with the attempt id as idempotency key and correct headers", async () => {
  const { handler, store, resendApi } = setup();
  const replyAttemptId = randomUUID();

  const res = await handler(replyRequest({ text: "Thanks for reaching out.", replyAttemptId }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as ReplyResponse;

  assert.equal(resendApi.calls.send.length, 1);
  const [sendCall] = resendApi.calls.send;
  assert.ok(sendCall);
  assert.equal(sendCall.idempotencyKey, replyAttemptId);
  assert.deepEqual(sendCall.args.to, ["cust@example.com"]);
  assert.equal(sendCall.args.subject, "Re: Help needed");
  assert.equal(sendCall.args.text, "Thanks for reaching out.");

  assert.match(sendCall.args.headers["Message-ID"] ?? "", /^<si-.+@infraagent\.app>$/);
  assert.equal(sendCall.args.headers["In-Reply-To"], "<b@customer.example>");
  assert.ok(
    (sendCall.args.headers.References ?? "").includes(
      "<a@customer.example> <b@customer.example>",
    ),
  );

  assert.equal(body.message.direction, "outbound");
  assert.equal(body.message.actorLabel, "Admin");
  assert.deepEqual(body.message.toEmails, ["cust@example.com"]);
  assert.equal(body.message.threadId, "t-1");

  // Stored plus rollup applied.
  const stored = store.state.messages.find(
    (message) => message.replyAttemptId === replyAttemptId,
  );
  assert.ok(stored);
  assert.equal(stored.direction, "outbound");
  const thread = store.state.threads.find((row) => row.id === "t-1");
  assert.ok(thread);
  assert.equal(thread.messageCount, 3);
});

test("reply honors the last inbound Reply-To over the thread customer", async () => {
  const { handler, resendApi } = setup(threadSeed({ replyTo: "Someone <reply@x.com>" }));

  const res = await handler(replyRequest({ text: "On it.", replyAttemptId: randomUUID() }));
  assert.equal(res.status, 200);

  const [sendCall] = resendApi.calls.send;
  assert.ok(sendCall);
  assert.deepEqual(sendCall.args.to, ["reply@x.com"]);
});

test("posting the same replyAttemptId twice sends exactly once and replays the message", async () => {
  const { handler, store, resendApi } = setup();
  const replyAttemptId = randomUUID();
  const payload = { text: "Only once, please.", replyAttemptId };

  const first = await handler(replyRequest(payload));
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as ReplyResponse;

  const second = await handler(replyRequest(payload));
  assert.equal(second.status, 200);
  const secondBody = (await second.json()) as ReplyResponse;

  assert.equal(resendApi.calls.send.length, 1);
  assert.equal(secondBody.message.id, firstBody.message.id);
  assert.equal(
    store.state.messages.filter((message) => message.replyAttemptId === replyAttemptId).length,
    1,
  );
});

test("send failure returns 502 and stores nothing", async () => {
  const { handler, store, resendApi } = setup();
  resendApi.failures.send = new Error("resend is down");
  const messagesBefore = store.state.messages.length;

  const res = await handler(replyRequest({ text: "Hello?", replyAttemptId: randomUUID() }));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "Reply could not be sent" });

  assert.equal(store.state.messages.length, messagesBefore);
  const thread = store.state.threads.find((row) => row.id === "t-1");
  assert.ok(thread);
  assert.equal(thread.messageCount, 2);
});

test("store failure after send returns 500 with exactly one send", async () => {
  const { handler, store, resendApi } = setup();
  store.failNextInsertOutbound = true;

  const res = await handler(replyRequest({ text: "Hello?", replyAttemptId: randomUUID() }));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), {
    error: "Reply was sent but could not be recorded; retrying will not re-send",
  });
  assert.equal(resendApi.calls.send.length, 1);
});

test("empty reply text is rejected", async () => {
  const { handler, resendApi } = setup();
  const res = await handler(replyRequest({ text: "   ", replyAttemptId: randomUUID() }));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Reply text is required" });
  assert.equal(resendApi.calls.send.length, 0);
});

test("over-long reply text is rejected", async () => {
  const { handler, resendApi } = setup();
  const res = await handler(
    replyRequest({ text: "a".repeat(50_001), replyAttemptId: randomUUID() }),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Reply text is too long" });
  assert.equal(resendApi.calls.send.length, 0);
});

test("replaying an attempt id against a different thread is rejected, not replayed", async () => {
  const seed = threadSeed();
  seed.threads.push(
    makeThread({ id: "t-2", subject: "Other issue", customerEmail: "other@example.com" }),
  );
  const { handler, resendApi } = setup(seed);
  const replyAttemptId = randomUUID();

  const first = await handler(replyRequest({ text: "For thread one.", replyAttemptId }));
  assert.equal(first.status, 200);

  const crossThread = await handler(
    new Request(`${BASE}/threads/t-2/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "For thread two.", replyAttemptId }),
    }),
  );
  assert.equal(crossThread.status, 409);
  assert.deepEqual(await crossThread.json(), {
    error: "replyAttemptId was already used for a different thread",
  });
  assert.equal(resendApi.calls.send.length, 1);
});

test("rollup failure rolls back the message insert so a retry can repair everything", async () => {
  const { handler, store, resendApi } = setup();
  store.failNextOutboundRollup = true;
  const replyAttemptId = randomUUID();

  const res = await handler(replyRequest({ text: "Hello?", replyAttemptId }));
  assert.equal(res.status, 500);

  // Atomic: no stranded message row whose rollup the replay path would skip.
  assert.equal(
    store.state.messages.filter((message) => message.replyAttemptId === replyAttemptId).length,
    0,
  );
  const thread = store.state.threads.find((row) => row.id === "t-1");
  assert.ok(thread);
  assert.equal(thread.messageCount, 2);

  // The retry misses the replay lookup, re-sends (Resend replays via the
  // idempotency key), and this time records message + rollup together.
  const retry = await handler(replyRequest({ text: "Hello?", replyAttemptId }));
  assert.equal(retry.status, 200);
  assert.equal(resendApi.calls.send.length, 2);
  const repaired = store.state.threads.find((row) => row.id === "t-1");
  assert.ok(repaired);
  assert.equal(repaired.messageCount, 3);
});

test("non-UUID replyAttemptId is rejected", async () => {
  const { handler, resendApi } = setup();
  const res = await handler(replyRequest({ text: "hello", replyAttemptId: "not-a-uuid" }));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "replyAttemptId must be a UUID" });
  assert.equal(resendApi.calls.send.length, 0);
});
