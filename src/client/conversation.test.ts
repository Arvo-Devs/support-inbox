import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultExpandedIds, messagePreview } from "./conversation";
import { buildDoc } from "./email-doc";

const inbound = (id: string) => ({ id, direction: "inbound" as const });
const outbound = (id: string) => ({ id, direction: "outbound" as const });

test("a one-message conversation opens that message", () => {
  assert.deepEqual([...defaultExpandedIds([inbound("a")])], ["a"]);
});

test("older messages open collapsed; the newest opens", () => {
  const ids = defaultExpandedIds([inbound("a"), outbound("b"), inbound("c")]);
  assert.deepEqual([...ids].sort(), ["c"]);
});

test("after we reply, the customer's last message stays open above our reply", () => {
  const ids = defaultExpandedIds([inbound("a"), outbound("b"), inbound("c"), outbound("d")]);
  assert.deepEqual([...ids].sort(), ["c", "d"]);
});

test("a conversation we started opens our message alone", () => {
  assert.deepEqual([...defaultExpandedIds([outbound("a")])], ["a"]);
});

test("an empty conversation expands nothing", () => {
  assert.equal(defaultExpandedIds([]).size, 0);
});

test("the collapsed line prefers the snippet and flattens whitespace", () => {
  assert.equal(messagePreview({ snippet: "Hi  there\nfriend", textBody: "ignored" }), "Hi there friend");
  assert.equal(messagePreview({ snippet: null, textBody: "Line one\n\nLine two" }), "Line one Line two");
  assert.equal(messagePreview({ snippet: null, textBody: null }), "");
});

// Images load without a click (Kai, 2026-10-28), but nothing else remote does:
// no script, fonts, stylesheets or frames, and author tags can't loosen it.
test("email HTML loads https images and nothing else remote", () => {
  const doc = buildDoc('<img src="https://cdn.example.com/a.png"><p>Hi</p>');
  assert.match(
    doc,
    /content="default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline'"/,
  );
  assert.match(doc, /<meta name="referrer" content="no-referrer">/);
  assert.ok(!/script-src/.test(doc));
});

test("author <base> and CSP meta tags are stripped", () => {
  const doc = buildDoc(
    '<base href="https://evil.example/"><META HTTP-EQUIV="Content-Security-Policy" content="default-src *"><p>x</p>',
  );
  assert.ok(!doc.includes("evil.example"));
  assert.ok(!doc.includes("default-src *"));
  assert.equal(doc.match(/Content-Security-Policy/gi)?.length, 1);
});
