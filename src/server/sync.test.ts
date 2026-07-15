import assert from "node:assert/strict";
import test from "node:test";

import { createRouter } from "./router";
import { SYNC_MAX_PAGES } from "./routes/sync";
import {
  createFakeStore,
  createStubResendApi,
  makeConfig,
  makeMessage,
  makeReceivedEmail,
  makeThread,
} from "./testing/fake-store";

const SYNC_URL = "https://admin.example/api/admin/support/sync";

function syncRequest(): Request {
  return new Request(SYNC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

function summary(id: string, createdAt = "2026-07-01T10:00:00.000Z") {
  return { id, from: "cust@example.com", createdAt };
}

test("sync imports unknown ids and skips known ones with exact counts", async () => {
  const store = createFakeStore({
    threads: [makeThread({ id: "t-1" })],
    messages: [
      makeMessage({
        id: "m-1",
        threadId: "t-1",
        direction: "inbound",
        resendInboundId: "known-1",
      }),
    ],
  });
  const resendApi = createStubResendApi({
    pages: [[summary("known-1"), summary("new-1"), summary("new-2")]],
    received: [makeReceivedEmail({ id: "new-1" }), makeReceivedEmail({ id: "new-2" })],
  });
  const handler = createRouter(makeConfig(), { store, resendApi });

  const res = await handler(syncRequest());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { scanned: 3, imported: 2, skipped: 1, failed: 0 });
  assert.equal(resendApi.calls.getReceived.length, 2);
});

test("sync stops paging on a fully-known page", async () => {
  const store = createFakeStore({
    threads: [makeThread({ id: "t-1" })],
    messages: [
      makeMessage({
        id: "m-1",
        threadId: "t-1",
        direction: "inbound",
        resendInboundId: "known-1",
      }),
      makeMessage({
        id: "m-2",
        threadId: "t-1",
        direction: "inbound",
        resendInboundId: "known-2",
      }),
    ],
  });
  // A deeper page exists but must never be requested: a fully-known page
  // means everything older is already imported.
  const resendApi = createStubResendApi({
    pages: [[summary("known-1"), summary("known-2")], [summary("deeper-1")]],
    received: [makeReceivedEmail({ id: "deeper-1" })],
  });
  const handler = createRouter(makeConfig(), { store, resendApi });

  const res = await handler(syncRequest());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { scanned: 2, imported: 0, skipped: 2, failed: 0 });
  assert.equal(resendApi.calls.list.length, 1);
});

test("sync stops at the page cap when every page has unknown mail", async () => {
  const pages = Array.from({ length: SYNC_MAX_PAGES + 1 }, (_, page) => [summary(`u-${page}`)]);
  const resendApi = createStubResendApi({
    pages,
    received: pages.map((_, page) => makeReceivedEmail({ id: `u-${page}` })),
  });
  const handler = createRouter(makeConfig(), { store: createFakeStore(), resendApi });

  const res = await handler(syncRequest());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    scanned: SYNC_MAX_PAGES,
    imported: SYNC_MAX_PAGES,
    skipped: 0,
    failed: 0,
  });
  assert.equal(resendApi.calls.list.length, SYNC_MAX_PAGES);
});

test("sync treats a 429 on the first list call as a partial (empty) success", async () => {
  const resendApi = createStubResendApi({
    pages: [[summary("never-listed")]],
    received: [makeReceivedEmail({ id: "never-listed" })],
  });
  resendApi.failures.listOnPage = 0;
  const handler = createRouter(makeConfig(), { store: createFakeStore(), resendApi });

  const res = await handler(syncRequest());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { scanned: 0, imported: 0, skipped: 0, failed: 0 });
});

test("a poison email is counted as failed without blocking the rest of the run", async () => {
  const store = createFakeStore();
  // "poison-1" has no content entry, so its fetch throws a non-429
  // ResendApiError; the two healthy emails must still import and commit.
  const resendApi = createStubResendApi({
    pages: [[summary("new-1"), summary("poison-1"), summary("new-2")]],
    received: [makeReceivedEmail({ id: "new-1" }), makeReceivedEmail({ id: "new-2" })],
  });
  const handler = createRouter(makeConfig(), { store, resendApi });

  const res = await handler(syncRequest());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { scanned: 3, imported: 2, skipped: 0, failed: 1 });
  assert.equal(store.state.messages.length, 2);
  // The failed id stays unknown, so the next run retries it.
  assert.ok(!store.state.messages.some((m) => m.resendInboundId === "poison-1"));
});

test("sync returns 409 when another sync holds the lock", async () => {
  const store = createFakeStore();
  store.syncLocked = true;
  const resendApi = createStubResendApi({ pages: [[summary("u-1")]] });
  const handler = createRouter(makeConfig(), { store, resendApi });

  const res = await handler(syncRequest());
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "A sync is already running" });
  assert.equal(resendApi.calls.list.length, 0);
});
