"use client";

// Sandboxed rendering for untrusted email HTML.
//
// Defense in depth:
// - iframe sandbox WITHOUT allow-scripts and WITHOUT allow-same-origin, so
//   even HTML that sneaks past sanitization can neither run script nor reach
//   the parent origin. allow-popups lets links open in a new tab, and
//   allow-popups-to-escape-sandbox lets those tabs render as normal pages —
//   without it they inherit this sandbox and open with scripts disabled. The
//   escape token is safe here: it loosens nothing about the frame itself
//   (still no allow-scripts / allow-same-origin), and the <base
//   target="_blank"> popups keep the implicit noopener, so the opened site
//   cannot reach back into the admin page.
// - A restrictive CSP is injected into the srcdoc document. Remote images,
//   fonts, and stylesheets are blocked by default, so tracking pixels cannot
//   fire or leak the admin's IP. Resend inlines embedded images as data: URIs
//   by default, so most legitimate images still render in blocked mode.
// - Author <base> tags and any author CSP <meta> tags are stripped so they
//   cannot loosen or redirect our document.
//
// Height is a fixed clamp with internal scrolling — auto-height would require
// allow-same-origin, which we refuse on purpose.

import { useMemo, useState } from "react";
import { Image as ImageIcon } from "lucide-react";

import { Button } from "../ui/ui-deps";

// Quoted OR unquoted src/srcset attributes, plus CSS url(...) images (inline
// styles and <style> blocks) — all of them are governed by img-src, so all of
// them must surface the "Load remote images" button when blocked.
const REMOTE_IMAGE_RE = /(?:(?:src|srcset)\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:)/i;

// Covers attribute-order variants; case-insensitive.
const BASE_TAG_RE = /<base\b[^>]*>/gi;
const AUTHOR_CSP_META_RE =
  /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi;

function buildDoc(html: string, allowRemoteImages: boolean): string {
  const imgSrc = allowRemoteImages ? "data: blob: https:" : "data: blob:";
  const cleaned = html.replace(BASE_TAG_RE, "").replace(AUTHOR_CSP_META_RE, "");
  return (
    "<!doctype html><html><head>" +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'">` +
    '<base target="_blank">' +
    "<style>body{margin:12px;font:14px/1.5 system-ui,sans-serif;color:#111;background:#fff;word-break:break-word}</style>" +
    "</head><body>" +
    cleaned +
    "</body></html>"
  );
}

export type HtmlBodyFrameProps = { html: string };

export function HtmlBodyFrame({ html }: HtmlBodyFrameProps) {
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);
  const hasRemoteImages = useMemo(() => REMOTE_IMAGE_RE.test(html), [html]);
  const doc = useMemo(() => buildDoc(html, allowRemoteImages), [html, allowRemoteImages]);

  return (
    <div className="space-y-2">
      <iframe
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={doc}
        title="Email message"
        className="h-[min(60vh,40rem)] w-full rounded-lg border border-border bg-white"
      />
      {hasRemoteImages && !allowRemoteImages ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setAllowRemoteImages(true)}
        >
          <ImageIcon className="h-3.5 w-3.5" /> Load remote images
        </Button>
      ) : null}
    </div>
  );
}
