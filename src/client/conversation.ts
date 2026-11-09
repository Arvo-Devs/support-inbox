// Pure helpers for how a conversation reads in the thread view.

import type { MessageDto } from "../shared/types";

/**
 * The messages a conversation opens with expanded: the newest one, and the
 * customer's newest, so what they last asked is always in view even after
 * we answer. Everything older opens as a one-line summary.
 */
export function defaultExpandedIds(
  messages: ReadonlyArray<Pick<MessageDto, "id" | "direction">>,
): Set<string> {
  const ids = new Set<string>();
  const newest = messages[messages.length - 1];
  if (newest) ids.add(newest.id);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.direction === "inbound") {
      ids.add(message.id);
      break;
    }
  }
  return ids;
}

/** One line for a collapsed message: the stored snippet, else the text body. */
export function messagePreview(message: Pick<MessageDto, "snippet" | "textBody">): string {
  return (message.snippet ?? message.textBody ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The read toggle in a conversation's header: its words, and the `read` value it
 * sends. An unread conversation offers Mark read and sends `read: true`; a read
 * one offers Mark unread and sends `read: false`. Both come from here because
 * the button once sent the opposite of its words: Mark unread marked the
 * conversation read, so it never came back as unread (2026-11-08).
 */
export function readToggle(unread: boolean): {
  label: "Mark read" | "Mark unread";
  read: boolean;
} {
  return unread ? { label: "Mark read", read: true } : { label: "Mark unread", read: false };
}
