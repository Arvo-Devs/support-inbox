"use client";

import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Inbox, KeyRound, RefreshCw, Search } from "lucide-react";

import { Button, EmptyState, ErrorMessage, Input, cn, toast } from "../ui/ui-deps";
import type { ThreadStatus } from "../shared/types";
import { getApiErrorMessage, listThreads, needsSettings, postSync, type ApiRequestError } from "./api";
import { SupportInboxProvider, useSupportInboxBasePath } from "./context";
import { keys } from "./keys";
import { SupportInboxSettings } from "./settings";
import { ThreadList } from "./thread-list";
import { ThreadView } from "./thread-view";

const statusTabs: Array<{ value: ThreadStatus; label: string }> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "spam", label: "Spam" },
];

export type SupportInboxPageProps = {
  basePath?: string;
  /**
   * Show the Sync button. Default true (self-hosted mode, where Sync pulls
   * missed mail from Resend). Pass `false` in Reacharound mode: Reacharound
   * catches up on its own, so the button would only ever say "up to date".
   */
  sync?: boolean;
};

export function SupportInboxPage({ basePath, sync = true }: SupportInboxPageProps) {
  return (
    <SupportInboxProvider basePath={basePath}>
      <SupportInboxPageInner sync={sync} />
    </SupportInboxProvider>
  );
}

function SupportInboxPageInner({ sync }: { sync: boolean }) {
  const basePath = useSupportInboxBasePath();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ThreadStatus>("open");
  const [search, setSearch] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const threadsQuery = useInfiniteQuery({
    queryKey: keys.threads({ status, q: debouncedQ }),
    queryFn: ({ pageParam }) =>
      listThreads({ basePath, status, q: debouncedQ, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // Settings fixes a missing or refused key; retrying only delays the panel.
    retry: (failureCount, error) => !needsSettings(error) && failureCount < 3,
    // Interval refetches of an infinite query re-run EVERY cached page
    // sequentially, so polling only runs while a single page is loaded; once
    // the admin pages deeper, the unread badge remains the freshness signal.
    refetchInterval: (query) => ((query.state.data?.pages.length ?? 0) > 1 ? false : 30_000),
    refetchIntervalInBackground: false,
  });

  const syncMutation = useMutation({
    mutationFn: () => postSync(basePath),
    onSuccess: (result) => {
      if (result.failed > 0) {
        toast.error(
          `${result.failed} ${result.failed === 1 ? "message" : "messages"} failed to import; syncing again will retry`,
        );
      } else {
        toast.success(
          result.imported === 0
            ? "Inbox is up to date"
            : `Imported ${result.imported} new ${result.imported === 1 ? "message" : "messages"}`,
        );
      }
      void queryClient.invalidateQueries({ queryKey: keys.all });
    },
    onError: (error) => {
      toast.error(getApiErrorMessage(error, "Could not sync the inbox"));
    },
  });

  const threads = useMemo(
    () => threadsQuery.data?.pages.flatMap((page) => page.threads) ?? [],
    [threadsQuery.data],
  );

  const showDetail = selectedThreadId !== null;

  // Not connected, or the saved key stopped working: the whole card says so,
  // with the button that fixes it, instead of an error in the list column.
  if (needsSettings(threadsQuery.error)) return <ConnectPanel error={threadsQuery.error} />;

  return (
    <div className="flex h-full min-h-[520px] overflow-hidden rounded-2xl border border-border/70 bg-card">
      {/* Thread list column — on mobile it swaps out for the detail pane. */}
      <div
        className={cn(
          "w-full flex-col lg:flex lg:w-96 lg:shrink-0 lg:border-r lg:border-border",
          showDetail ? "hidden" : "flex",
        )}
      >
        <div className="space-y-3 border-b border-border p-3">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              {statusTabs.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  aria-pressed={status === tab.value}
                  onClick={() => setStatus(tab.value)}
                  className={cn(
                    "rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                    status === tab.value
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="flex-1" />
            {sync ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Sync inbox"
                title="Sync inbox"
                disabled={syncMutation.isPending}
                onClick={() => syncMutation.mutate()}
              >
                <RefreshCw
                  className={cn("h-4 w-4", syncMutation.isPending && "animate-spin")}
                  aria-hidden="true"
                />
              </Button>
            ) : null}
          </div>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              aria-label="Search conversations"
              placeholder="Search conversations…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-9"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {threadsQuery.isPending ? (
            <div className="p-6 text-center text-sm text-muted-foreground" role="status">
              Loading conversations…
            </div>
          ) : threadsQuery.isError ? (
            <div className="p-3">
              <ErrorMessage error={threadsQuery.error} title="Could not load conversations" />
            </div>
          ) : (
            <>
              <ThreadList
                threads={threads}
                activeStatus={status}
                selectedThreadId={selectedThreadId}
                onSelect={setSelectedThreadId}
              />
              {threadsQuery.hasNextPage ? (
                <div className="p-3">
                  <Button
                    type="button"
                    variant="secondary"
                    className="w-full"
                    disabled={threadsQuery.isFetchingNextPage}
                    onClick={() => void threadsQuery.fetchNextPage()}
                  >
                    {threadsQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* Detail pane */}
      <div className={cn("min-w-0 flex-1 flex-col", showDetail ? "flex" : "hidden lg:flex")}>
        {selectedThreadId ? (
          <>
            <div className="border-b border-border p-2 lg:hidden">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSelectedThreadId(null)}
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <ThreadView key={selectedThreadId} threadId={selectedThreadId} />
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState
              title="Select a conversation"
              body="Choose a conversation from the list to read the thread and reply."
              icon={Inbox}
              className="border-none bg-transparent"
            />
          </div>
        )}
      </div>
    </div>
  );
}

const CONNECT_TITLES: Record<string, string> = {
  NOT_CONNECTED: "Connect Email to Reacharound",
  KEY_UNREADABLE: "Add the inbox key again",
  KEY_REFUSED: "Reacharound refused the saved key",
};

/** Reacharound mode with no working key: what's wrong, and the button that opens Settings. */
function ConnectPanel({ error }: { error: ApiRequestError }) {
  return (
    <div className="flex h-full min-h-[520px] items-center justify-center overflow-hidden rounded-2xl border border-border/70 bg-card p-6">
      <EmptyState
        icon={KeyRound}
        title={CONNECT_TITLES[error.code ?? ""] ?? CONNECT_TITLES.NOT_CONNECTED!}
        body={error.message}
        action={
          <SupportInboxSettings
            label={error.code === "KEY_REFUSED" ? "Replace the key" : "Add the key"}
            variant="default"
          />
        }
        className="border-0 bg-transparent"
      />
    </div>
  );
}
