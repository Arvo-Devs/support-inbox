"use client";

import { Badge, EmptyState, cn } from "../ui/ui-deps";
import type { ThreadStatus, ThreadSummary } from "../shared/types";
import { formatShortDateTime } from "./format";

const statusTone = { open: "up", closed: "neutral", spam: "down" } as const;

const emptyCopy: Record<ThreadStatus, { title: string; body: string }> = {
  open: {
    title: "No open conversations",
    body: "New customer emails will show up here.",
  },
  closed: {
    title: "No closed conversations",
    body: "Conversations you close will show up here.",
  },
  spam: {
    title: "No spam",
    body: "Conversations marked as spam will show up here.",
  },
};

export type ThreadListProps = {
  threads: ThreadSummary[];
  activeStatus: ThreadStatus;
  selectedThreadId: string | null;
  onSelect: (id: string) => void;
};

export function ThreadList({
  threads,
  activeStatus,
  selectedThreadId,
  onSelect,
}: ThreadListProps) {
  if (threads.length === 0) {
    const copy = emptyCopy[activeStatus];
    return (
      <div className="p-3">
        <EmptyState compact title={copy.title} body={copy.body} />
      </div>
    );
  }

  return (
    <div className="divide-y divide-border/70">
      {threads.map((thread) => {
        const selected = thread.id === selectedThreadId;
        return (
          <button
            key={thread.id}
            type="button"
            onClick={() => onSelect(thread.id)}
            aria-current={selected ? "true" : undefined}
            className={cn(
              "flex w-full items-start gap-2 px-3 py-3 text-left transition-colors hover:bg-muted/50",
              selected && "bg-muted",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary",
                !thread.unread && "invisible",
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-sm text-foreground">
                  {thread.customerName ?? thread.customerEmail}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {formatShortDateTime(thread.lastMessageAt)}
                </span>
              </span>
              <span className="mt-0.5 flex items-center gap-1.5">
                <span
                  className={cn(
                    "min-w-0 truncate text-sm text-muted-foreground",
                    thread.unread && "font-medium text-foreground",
                  )}
                >
                  {thread.subject}
                </span>
                {thread.status !== activeStatus ? (
                  <Badge
                    tone={statusTone[thread.status]}
                    className="h-5 shrink-0 px-1.5 text-[11px] capitalize"
                  >
                    {thread.status}
                  </Badge>
                ) : null}
              </span>
              <span className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                {thread.lastMessageSnippet ?? ""}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
