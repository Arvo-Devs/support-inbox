// The reply attempt id and the unsent draft, kept per thread in sessionStorage
// (the same rule as Reacharound's own Inbox, `src/lib/inbox-reply-attempt.ts`
// in Arvo-Devs/Reacharound-Emails).
//
// The server dedupes a reply on its `replyAttemptId`, and Reacharound tells the
// admin "reload and try again, it's safe" when a send's answer is lost. That
// only holds if the SAME id comes back after the reload. Held in a `useRef`,
// the id died with the component — on a reload, or on a thread switch (the
// thread view is keyed per thread) — so the retry minted a new id and the
// customer got the reply twice.
//
// Session-scoped on purpose, not localStorage: a failed attempt's id is never
// cleared (there is no success to clear it on), and one resurfacing days later
// would make the server return the OLD reply and swallow a new one. The tab's
// lifetime bounds that. The id is bound to the draft it was minted for: a
// different text is a different reply and gets a new id.

export type ReplyAttempt = { id: string; text: string };

const attemptKey = (threadId: string) => `support-inbox.reply-attempt.${threadId}`;
const draftKey = (threadId: string) => `support-inbox.reply-draft.${threadId}`;

/**
 * sessionStorage can throw rather than no-op (private modes, storage disabled
 * by policy, quota). The id is a safety net, not a dependency: without a store
 * the box falls back to an in-memory id, as before.
 */
function store(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readReplyAttempt(threadId: string): ReplyAttempt | null {
  try {
    const raw = store()?.getItem(attemptKey(threadId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    // Anything malformed is treated as absent: a fresh id is always safe.
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as ReplyAttempt).id === "string" &&
      typeof (parsed as ReplyAttempt).text === "string"
    ) {
      return parsed as ReplyAttempt;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The id to send with this draft, stored BEFORE the request goes out so a
 * reload mid-send still finds it. Same thread + same draft as an unfinished
 * attempt → the same id; anything else mints a new one.
 */
export function resolveReplyAttemptId(threadId: string, text: string): string {
  // Trimmed here, not by the caller: a stray trailing space between the failed
  // send and the retry must not mint a new id and send a duplicate.
  const normalized = text.trim();
  const existing = readReplyAttempt(threadId);
  if (existing && existing.text === normalized) return existing.id;
  const id = crypto.randomUUID();
  try {
    store()?.setItem(attemptKey(threadId), JSON.stringify({ id, text: normalized }));
  } catch {
    // Quota or a disabled store: the id still works for this mount.
  }
  return id;
}

/** After a successful send: the next reply on this thread is a new attempt. */
export function clearReplyAttempt(threadId: string): void {
  try {
    store()?.removeItem(attemptKey(threadId));
  } catch {
    // A stale id is bounded by the tab session.
  }
}

/** The unsent reply on this thread, so a reload or a thread switch keeps it. */
export function readReplyDraft(threadId: string): string {
  try {
    return store()?.getItem(draftKey(threadId)) ?? "";
  } catch {
    return "";
  }
}

export function writeReplyDraft(threadId: string, text: string): void {
  try {
    const s = store();
    if (!s) return;
    if (text) s.setItem(draftKey(threadId), text);
    else s.removeItem(draftKey(threadId));
  } catch {
    // Typing still works; the draft just won't survive a reload.
  }
}
