// Pure body/snippet helpers for stored messages. htmlToText is a best-effort
// plain-text projection for list snippets — never a sanitizer; raw HTML is
// stored separately and rendered inside a sandboxed iframe by the UI.

export const BODY_CHAR_CAP = 500_000;
export const SNIPPET_LENGTH = 200;

function fromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  return String.fromCodePoint(code);
}

// Named entities are decoded after &#NN;/&#xHH; and &amp; is decoded last, so
// double-escaped input ("&amp;lt;") resolves one level per pass, not two.
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

/**
 * HTML -> plain text: script/style/head blocks are removed with their content,
 * block-level closers become line breaks, remaining tags are stripped, and
 * entities are decoded AFTER tag stripping so `&lt;script&gt;` never becomes
 * live markup. Whitespace runs collapse to single spaces.
 */
export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, " ");
  const withBreaks = withoutBlocks
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, "\n");
  const stripped = withBreaks.replace(/<[^>]*>/g, " ");
  return decodeEntities(stripped).replace(/\s+/g, " ").trim();
}

/**
 * List-view snippet: the text body wins when non-empty (whitespace-collapsed),
 * otherwise the HTML body is flattened. Null when neither yields anything.
 */
export function makeSnippet(text: string | null, html: string | null): string | null {
  const fromText = text ? text.replace(/\s+/g, " ").trim() : "";
  const source = fromText || (html ? htmlToText(html) : "");
  if (!source) return null;
  return source.slice(0, SNIPPET_LENGTH);
}

/** Caps stored bodies so a pathological mail can't bloat a row unbounded. */
export function truncateBody(body: string | null | undefined): {
  value: string | null;
  truncated: boolean;
} {
  if (body == null) return { value: null, truncated: false };
  if (body.length > BODY_CHAR_CAP) {
    return { value: body.slice(0, BODY_CHAR_CAP), truncated: true };
  }
  return { value: body, truncated: false };
}
