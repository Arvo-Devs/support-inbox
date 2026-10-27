import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  clearReplyAttempt,
  readReplyDraft,
  resolveReplyAttemptId,
  writeReplyDraft,
} from "./reply-attempt";

// The reply box's attempt id and draft live in sessionStorage per thread, so a
// reload or a thread switch replays the same id and the server dedupes the
// retry instead of emailing the customer twice. A Map stands in for the tab's
// sessionStorage; "reload" = forgetting everything but the store.

const T1 = "9c19d2f4-494f-4eb6-b923-7d3475753fda";
const T2 = "06477b85-cac9-4346-8158-c35cb9968ecd";

function fakeSessionStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const g = globalThis as { window?: unknown };

beforeEach(() => {
  g.window = { sessionStorage: fakeSessionStorage() };
});

test("a retry of the same draft after a reload sends the same id", () => {
  const first = resolveReplyAttemptId(T1, "Your refund is on its way.");
  // Reload: the component and its memory are gone, the tab's store is not.
  const retry = resolveReplyAttemptId(T1, "Your refund is on its way.");
  assert.equal(retry, first);
});

test("a stray space between the failed send and the retry keeps the id", () => {
  const first = resolveReplyAttemptId(T1, "Thanks!");
  assert.equal(resolveReplyAttemptId(T1, "Thanks! \n"), first);
});

test("a different draft is a different reply and gets a new id", () => {
  const first = resolveReplyAttemptId(T1, "Thanks!");
  assert.notEqual(resolveReplyAttemptId(T1, "Thanks, refunded."), first);
});

test("after a successful send the next reply gets a new id, even with the same text", () => {
  const first = resolveReplyAttemptId(T1, "Thanks!");
  clearReplyAttempt(T1);
  assert.notEqual(resolveReplyAttemptId(T1, "Thanks!"), first);
});

test("each thread keeps its own attempt", () => {
  const a = resolveReplyAttemptId(T1, "Thanks!");
  const b = resolveReplyAttemptId(T2, "Thanks!");
  assert.notEqual(a, b);
  assert.equal(resolveReplyAttemptId(T1, "Thanks!"), a);
});

test("the unsent draft survives a reload or thread switch, per thread", () => {
  writeReplyDraft(T1, "half a reply");
  assert.equal(readReplyDraft(T1), "half a reply");
  assert.equal(readReplyDraft(T2), "");
  writeReplyDraft(T1, "");
  assert.equal(readReplyDraft(T1), "");
});

test("a malformed stored attempt is ignored: a fresh id is always safe", () => {
  const s = (g.window as { sessionStorage: Storage }).sessionStorage;
  s.setItem(`support-inbox.reply-attempt.${T1}`, "{not json");
  const id = resolveReplyAttemptId(T1, "Thanks!");
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(resolveReplyAttemptId(T1, "Thanks!"), id);
});

test("a store that throws (private mode) still gives an id and an empty draft", () => {
  g.window = {
    get sessionStorage(): Storage {
      throw new Error("SecurityError");
    },
  };
  assert.match(resolveReplyAttemptId(T1, "Thanks!"), /^[0-9a-f-]{36}$/);
  assert.equal(readReplyDraft(T1), "");
  writeReplyDraft(T1, "x");
  clearReplyAttempt(T1);
});

test("on the server (no window) it still gives an id", () => {
  delete g.window;
  assert.match(resolveReplyAttemptId(T1, "Thanks!"), /^[0-9a-f-]{36}$/);
});
