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
// - A restrictive CSP is injected into the srcdoc document (email-doc.ts):
//   images load, nothing else remote does, and no referrer is sent.
//
// The frame takes the height its parent gives it (the reading pane, or the
// full-size view) and scrolls inside — auto-height would require
// allow-same-origin, which we refuse on purpose. Callers lay it out as a flex
// item (`flex-1`), so it renders as a bare <iframe> with no wrapper.

import { useMemo } from "react";

import { cn } from "../ui/ui-deps";
import { buildDoc } from "./email-doc";

export type HtmlBodyFrameProps = { html: string; className?: string };

export function HtmlBodyFrame({ html, className }: HtmlBodyFrameProps) {
  const doc = useMemo(() => buildDoc(html), [html]);
  return (
    <iframe
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      title="Email message"
      className={cn("w-full rounded-lg border border-border bg-white", className)}
    />
  );
}
