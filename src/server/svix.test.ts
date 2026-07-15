import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { verifySvixSignature } from "./svix";

// Ported from apps/dashboard/src/server/notifications/resend-webhook.test.ts
// (svix cases only — the suppression cases stay with the dashboard).

const SECRET_BYTES = Buffer.from("test-webhook-secret-material");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const NOW = new Date("2026-07-03T12:00:00Z");

function sign(payload: string, options: { id?: string; timestamp?: string; secret?: Buffer } = {}) {
  const id = options.id ?? "msg_123";
  const timestamp = options.timestamp ?? String(Math.floor(NOW.getTime() / 1000));
  const signature = createHmac("sha256", options.secret ?? SECRET_BYTES)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");
  return { id, timestamp, signature: `v1,${signature}` };
}

test("accepts a correctly signed payload", () => {
  const payload = JSON.stringify({ type: "email.received" });
  const headers = sign(payload);
  assert.equal(verifySvixSignature({ secret: SECRET, payload, headers, now: NOW }), true);
});

test("accepts when any space-separated signature matches", () => {
  const payload = "{}";
  const headers = sign(payload);
  headers.signature = `v1,bm90LXRoZS1yaWdodC1zaWduYXR1cmU= ${headers.signature}`;
  assert.equal(verifySvixSignature({ secret: SECRET, payload, headers, now: NOW }), true);
});

test("rejects a tampered payload", () => {
  const headers = sign(JSON.stringify({ type: "email.received" }));
  const payload = JSON.stringify({ type: "email.delivered" });
  assert.equal(verifySvixSignature({ secret: SECRET, payload, headers, now: NOW }), false);
});

test("rejects a signature from the wrong secret", () => {
  const payload = "{}";
  const headers = sign(payload, { secret: Buffer.from("some-other-secret") });
  assert.equal(verifySvixSignature({ secret: SECRET, payload, headers, now: NOW }), false);
});

test("rejects timestamps outside the tolerance window", () => {
  const payload = "{}";
  const stale = String(Math.floor(NOW.getTime() / 1000) - 6 * 60);
  const headers = sign(payload, { timestamp: stale });
  assert.equal(verifySvixSignature({ secret: SECRET, payload, headers, now: NOW }), false);
});

test("rejects missing svix headers", () => {
  const payload = "{}";
  const headers = { ...sign(payload), id: null };
  assert.equal(verifySvixSignature({ secret: SECRET, payload, headers, now: NOW }), false);
});
