import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReplyHeaders,
  candidateMessageIds,
  normalizeMessageId,
  normalizeSubject,
  parseReferences,
  pickThreadMatch,
  replySubject,
} from "./threading";

test("normalizeSubject strips stacked reply/forward prefixes and lowercases", () => {
  assert.equal(normalizeSubject("Re: RE: Fwd: Hi"), "hi");
  assert.equal(normalizeSubject("FW: fwd:Re: Billing question"), "billing question");
});

test("normalizeSubject returns empty for null, empty, and bare-prefix input", () => {
  assert.equal(normalizeSubject(null), "");
  assert.equal(normalizeSubject(undefined), "");
  assert.equal(normalizeSubject(""), "");
  assert.equal(normalizeSubject("   "), "");
  assert.equal(normalizeSubject("Re:"), "");
});

test("normalizeSubject collapses internal whitespace runs", () => {
  assert.equal(normalizeSubject("  Help   with \t my\n account  "), "help with my account");
});

test("replySubject prefixes Re: exactly once", () => {
  assert.equal(replySubject("Billing question"), "Re: Billing question");
  assert.equal(replySubject("Re: Billing question"), "Re: Billing question");
  assert.equal(replySubject("RE: Billing question"), "RE: Billing question");
  assert.equal(replySubject("  Re: x  "), "Re: x");
});

test("replySubject falls back for empty input", () => {
  assert.equal(replySubject(""), "Re: (no subject)");
  assert.equal(replySubject("   "), "Re: (no subject)");
});

test("parseReferences extracts angle-bracket ids in order, deduped", () => {
  assert.deepEqual(parseReferences("<a@x.com> <b@x.com>\r\n <a@x.com> <c@x.com>"), [
    "<a@x.com>",
    "<b@x.com>",
    "<c@x.com>",
  ]);
});

test("parseReferences wraps bare ids when the header has no angle brackets", () => {
  assert.deepEqual(parseReferences("a@x.com  b@x.com a@x.com"), ["<a@x.com>", "<b@x.com>"]);
});

test("parseReferences handles null, empty, and empty tokens", () => {
  assert.deepEqual(parseReferences(null), []);
  assert.deepEqual(parseReferences(undefined), []);
  assert.deepEqual(parseReferences(""), []);
  assert.deepEqual(parseReferences("<>"), []);
});

test("candidateMessageIds unions references and a normalized In-Reply-To", () => {
  assert.deepEqual(
    candidateMessageIds({ references: "<a@x.com> <b@x.com>", inReplyTo: "c@x.com" }),
    ["<a@x.com>", "<b@x.com>", "<c@x.com>"],
  );
  // Already-bracketed In-Reply-To stays as-is and dedupes against references.
  assert.deepEqual(
    candidateMessageIds({ references: "<a@x.com>", inReplyTo: "<a@x.com>" }),
    ["<a@x.com>"],
  );
  assert.deepEqual(candidateMessageIds({ references: null, inReplyTo: null }), []);
});

test("pickThreadMatch prefers the reference match with the newest sentAt", () => {
  const picked = pickThreadMatch({
    referenceMatches: [
      { threadId: "old", sentAt: new Date("2026-01-01T00:00:00Z") },
      { threadId: "new", sentAt: new Date("2026-06-01T00:00:00Z") },
      { threadId: "mid", sentAt: new Date("2026-03-01T00:00:00Z") },
    ],
    subjectFallbackThreadId: null,
  });
  assert.equal(picked, "new");
});

test("pickThreadMatch lets any reference match beat the subject fallback", () => {
  const picked = pickThreadMatch({
    referenceMatches: [{ threadId: "by-reference", sentAt: new Date("2026-01-01T00:00:00Z") }],
    subjectFallbackThreadId: "by-subject",
  });
  assert.equal(picked, "by-reference");
});

test("pickThreadMatch falls back to the subject match, then null", () => {
  assert.equal(
    pickThreadMatch({ referenceMatches: [], subjectFallbackThreadId: "by-subject" }),
    "by-subject",
  );
  assert.equal(pickThreadMatch({ referenceMatches: [], subjectFallbackThreadId: null }), null);
});

test("buildReplyHeaders dedupes references preserving order", () => {
  const headers = buildReplyHeaders({
    threadMessageIds: ["<a@x.com>", "<b@x.com>", "<a@x.com>"],
    lastInboundMessageId: "<b@x.com>",
    fromDomain: "example.com",
  });
  assert.equal(headers.references, "<a@x.com> <b@x.com>");
  assert.equal(headers.inReplyTo, "<b@x.com>");
});

test("buildReplyHeaders caps references at 20 keeping the root plus the last 19", () => {
  const ids = Array.from({ length: 25 }, (_, i) => `<m${i + 1}@x.com>`);
  const headers = buildReplyHeaders({
    threadMessageIds: ids,
    lastInboundMessageId: null,
    fromDomain: "example.com",
  });
  const kept = (headers.references ?? "").split(" ");
  assert.equal(kept.length, 20);
  assert.equal(kept[0], "<m1@x.com>");
  assert.deepEqual(kept.slice(1), ids.slice(-19));
});

test("buildReplyHeaders mints a Message-ID on the sending domain", () => {
  const headers = buildReplyHeaders({
    threadMessageIds: [],
    lastInboundMessageId: null,
    fromDomain: "example.com",
  });
  assert.match(headers.messageId, /^<si-[0-9a-f-]{36}@example\.com>$/);
});

test("buildReplyHeaders returns null references when empty and passes inReplyTo through", () => {
  const headers = buildReplyHeaders({
    threadMessageIds: [],
    lastInboundMessageId: null,
    fromDomain: "example.com",
  });
  assert.equal(headers.references, null);
  assert.equal(headers.inReplyTo, null);
});

test("normalizeMessageId brackets bare ids, keeps bracketed ids, and nulls empties", () => {
  assert.equal(normalizeMessageId("abc@mail.example"), "<abc@mail.example>");
  assert.equal(normalizeMessageId("<abc@mail.example>"), "<abc@mail.example>");
  assert.equal(normalizeMessageId("  <abc@mail.example>  "), "<abc@mail.example>");
  assert.equal(normalizeMessageId(""), null);
  assert.equal(normalizeMessageId("<>"), null);
  assert.equal(normalizeMessageId(null), null);
  assert.equal(normalizeMessageId(undefined), null);
});
