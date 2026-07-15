"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Mail, MailOpen } from "lucide-react";

import { Badge, Button, ConfirmDialog, ErrorMessage, toast } from "../ui/ui-deps";
import type { MessageDto, ThreadDetailResponse, ThreadStatus } from "../shared/types";
import { getApiErrorMessage, getThread, setThreadRead, setThreadStatus } from "./api";
import { useSupportInboxBasePath } from "./context";
import { keys } from "./keys";
import { MessageItem } from "./message-item";
import { ReplyBox } from "./reply-box";

const statusTone = { open: "up", closed: "neutral", spam: "down" } as const;

export type ThreadViewProps = { threadId: string };

export function ThreadView({ threadId }: ThreadViewProps) {
  const basePath = useSupportInboxBasePath();
  const queryClient = useQueryClient();
  const [spamConfirmOpen, setSpamConfirmOpen] = useState(false);

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
            status,
            // Closing/spamming clears unread server-side; mirror it optimistically.
            unread: status === "open" ? previous.thread.unread : false,
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

  function handleSent(message: MessageDto) {
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2
              className="truncate text-base font-semibold text-foreground"
              title={thread.subject}
            >
              {thread.subject}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
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
            </div>
          </div>
          <Badge tone={statusTone[thread.status]} className="shrink-0 capitalize">
            {thread.status}
          </Badge>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
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

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((message) => (
          <MessageItem key={message.id} message={message} />
        ))}
      </div>

      {thread.status !== "spam" ? (
        <ReplyBox
          threadId={thread.id}
          customerEmail={thread.customerEmail}
          onSent={handleSent}
        />
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
