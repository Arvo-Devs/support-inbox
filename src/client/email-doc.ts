// The srcdoc document an email's HTML renders in (see html-body-frame.tsx for
// the sandbox around it). Pure, so the policy is unit-tested.
//
// The CSP lets images load (data:, blob: and https:) so mail reads the way the
// sender laid it out. That means a sender's tracking pixel can tell the mail
// was opened, the same trade every mainstream mail client makes (Kai,
// 2026-10-28: "It'd be nice if it just did"). Fonts, stylesheets, frames,
// media and everything else remote stay blocked, and no referrer is sent.

// Covers attribute-order variants; case-insensitive.
const BASE_TAG_RE = /<base\b[^>]*>/gi;
const AUTHOR_CSP_META_RE =
  /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi;

/** Author <base> and CSP <meta> tags are stripped so they cannot loosen or redirect our document. */
export function buildDoc(html: string): string {
  const cleaned = html.replace(BASE_TAG_RE, "").replace(AUTHOR_CSP_META_RE, "");
  return (
    "<!doctype html><html><head>" +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline'">` +
    '<meta name="referrer" content="no-referrer">' +
    '<base target="_blank">' +
    // Fixed-width layouts (the usual 600px table) shrink to a narrow pane or
    // a phone instead of hiding their right side.
    "<style>body{margin:12px;font:14px/1.5 system-ui,sans-serif;color:#111;background:#fff;word-break:break-word}" +
    "table{max-width:100%!important}img{max-width:100%;height:auto}</style>" +
    "</head><body>" +
    cleaned +
    "</body></html>"
  );
}
