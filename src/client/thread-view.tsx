"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, Mail, MailOpen } from "lucide-react";

import { Badge, Button, ConfirmDialog, ErrorMessage, toast } from "../ui/ui-deps";
import type { MessageDto, ThreadDetailResponse, ThreadStatus } from "../shared/types";
import { getApiErrorMessage, getThread, setThreadRead, setThreadStatus } from "./api";
import { useSupportInboxBasePath } from "./context";
import { defaultExpandedIds } from "./conversation";
import { keys } from "./keys";
import { MessageItem } from "./message-item";
import { ReplyBox } from "./reply-box";

const statusTone = { open: "up", closed: "neutral", spam: "down" } as const;

export type ThreadViewProps = {
  threadId: string;
  /** Back to the list; shown below the lg breakpoint, where the list is hidden. */
  onBack?: () => void;
};

export function ThreadView({ threadId, onBack }: ThreadViewProps) {
  const basePath = useSupportInboxBasePath();
  const queryClient = useQueryClient();
  const [spamConfirmOpen, setSpamConfirmOpen] = useState(false);
  // Messages someone opened or closed by hand; the rest follow defaultExpandedIds.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  // Scroll to the newest message when the conversation first loads and after
  // our own reply lands; mail that arrives by polling leaves the reader alone.
  const scrollToEndRef = useRef(true);

  const detail = useQuery({
    queryKey: keys.thread(threadId),
    queryFn: () => getThread(basePath, threadId),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  const readMutation = useMutation({
    mutationFn: (read: boolean) => setThreadRead(basePath, threadId, read),
    onMutate: async (read: boolean) => {
      await queryClient.cancelQueries({ queryKey: keys.all });
      const previous = queryClient.getQueryData<ThreadDetailResponse>(keys.thread(threadId));
      if (previous) {
        queryClient.setQueryData<ThreadDetailResponse>(keys.thread(threadId), {
          ...previous,
          thread: { ...previous.thread, unread: !read },
        });
      }
      return { previous };
    },
    onError: (error, _read, context) => {
      if (context?.previous) {
        queryClient.setQueryData(keys.thread(threadId), context.previous);
      }
      toast.error(getApiErrorMessage(error, "Could not update the conversation"));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  });

  const statusMutation = useMutation({
    mutationFn: (status: ThreadStatus) => setThreadStatus(basePath, threadId, status),
    onMutate: async (status: ThreadStatus) => {
      await queryClient.cancelQueries({ queryKey: keys.all });
      const previous = queryClient.getQueryData<ThreadDetailResponse>(keys.thread(threadId));
      if (previous) {
        queryClient.setQueryData<ThreadDetailResponse>(keys.thread(threadId), {
          ...previous,
          thread: {
            ...previous.thread,
            // Unread is left alone: the self-hosted server clears it on
            // close/spam, Reacharound keeps the two flags apart. The refetch
            // on settle shows whichever the server did.
            status,
          },
        });
      }
      return { previous };
    },
    onError: (error, _status, context) => {
      if (context?.previous) {
        queryClient.setQueryData(keys.thread(threadId), context.previous);
      }
      toast.error(getApiErrorMessage(error, "Could not update the conversation"));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  });

  // Auto-mark-read: fire the read mutation once per thread id when the thread
  // loads unread. The ref is stamped on first load regardless of unread state
  // so a manual "Mark unread" is never immediately reverted.
  const markedRef = useRef<string | null>(null);
  const detailData = detail.data;
  const markRead = readMutation.mutate;
  useEffect(() => {
    if (!detailData) return;
    if (markedRef.current === threadId) return;
    markedRef.current = threadId;
    if (detailData.thread.unread) markRead(true);
  }, [detailData, threadId, markRead]);

  const messageCount = detailData?.messages.length ?? 0;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || messageCount === 0 || !scrollToEndRef.current) return;
    scrollToEndRef.current = false;
    el.scrollTop = el.scrollHeight;
  }, [messageCount]);

  function handleSent(message: MessageDto) {
    scrollToEndRef.current = true;
    queryClient.setQueryData<ThreadDetailResponse>(keys.thread(threadId), (prev) =>
      prev ? { ...prev, messages: [...prev.messages, message] } : prev,
    );
    void queryClient.invalidateQueries({ queryKey: keys.all });
  }

  if (detail.isPending) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground"
        role="status"
      >
        Loading conversation…
      </div>
    );
  }

  if (detail.isError) {
    return (
      <div className="p-4">
        <ErrorMessage error={detail.error} title="Could not load the conversation" />
      </div>
    );
  }

  const { thread, customer, messages } = detail.data;
  const expandedByDefault = defaultExpandedIds(messages);
  const collapsible = messages.length > 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* One compact block: subject and sender on the left, actions beside
          them when there's room, so the message gets the height. */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-border px-3 py-3 sm:px-4">
        {onBack ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Back to conversations"
            className="-ml-1 shrink-0 lg:hidden"
            onClick={onBack}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
        <div className="min-w-0 flex-1 basis-56">
          <h2
            className="line-clamp-2 break-words text-base font-semibold leading-snug text-foreground"
            title={thread.subject}
          >
            {thread.subject}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">
              {thread.customerName
                ? `${thread.customerName} · ${thread.customerEmail}`
                : thread.customerEmail}
            </span>
            {customer ? (
              <a
                href={customer.href}
                className="underline underline-offset-2 hover:text-foreground"
              >
                {customer.label}
              </a>
            ) : null}
            <Badge tone={statusTone[thread.status]} className="h-5 px-1.5 text-[11px] capitalize">
              {thread.status}
            </Badge>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => readMutation.mutate(!thread.unread)}
          >
            {thread.unread ? (
              <MailOpen className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Mail className="h-3.5 w-3.5" aria-hidden="true" />
            )}{" "}
            {thread.unread ? "Mark read" : "Mark unread"}
          </Button>
          {thread.status === "spam" ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => statusMutation.mutate("open")}
            >
              Not spam
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() =>
                  statusMutation.mutate(thread.status === "open" ? "closed" : "open")
                }
              >
                {thread.status === "open" ? "Close" : "Reopen"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-danger hover:bg-danger-soft"
                onClick={() => setSpamConfirmOpen(true)}
              >
                <Ban className="h-3.5 w-3.5" aria-hidden="true" /> Spam
              </Button>
            </>
          )}
        </div>
      </div>

      {/* A flex column, so collapsed messages keep their one line and an
          expanded HTML message (flex-1 in message-item.tsx) takes the rest of
          the pane; past its minimum height the pane scrolls. */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            expanded={toggled[message.id] ?? expandedByDefault.has(message.id)}
            onToggle={
              collapsible
                ? () =>
                    setToggled((prev) => ({
                      ...prev,
                      [message.id]: !(prev[message.id] ?? expandedByDefault.has(message.id)),
                    }))
                : undefined
            }
          />
        ))}
      </div>

      {thread.status !== "spam" ? (
        <ReplyBox threadId={thread.id} onSent={handleSent} />
      ) : null}

      <ConfirmDialog
        open={spamConfirmOpen}
        onOpenChange={setSpamConfirmOpen}
        title="Mark as spam?"
        body="This moves the conversation to Spam. New mail on this thread keeps landing in Spam and never reopens the conversation."
        confirmLabel="Mark as spam"
        tone="danger"
        pending={statusMutation.isPending}
        onConfirm={() => {
          setSpamConfirmOpen(false);
          statusMutation.mutate("spam");
        }}
      />
    </div>
  );
}
