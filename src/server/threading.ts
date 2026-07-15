import { randomUUID } from "node:crypto";

// Pure RFC 5322 threading helpers: subject normalization for the fallback
// matcher, References/In-Reply-To parsing for the primary matcher, and reply
// header construction. No I/O — the store supplies rows, these decide.

/** Longest References chain we emit; older mid-thread ids are dropped first. */
const MAX_REFERENCES = 20;

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Canonical form used by the subject fallback matcher: reply/forward prefixes
 * (`re:`, `fw:`, `fwd:`) are stripped repeatedly so "Re: RE: Fwd: Hi" and "hi"
 * collide, whitespace runs collapse, and the result is lowercased. A bare
 * prefix ("Re:") normalizes to "".
 */
export function normalizeSubject(subject: string | null | undefined): string {
  let value = (subject ?? "").trim();
  const prefix = /^(?:re|fwd?)\s*:\s*/i;
  while (prefix.test(value)) {
    value = value.replace(prefix, "");
  }
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Prefixes "Re: " exactly once — an existing re: prefix (any case) is kept as-is. */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) return "Re: (no subject)";
  if (/^re\s*:/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}

/**
 * Extracts `<...>` message ids from a References-style header, in order,
 * deduped. Headers without angle brackets (seen from sloppy senders) are
 * treated as whitespace-separated bare ids and re-wrapped.
 */
export function parseReferences(header: string | null | undefined): string[] {
  if (!header) return [];
  const tokens = /[<>]/.test(header)
    ? (header.match(/<[^<>]+>/g) ?? [])
    : header
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => `<${token}>`);
  return dedupe(tokens);
}

/**
 * Bracket-normalizes a single Message-ID header value (`abc@x` and `<abc@x>`
 * both become `<abc@x>`); null when empty. Stored ids and lookup candidates
 * must go through the same normalization or bare ids from sloppy senders
 * (or Resend itself) would never match at threading time.
 */
export function normalizeMessageId(value: string | null | undefined): string | null {
  const bare = (value ?? "").trim().replace(/^<+/, "").replace(/>+$/, "");
  return bare ? `<${bare}>` : null;
}

/** References ids plus In-Reply-To (bracket-normalized), ordered and deduped. */
export function candidateMessageIds(args: {
  references: string | null;
  inReplyTo: string | null;
}): string[] {
  const ids = parseReferences(args.references);
  const inReplyTo = normalizeMessageId(args.inReplyTo);
  if (inReplyTo) ids.push(inReplyTo);
  return dedupe(ids);
}

/**
 * Picks the thread an inbound mail belongs to. A References/In-Reply-To match
 * always beats the subject fallback; among reference matches the one with the
 * newest sentAt wins (the customer replied to that copy most recently).
 */
export function pickThreadMatch(args: {
  referenceMatches: Array<{ threadId: string; sentAt: Date }>;
  subjectFallbackThreadId: string | null;
}): string | null {
  let newest: { threadId: string; sentAt: Date } | null = null;
  for (const match of args.referenceMatches) {
    if (!newest || match.sentAt.getTime() > newest.sentAt.getTime()) newest = match;
  }
  if (newest) return newest.threadId;
  return args.subjectFallbackThreadId;
}

/**
 * Headers for an outbound reply. References keeps the thread root (first id)
 * plus the most recent ids when the chain exceeds the cap — dropping the root
 * would break threading in clients that only honor the first reference.
 */
export function buildReplyHeaders(args: {
  threadMessageIds: string[];
  lastInboundMessageId: string | null;
  fromDomain: string;
}): { messageId: string; inReplyTo: string | null; references: string | null } {
  const deduped = dedupe(args.threadMessageIds);
  const capped =
    deduped.length > MAX_REFERENCES
      ? [...deduped.slice(0, 1), ...deduped.slice(-(MAX_REFERENCES - 1))]
      : deduped;
  return {
    messageId: `<si-${randomUUID()}@${args.fromDomain}>`,
    inReplyTo: args.lastInboundMessageId,
    references: capped.length > 0 ? capped.join(" ") : null,
  };
}
