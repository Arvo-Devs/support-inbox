import assert from "node:assert/strict";
import { test } from "node:test";

import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";

import type { ThreadListResponse } from "../shared/types";
import { ApiRequestError, needsSettings } from "./api";
import { connectPanelError, reloadAfterKeySaved } from "./connect-panel";
import { keys } from "./keys";

// The Connect panel against a real QueryClient and the same observer the page's
// useInfiniteQuery runs on, with the list API answered by hand. What it guards:
// loading the list again (the 30-second poll, a return to the tab) must not take
// the panel down while no key works, or a Settings dialog opened from it closes
// with the key half pasted (2026-11-08). Saving a key must still swap the panel
// for the conversations at once.

const notConnected = () =>
  new ApiRequestError("Email isn't connected to Reacharound yet.", 409, "NOT_CONNECTED");
const EMPTY: ThreadListResponse = { threads: [], nextCursor: null };

/** The open list as the page watches it. `answerWith` sets what the list API does next. */
function watchList(client: QueryClient, first: () => Promise<ThreadListResponse>) {
  let answer = first;
  let calls = 0;
  const observer = new InfiniteQueryObserver(client, {
    queryKey: keys.threads({ status: "open", q: "" }),
    queryFn: () => {
      calls += 1;
      return answer();
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: ThreadListResponse) => page.nextCursor ?? undefined,
    retry: false,
  });
  const stop = observer.subscribe(() => {});
  return {
    observer,
    stop,
    answerWith(next: () => Promise<ThreadListResponse>) {
      answer = next;
    },
    calls: () => calls,
    async settled() {
      for (let i = 0; i < 200; i += 1) {
        const result = observer.getCurrentResult();
        if (result.fetchStatus === "idle" && !result.isPending) return result;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("the list never settled");
    },
  };
}

test("a list that failed for want of a key keeps the Connect panel up while it loads again", async () => {
  const client = new QueryClient();
  const list = watchList(client, async () => {
    throw notConnected();
  });
  try {
    const shown = connectPanelError(await list.settled(), null);
    assert.equal(shown?.code, "NOT_CONNECTED");

    // What the 30-second poll and a return to the tab do.
    const refetch = list.observer.refetch();
    const during = list.observer.getCurrentResult();
    assert.equal(during.isPending, true);
    assert.equal(needsSettings(during.error), false, "TanStack drops the error while it loads again");
    assert.equal(connectPanelError(during, shown), shown, "the panel, and a dialog opened from it, stay");

    await refetch;
    assert.equal(connectPanelError(list.observer.getCurrentResult(), shown)?.code, "NOT_CONNECTED");
  } finally {
    list.stop();
    client.clear();
  }
});

test("saving a key starts the failed list over, so the conversations replace the panel at once", async () => {
  const client = new QueryClient();
  const list = watchList(client, async () => {
    throw notConnected();
  });
  try {
    const shown = connectPanelError(await list.settled(), null);
    const asked = list.calls();
    list.answerWith(async () => EMPTY);

    const reload = reloadAfterKeySaved(client);
    assert.equal(connectPanelError(list.observer.getCurrentResult(), shown), null, "loading, not the panel");

    await reload;
    const after = list.observer.getCurrentResult();
    assert.equal(after.isSuccess, true);
    assert.equal(connectPanelError(after, shown), null);
    assert.equal(list.calls(), asked + 1, "asked once, not once for the reset and again for the reload");
  } finally {
    list.stop();
    client.clear();
  }
});

test("a working list stays on screen while it loads again after a key is saved", async () => {
  const client = new QueryClient();
  const list = watchList(client, async () => EMPTY);
  try {
    await list.settled();
    const reload = reloadAfterKeySaved(client);
    const during = list.observer.getCurrentResult();
    assert.ok(during.data, "the conversations stay while they reload");
    assert.equal(during.isFetching, true);
    await reload;
  } finally {
    list.stop();
    client.clear();
  }
});

test("the panel is for settings problems only, and only once the list has failed", () => {
  const shown = notConnected();
  const unavailable = new ApiRequestError(
    "Could not reach Reacharound. Try again in a moment.",
    503,
    "REACHAROUND_UNAVAILABLE",
  );
  // The first load shows the conversations' own loading state.
  assert.equal(connectPanelError({ error: null, isPending: true, errorUpdateCount: 0 }, null), null);
  // Reacharound being down is an error in the list, not a reason to ask for the key.
  assert.equal(connectPanelError({ error: unavailable, isPending: false, errorUpdateCount: 3 }, shown), null);
  // A list that loads clears it.
  assert.equal(connectPanelError({ error: null, isPending: false, errorUpdateCount: 1 }, shown), null);
});
