import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  createFakeStore,
  createStubResendApi,
  makeConfig,
  makeMessage,
  makeReceivedEmail,
  makeThread,
} from "./testing/fake-store";
import { createWebhookHandler } from "./webhook";

// Direct handler coverage for the ONE route that stays live even while the
// admin surface is gated off: it must reject unauthorized/malformed input
// cleanly (503/401/400) and only 500 where a Resend redelivery can help.

const URL = "https://admin.example/api/webhooks/resend-inbound";
const SECRET_BYTES = Buffer.from("support-inbox-test-secret");

function signedRequest(payload: string, options: { tamper?: boolean } = {}): Request {
  const id = "msg_wh_1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", SECRET_BYTES)
    .update(`${id}.${timestamp}.${options.tamper ? `${payload} ` : payload}`)
    .digest("base64");
  return new Request(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    body: payload,
  });
}

function setup(options: { store?: ReturnType<typeof createFakeStore>; secret?: string } = {}) {
  const store = options.store ?? createFakeStore();
  const resendApi = createStubResendApi({
    received: [makeReceivedEmail({ id: "email-wh-1" })],
  });
  const config = makeConfig(options.secret === undefined ? {} : { webhookSecret: options.secret });
  return { store, resendApi, handler: createWebhookHandler(config, { store, resendApi }) };
}

test("GET answers the health ping", async () => {
  const { handler } = setup();
  const res = await handler.GET(new Request(URL));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, endpoint: "support-inbox" });
});

test("POST without a configured secret returns 503", async () => {
  const { handler } = setup({ secret: "" });
  const res = await handler.POST(signedRequest(JSON.stringify({ type: "email.received" })));
  assert.equal(res.status, 503);
});

test("POST with a tampered signature returns 401 and ingests nothing", async () => {
  const { handler, store } = setup();
  const payload = JSON.stringify({ type: "email.received", data: { email_id: "email-wh-1" } });
  const res = await handler.POST(signedRequest(payload, { tamper: true }));
  assert.equal(res.status, 401);
  assert.equal(store.state.messages.length, 0);
});

test("POST with missing svix headers returns 401", async () => {
  const { handler } = setup();
  const res = await handler.POST(
    new Request(URL, { method: "POST", body: JSON.stringify({ type: "email.received" }) }),
  );
  assert.equal(res.status, 401);
});

test("POST with a correctly signed but invalid JSON body returns 400", async () => {
  const { handler } = setup();
  const res = await handler.POST(signedRequest("{not json"));
  assert.equal(res.status, 400);
});

test("POST ignores event types other than email.received", async () => {
  const { handler } = setup();
  const res = await handler.POST(signedRequest(JSON.stringify({ type: "email.delivered" })));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ignored: true, reason: "event_type" });
});

test("POST with email.received but no email id returns 400", async () => {
  const { handler } = setup();
  const res = await handler.POST(signedRequest(JSON.stringify({ type: "email.received", data: {} })));
  assert.equal(res.status, 400);
});

test("POST ingests a signed email.received end to end", async () => {
  const { handler, store } = setup();
  const payload = JSON.stringify({ type: "email.received", data: { email_id: "email-wh-1" } });
  const res = await handler.POST(signedRequest(payload));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { success: boolean; threadId: string; messageId: string };
  assert.equal(body.success, true);
  assert.equal(store.state.messages.length, 1);
  assert.equal(store.state.messages[0].resendInboundId, "email-wh-1");
});

test("POST returns skipped for a duplicate delivery", async () => {
  const store = createFakeStore({
    threads: [makeThread({ id: "t-1" })],
    messages: [
      makeMessage({ threadId: "t-1", direction: "inbound", resendInboundId: "email-wh-1" }),
    ],
  });
  const { handler } = setup({ store });
  const payload = JSON.stringify({ type: "email.received", data: { email_id: "email-wh-1" } });
  const res = await handler.POST(signedRequest(payload));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { skipped: true });
});

test("POST returns 500 when the content fetch fails so Resend redelivers", async () => {
  const { handler, resendApi } = setup();
  resendApi.failures.getReceived = new Error("resend content fetch down");
  const payload = JSON.stringify({ type: "email.received", data: { email_id: "email-wh-1" } });
  const res = await handler.POST(signedRequest(payload));
  assert.equal(res.status, 500);
});
