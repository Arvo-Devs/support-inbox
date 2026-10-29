"use client";

// Settings for the Email page in Reacharound mode (2026-10-29, Kai: "There
// should be a settings button in the top right to be able to add the key over
// here. That should be a part of the import too"). The host puts
// <SupportInboxSettings /> in its page header, top right, and the page's
// Connect panel shows the same button whenever no key works. The dialog says
// whether Email is connected and saves the brand's inbox key: the key goes to
// this app's server, Reacharound checks it, and only then is it kept. It never
// comes back to the browser; the dialog shows its last four characters.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Settings } from "lucide-react";

import { Button, Dialog, ErrorMessage, Input, cn, toast } from "../ui/ui-deps";
import type { ConnectionProblem, ConnectionResponse } from "../shared/types";
import { ApiRequestError, getConnection, saveInboxKey } from "./api";
import { useSupportInboxBasePath } from "./context";
import { formatFullDateTime } from "./format";
import { keys } from "./keys";

export type SupportInboxSettingsProps = {
  basePath?: string;
  /** The button's words. Default "Settings". */
  label?: string;
  /** "secondary" (default) beside the page title; "default" where it is the one thing to do. */
  variant?: "default" | "secondary";
};

export function SupportInboxSettings({
  basePath,
  label = "Settings",
  variant = "secondary",
}: SupportInboxSettingsProps) {
  const contextBasePath = useSupportInboxBasePath();
  const resolvedBasePath = basePath ?? contextBasePath;
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant={variant} onClick={() => setOpen(true)}>
        <Settings className="h-4 w-4" aria-hidden="true" />
        {label}
      </Button>
      {/* Mounted only while open, so a pasted key never outlives the dialog. */}
      {open ? <SettingsDialog basePath={resolvedBasePath} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function isSelfHosted(error: unknown): boolean {
  // A self-hosted app has no /connection route: it keeps its own mail and key.
  return error instanceof ApiRequestError && error.status === 404;
}

function SettingsDialog({ basePath, onClose }: { basePath: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const connection = useQuery({
    queryKey: keys.connection(),
    queryFn: () => getConnection(basePath),
    retry: false,
    staleTime: 0,
  });
  const save = useMutation({
    mutationFn: (value: string) => saveInboxKey(basePath, value),
    onSuccess: (result) => {
      queryClient.setQueryData(keys.connection(), result);
      // The list, the open conversation and the unread badge all load again.
      void queryClient.invalidateQueries({ queryKey: keys.all });
      toast.success("Email is connected to Reacharound");
      onClose();
    },
  });

  const selfHosted = isSelfHosted(connection.error);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = key.trim();
    if (value && !save.isPending) save.mutate(value);
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !save.isPending) onClose();
      }}
      title="Email settings"
      description="Email shows this brand's conversations from Reacharound. The brand's inbox key connects it."
    >
      <div className="mt-4 space-y-4">
        <ConnectionStatus query={connection} />
        {selfHosted ? (
          <div className="flex justify-end">
            <Button type="button" variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="support-inbox-key" className="text-sm font-medium text-foreground">
                {connection.data?.key ? "Replace the inbox key" : "Inbox key"}
              </label>
              <Input
                id="support-inbox-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="rik_…"
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                A Reacharound team admin gets it from Today › Inbox › Connect an app › Get a key,
                with this brand selected.
              </p>
            </div>
            {save.isError ? <ErrorMessage error={save.error} title="The key wasn't saved" /> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" disabled={save.isPending} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending || !key.trim()}>
                {save.isPending ? "Checking the key…" : "Save key"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}

const PROBLEM_TITLES: Record<ConnectionProblem, string> = {
  no_key: "Not connected yet",
  key_unreadable: "The saved key can't be read",
  key_refused: "Reacharound refused the saved key",
  unreachable: "Couldn't reach Reacharound",
};

function problemDetail(problem: ConnectionProblem, savedLine: string | null): string {
  switch (problem) {
    case "key_unreadable":
      return "The app's secret changed since it was saved. Paste the key again.";
    case "key_refused":
      return `${savedLine ? `${savedLine} ` : ""}It was probably replaced in Reacharound. Paste the new one.`;
    case "unreachable":
      return "The saved key couldn't be checked just now. Try again in a moment.";
    case "no_key":
      return "Paste the brand's inbox key below.";
  }
}

function ConnectionStatus({ query }: { query: UseQueryResult<ConnectionResponse, Error> }) {
  if (query.isPending) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Checking the connection…
      </p>
    );
  }
  if (query.isError) {
    if (isSelfHosted(query.error)) {
      return (
        <p className="text-sm text-muted-foreground">
          This app keeps its own email (self-hosted), so there is no Reacharound key to set.
        </p>
      );
    }
    return <ErrorMessage error={query.error} title="Couldn't check the connection" />;
  }

  const { connected, problem, key } = query.data;
  const savedLine = key
    ? `Key ending in ${key.hint}, saved ${formatFullDateTime(key.savedAt)}${key.savedBy ? ` by ${key.savedBy}` : ""}.`
    : null;
  const title = connected ? "Connected to Reacharound" : PROBLEM_TITLES[problem ?? "no_key"];
  const detail = connected ? savedLine : problemDetail(problem ?? "no_key", savedLine);
  const Icon = connected ? CircleCheck : CircleAlert;

  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-lg border p-3 text-sm",
        connected ? "border-success-border bg-success-soft" : "border-danger-border bg-danger-soft",
      )}
    >
      <Icon
        className={cn("mt-0.5 h-4 w-4 shrink-0", connected ? "text-success-strong" : "text-danger")}
        aria-hidden="true"
      />
      <div>
        <div className="font-semibold text-foreground">{title}</div>
        {detail ? <div className="mt-1 text-muted-foreground">{detail}</div> : null}
      </div>
    </div>
  );
}
