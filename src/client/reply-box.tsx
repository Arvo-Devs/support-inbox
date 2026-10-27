"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Send } from "lucide-react";

import { Button, Textarea, cn, toast } from "../ui/ui-deps";
import type { MessageDto } from "../shared/types";
import { getApiErrorMessage, postReply } from "./api";
import { useSupportInboxBasePath } from "./context";
import {
  clearReplyAttempt,
  readReplyDraft,
  resolveReplyAttemptId,
  writeReplyDraft,
} from "./reply-attempt";

const MAX_LENGTH = 50_000;
const COUNTER_THRESHOLD = 40_000;

export type ReplyBoxProps = {
  threadId: string;
  onSent: (message: MessageDto) => void;
};

export function ReplyBox({ threadId, onSent }: ReplyBoxProps) {
  const basePath = useSupportInboxBasePath();
  // The draft and the attempt id live in sessionStorage per thread
  // (`reply-attempt.ts`): a reload or a thread switch keeps both, so a retry
  // after a lost answer replays the same id and the server dedupes it.
  const [text, setTextState] = useState(() => readReplyDraft(threadId));
  const setText = (next: string) => {
    setTextState(next);
    writeReplyDraft(threadId, next);
  };

  const replyMutation = useMutation({
    mutationFn: (body: { text: string; replyAttemptId: string }) =>
      postReply(basePath, threadId, body),
    onSuccess: (response) => {
      setText("");
      clearReplyAttempt(threadId);
      onSent(response.message);
      toast.success("Reply sent");
    },
    onError: (error) => {
      toast.error(getApiErrorMessage(error, "Could not send the reply"));
    },
  });

  const overLimit = text.length > MAX_LENGTH;
  const canSubmit = text.trim().length > 0 && !overLimit && !replyMutation.isPending;

  function submit() {
    if (!canSubmit) return;
    replyMutation.mutate({ text, replyAttemptId: resolveReplyAttemptId(threadId, text) });
  }

  return (
    <form
      className="border-t border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
        // No address here: the reply goes to the sender's Reply-To when the
        // last message set one, which the thread data does not carry.
        placeholder="Write a reply… (plain text)"
        aria-label="Reply"
        className="min-h-24"
        disabled={replyMutation.isPending}
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>Replies go to the sender only.</span>
          {text.length > COUNTER_THRESHOLD ? (
            <span className={cn("tabular-nums", overLimit && "text-danger")}>
              {text.length.toLocaleString()} / {MAX_LENGTH.toLocaleString()}
            </span>
          ) : null}
        </div>
        <Button type="submit" disabled={!canSubmit}>
          <Send className="h-4 w-4" aria-hidden="true" />{" "}
          {replyMutation.isPending ? "Sending…" : "Send reply"}
        </Button>
      </div>
    </form>
  );
}
