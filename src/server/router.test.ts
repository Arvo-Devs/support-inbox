import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type {
  ComposeResponse,
  ThreadDetailResponse,
  ThreadListResponse,
  ThreadResponse,
  UnreadCountResponse,
} from "../shared/types";
import { createRouter } from "./router";
import {
  createFakeStore,
  createStubResendApi,
  makeAttachment,
  makeConfig,
  makeMessage,
  makeThread,
} from "./testing/fake-store";

const BASE = "https://admin.example/api/admin/support";

function setup(
  seed?: Parameters<typeof createFakeStore>[0],
  overrides?: Parameters<typeof makeConfig>[0],
) {
  const store = createFakeStore(seed);
  const resendApi = createStubResendApi();
  const handler = createRouter(makeConfig(overrides), { store, resendApi });
  return { handler, store, resendApi };
}

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("authorize null is byte-identical to an unknown route", async () => {
  const denied = setup(undefined, { authorize: async () => null });
  const allowed = setup();

  const deniedRes = await denied.handler(new Request(`${BASE}/threads`));
  const missRes = await allowed.handler(new Request(`${BASE}/definitely-not-a-route`));

  assert.equal(deniedRes.status, 404);
  assert.equal(missRes.status, 404);
  assert.equal(await deniedRes.text(), await missRes.text());
});

test("GET /threads returns summaries newest-first with ISO dates", async () => {
  const { handler } = setup({
    threads: [
      makeThread({
        id: "t-old",
        subject: "Older",
        customerEmail: "old@example.com",
        status: "open",
        lastMessageAt: new Date("2026-07-01T10:00:00.000Z"),
      }),
      makeThread({
        id: "t-new",
        subject: "Newer",
        customerEmail: "new@example.com",
        status: "open",
        lastMessageAt: new Date("2026-07-02T10:00:00.000Z"),
      }),
    ],
  });

  const res = await handler(new Request(`${BASE}/threads`));
  assert.equal(res.status, 200);
  const body = (await res.json()) as ThreadListResponse;

  assert.deepEqual(
    body.threads.map((thread) => thread.id),
    ["t-new", "t-old"],
  );
  const [first] = body.threads;
  assert.ok(first);
  assert.equal(first.lastMessageAt, "2026-07-02T10:00:00.000Z");
  assert.equal(typeof first.createdAt, "string");
  assert.equal(first.customerEmail, "new@example.com");
  assert.equal(body.nextCursor, null);
});

test("GET /threads filters by status and defaults to open", async () => {
  const { handler } = setup({
    threads: [
      makeThread({ id: "t-open", status: "open", lastMessageAt: new Date("2026-07-02T10:00:00Z") }),
      makeThread({
        id: "t-closed",
        status: "closed",
        lastMessageAt: new Date("2026-07-01T10:00:00Z"),
      }),
    ],
  });

  const defaultRes = await handler(new Request(`${BASE}/threads`));
  const defaultBody = (await defaultRes.json()) as ThreadListResponse;
  assert.deepEqual(
    defaultBody.threads.map((thread) => thread.id),
    ["t-open"],
  );

  const closedRes = await handler(new Request(`${BASE}/threads?status=closed`));
  const closedBody = (await closedRes.json()) as ThreadListResponse;
  assert.deepEqual(
    closedBody.threads.map((thread) => thread.id),
    ["t-closed"],
  );

  const allRes = await handler(new Request(`${BASE}/threads?status=all`));
  const allBody = (await allRes.json()) as ThreadListResponse;
  assert.equal(allBody.threads.length, 2);
});

test("GET /threads rejects an invalid status", async () => {
  const { handler } = setup();
  const res = await handler(new Request(`${BASE}/threads?status=bogus`));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Invalid status" });
});

test("GET /threads paginates via nextCursor with no overlap", async () => {
  const { handler } = setup({
    threads: [
      makeThread({ id: "t-1", status: "open", lastMessageAt: new Date("2026-07-03T10:00:00Z") }),
      makeThread({ id: "t-2", status: "open", lastMessageAt: new Date("2026-07-02T10:00:00Z") }),
      makeThread({ id: "t-3", status: "open", lastMessageAt: new Date("2026-07-01T10:00:00Z") }),
    ],
  });

  const firstRes = await handler(new Request(`${BASE}/threads?limit=2`));
  assert.equal(firstRes.status, 200);
  const firstBody = (await firstRes.json()) as ThreadListResponse;
  assert.deepEqual(
    firstBody.threads.map((thread) => thread.id),
    ["t-1", "t-2"],
  );
  assert.equal(typeof firstBody.nextCursor, "string");
  assert.ok(firstBody.nextCursor);

  const secondRes = await handler(
    new Request(`${BASE}/threads?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`),
  );
  assert.equal(secondRes.status, 200);
  const secondBody = (await secondRes.json()) as ThreadListResponse;
  assert.deepEqual(
    secondBody.threads.map((thread) => thread.id),
    ["t-3"],
  );
  assert.equal(secondBody.nextCursor, null);

  const firstIds = new Set(firstBody.threads.map((thread) => thread.id));
  assert.ok(secondBody.threads.every((thread) => !firstIds.has(thread.id)));
});

test("GET /threads rejects a malformed cursor", async () => {
  const { handler } = setup();
  const res = await handler(new Request(`${BASE}/threads?cursor=garbage!`));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Invalid cursor" });
});

test("GET /threads/unread-count counts only unread open threads", async () => {
  const { handler } = setup({
    threads: [
      makeThread({ id: "t-1", status: "open", unread: true }),
      makeThread({ id: "t-2", status: "open", unread: false }),
      makeThread({ id: "t-3", status: "closed", unread: true }),
    ],
  });

  const res = await handler(new Request(`${BASE}/threads/unread-count`));
  assert.equal(res.status, 200);
  const body = (await res.json()) as UnreadCountResponse;
  assert.deepEqual(body, { count: 1 });
});

test("GET /threads/:id returns messages ASC with grouped attachments and customer", async () => {
  const { handler } = setup(
    {
      threads: [makeThread({ id: "t-1", customerEmail: "cust@example.com" })],
      messages: [
        makeMessage({
          id: "m-2",
          threadId: "t-1",
          direction: "inbound",
          sentAt: new Date("2026-07-01T11:00:00Z"),
        }),
        makeMessage({
          id: "m-1",
          threadId: "t-1",
          direction: "inbound",
          sentAt: new Date("2026-07-01T10:00:00Z"),
        }),
      ],
      attachments: [makeAttachment({ id: "a-1", messageId: "m-2" })],
    },
    {
      lookupCustomer: async (email: string) => ({ label: `Acme (${email})`, href: "/admin/acme" }),
    },
  );

  const res = await handler(new Request(`${BASE}/threads/t-1`));
  assert.equal(res.status, 200);
  const body = (await res.json()) as ThreadDetailResponse;

  assert.equal(body.thread.id, "t-1");
  assert.deepEqual(
    body.messages.map((message) => message.id),
    ["m-1", "m-2"],
  );
  const [first, second] = body.messages;
  assert.ok(first && second);
  assert.deepEqual(first.attachments, []);
  assert.deepEqual(
    second.attachments.map((attachment) => attachment.id),
    ["a-1"],
  );
  assert.deepEqual(body.customer, { label: "Acme (cust@example.com)", href: "/admin/acme" });
});

test("GET /threads/:id survives a throwing lookupCustomer with customer null", async () => {
  const { handler } = setup(
    { threads: [makeThread({ id: "t-1" })] },
    {
      lookupCustomer: async () => {
        throw new Error("lookup exploded");
      },
    },
  );

  const res = await handler(new Request(`${BASE}/threads/t-1`));
  assert.equal(res.status, 200);
  const body = (await res.json()) as ThreadDetailResponse;
  assert.equal(body.customer, null);
});

test("GET /threads/:id returns 404 for an unknown thread", async () => {
  const { handler } = setup();
  const res = await handler(new Request(`${BASE}/threads/nope`));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Thread not found" });
});

test("POST /threads/:id/read toggles unread both ways", async () => {
  const { handler } = setup({ threads: [makeThread({ id: "t-1", unread: true })] });

  const readRes = await handler(postJson(`${BASE}/threads/t-1/read`, { read: true }));
  assert.equal(readRes.status, 200);
  const readBody = (await readRes.json()) as ThreadResponse;
  assert.equal(readBody.thread.unread, false);

  const unreadRes = await handler(postJson(`${BASE}/threads/t-1/read`, { read: false }));
  assert.equal(unreadRes.status, 200);
  const unreadBody = (await unreadRes.json()) as ThreadResponse;
  assert.equal(unreadBody.thread.unread, true);
});

test("POST /threads/:id/read rejects a non-boolean read", async () => {
  const { handler } = setup({ threads: [makeThread({ id: "t-1" })] });
  const res = await handler(postJson(`${BASE}/threads/t-1/read`, { read: "yes" }));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "read must be a boolean" });
});

test("POST /threads/:id/status transitions and clears unread on close", async () => {
  const { handler } = setup({
    threads: [makeThread({ id: "t-1", status: "open", unread: true })],
  });

  const res = await handler(postJson(`${BASE}/threads/t-1/status`, { status: "closed" }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as ThreadResponse;
  assert.equal(body.thread.status, "closed");
  assert.equal(body.thread.unread, false);
});

test("POST /threads/:id/status rejects an invalid status", async () => {
  const { handler } = setup({ threads: [makeThread({ id: "t-1" })] });
  const res = await handler(postJson(`${BASE}/threads/t-1/status`, { status: "archived" }));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Invalid status" });
});

test("unknown paths return the bare 404", async () => {
  const { handler } = setup();
  const res = await handler(new Request(`${BASE}/bogus`));
  assert.equal(res.status, 404);
  assert.equal(await res.text(), "Not found");
});

test("known path with the wrong method returns 405", async () => {
  const { handler } = setup();

  const getSync = await handler(new Request(`${BASE}/sync`));
  assert.equal(getSync.status, 405);
  assert.deepEqual(await getSync.json(), { error: "Method not allowed" });

  // /threads accepts GET (list) and POST (compose); PUT is unsupported. A body
  // is sent so it clears the non-GET JSON parse and reaches method dispatch.
  const putThreads = await handler(
    new Request(`${BASE}/threads`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  assert.equal(putThreads.status, 405);
  assert.deepEqual(await putThreads.json(), { error: "Method not allowed" });
});

test("POST /threads composes a new thread and is idempotent", async () => {
  const { handler, resendApi } = setup();
  const attemptId = randomUUID();

  const res = await handler(
    postJson(`${BASE}/threads`, {
      to: "New Customer <new@example.com>",
      subject: "Checking in",
      text: "Following up on your account.",
      replyAttemptId: attemptId,
    }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as ComposeResponse;
  assert.equal(body.thread.customerEmail, "new@example.com");
  assert.equal(body.thread.customerName, "New Customer");
  assert.equal(body.thread.subject, "Checking in");
  assert.equal(body.thread.messageCount, 1);
  assert.equal(body.message.direction, "outbound");
  assert.deepEqual(body.message.toEmails, ["new@example.com"]);
  assert.equal(resendApi.calls.send.length, 1);

  // Replay with the same attempt id: same thread, no second send.
  const replay = await handler(
    postJson(`${BASE}/threads`, {
      to: "new@example.com",
      subject: "Checking in",
      text: "Following up on your account.",
      replyAttemptId: attemptId,
    }),
  );
  assert.equal(replay.status, 200);
  const replayBody = (await replay.json()) as ComposeResponse;
  assert.equal(replayBody.thread.id, body.thread.id);
  assert.equal(resendApi.calls.send.length, 1);
});

test("POST /threads validates recipient, subject, and text", async () => {
  const { handler } = setup();
  const base = { to: "x@example.com", subject: "Hi", text: "Hello", replyAttemptId: randomUUID() };

  assert.equal((await handler(postJson(`${BASE}/threads`, { ...base, to: "not-an-email" }))).status, 400);
  assert.equal((await handler(postJson(`${BASE}/threads`, { ...base, subject: "  " }))).status, 400);
  assert.equal((await handler(postJson(`${BASE}/threads`, { ...base, text: "" }))).status, 400);
  assert.equal((await handler(postJson(`${BASE}/threads`, { ...base, replyAttemptId: "nope" }))).status, 400);
  // composing to the support address itself is rejected (would loop)
  assert.equal((await handler(postJson(`${BASE}/threads`, { ...base, to: "support@example.com" }))).status, 400);
});

test("custom basePath moves the mount point", async () => {
  const { handler } = setup({ threads: [makeThread({ id: "t-1" })] }, { basePath: "/x/y" });

  const mounted = await handler(new Request("https://admin.example/x/y/threads"));
  assert.equal(mounted.status, 200);

  const outside = await handler(new Request(`${BASE}/threads`));
  assert.equal(outside.status, 404);
  assert.equal(await outside.text(), "Not found");
});

test("POST with a mismatched Origin header is rejected", async () => {
  const { handler } = setup({ threads: [makeThread({ id: "t-1" })] });
  const res = await handler(
    postJson(`${BASE}/threads/t-1/read`, { read: true }, { origin: "https://evil.example" }),
  );
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Cross-origin request rejected" });
});

test("POST behind a Host-rewriting proxy honors X-Forwarded-Host", async () => {
  const { handler } = setup({ threads: [makeThread({ id: "t-1" })] });
  // The browser's Origin is the public host; req.url carries the internal
  // host a rewriting proxy forwarded to. X-Forwarded-Host must win.
  const res = await handler(
    postJson(
      "https://internal-upstream:3000/api/admin/support/threads/t-1/read",
      { read: true },
      { origin: "https://admin.example", "x-forwarded-host": "admin.example" },
    ),
  );
  assert.equal(res.status, 200);
});

test("POST with a same-origin Origin header is accepted", async () => {
  const { handler } = setup({ threads: [makeThread({ id: "t-1" })] });
  const res = await handler(
    postJson(`${BASE}/threads/t-1/read`, { read: true }, { origin: "https://admin.example" }),
  );
  assert.equal(res.status, 200);
});

test("POST with a non-JSON body returns 400", async () => {
  const { handler } = setup({ threads: [makeThread({ id: "t-1" })] });
  const res = await handler(
    new Request(`${BASE}/threads/t-1/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "definitely not json",
    }),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Invalid JSON body" });
});

test("POST /threads/:id/reply without a replyAttemptId returns 400", async () => {
  const { handler } = setup({ threads: [makeThread({ id: "t-1" })] });
  const res = await handler(postJson(`${BASE}/threads/t-1/reply`, { text: "hello" }));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "replyAttemptId must be a UUID" });
});

test("POST /threads/:id/reply with a well-formed body reaches the reply handler", async () => {
  // Sanity check that routing passes the actor through: a valid body against a
  // missing thread must 404 (not 400/405), proving dispatch reached reply().
  const { handler } = setup();
  const res = await handler(
    postJson(`${BASE}/threads/missing/reply`, { text: "hello", replyAttemptId: randomUUID() }),
  );
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Thread not found" });
});
