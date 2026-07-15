"use client";

import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Send } from "lucide-react";

import { Button, Textarea, cn, toast } from "../ui/ui-deps";
import type { MessageDto } from "../shared/types";
import { getApiErrorMessage, postReply } from "./api";
import { useSupportInboxBasePath } from "./context";

const MAX_LENGTH = 50_000;
const COUNTER_THRESHOLD = 40_000;

export type ReplyBoxProps = {
  threadId: string;
  customerEmail: string;
  onSent: (message: MessageDto) => void;
};

export function ReplyBox({ threadId, customerEmail, onSent }: ReplyBoxProps) {
  const basePath = useSupportInboxBasePath();
  const [text, setText] = useState("");

  // One attempt id per compose attempt. It is KEPT across failed sends so a
  // retry replays the same id (the server dedupes), and regenerated only
  // after a successful send.
  const attemptIdRef = useRef<string>(crypto.randomUUID());

  const replyMutation = useMutation({
    mutationFn: (body: { text: string; replyAttemptId: string }) =>
      postReply(basePath, threadId, body),
    onSuccess: (response) => {
      setText("");
      attemptIdRef.current = crypto.randomUUID();
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
    replyMutation.mutate({ text, replyAttemptId: attemptIdRef.current });
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
        placeholder={`Reply to ${customerEmail}… (plain text)`}
        aria-label={`Reply to ${customerEmail}`}
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
