// When the Email page shows the Connect panel (Reacharound mode with no working
// key) in place of the conversations, and what Settings loads again once it
// saves a key. Kept apart from the components so connect-panel.test.ts can check
// it against a real QueryClient, without a browser.

import type { QueryClient } from "@tanstack/react-query";

import { needsSettings, type ApiRequestError } from "./api";
import { keys } from "./keys";

/** What this reads of the conversation list's query result. */
export type ListResult = { error: unknown; isPending: boolean; errorUpdateCount: number };

/**
 * The problem the Connect panel shows, or null for the conversations. `shown` is
 * the one the page showed last.
 *
 * The panel stays up while the list loads again. TanStack Query turns a query
 * that has never had data back into "pending", with no error, for the length of
 * every refetch, and with no working key the list never has data. Reading the
 * error alone took the panel down on every 30-second poll and every return to
 * the tab, and closed a Settings dialog opened from it: an admin who went to
 * Reacharound for the key came back to find the dialog closed and the key gone
 * (2026-11-08). Only a list that has failed before is kept; one that Settings
 * started over after saving a key has no failures, so it shows as loading.
 */
export function connectPanelError(
  list: ListResult,
  shown: ApiRequestError | null,
): ApiRequestError | null {
  if (needsSettings(list.error)) return list.error;
  return list.isPending && list.errorUpdateCount > 0 ? shown : null;
}

/**
 * After Settings saves a key Reacharound took. Lists that failed start over, so
 * the page drops the Connect panel and shows them loading; everything else (a
 * working list, the open conversation, the unread badge) loads again in place.
 * A list already loading again is not asked twice.
 */
export function reloadAfterKeySaved(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.resetQueries({
      queryKey: keys.lists(),
      predicate: (query) => query.state.status === "error",
    }),
    queryClient.invalidateQueries({ queryKey: keys.all }),
  ]);
}
