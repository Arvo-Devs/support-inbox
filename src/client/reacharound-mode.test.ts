import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { createSupportInbox } from "../index";
import { memoryKeyStore } from "../server/key-store";
import {
  ApiRequestError,
  getAttachmentUrl,
  getConnection,
  getThread,
  getUnreadCount,
  listThreads,
  postReply,
  postSync,
  saveInboxKey,
  setThreadRead,
  setThreadStatus,
} from "./api";
import { keys } from "./keys";
import { SupportInboxSettings } from "./settings";
import { SupportInboxPage } from "./support-inbox-page";

// PRO-5000 Part 2, judged against the plan rather than the router's internals:
//
//   "keeps the same routes and screens" — the screens' OWN data layer
//     (client/api.ts, what every component calls) works unchanged against an
//     app mounted in Reacharound mode, end to end.
//   "passes the request on … with the key and the acting person"
//   "no webhook and no Resend key" — every outbound call goes to Reacharound
//     and nowhere else; the app is built with no Resend config.
//   "the key stays on the app's server, the browser only talks to the app" —
//     the key appears in no response body or header the browser receives,
//     error answers included.
//   "hide the Sync button in this mode" — rendered, not assumed.
//
// Reacharound itself is a small in-memory fake that answers like its real
// inbox API (CWRAP-Inbox-API): it checks the bearer key, requires `actor` on
// writes, and keeps thread state so read/status/reply are observable.

const APP = "https://bfl.example";
const BASE_PATH = "/api/admin/support";
const RA = "https://ra.example";
const KEY = "rik_secret_key_that_must_never_reach_a_browser";
const OTHER_KEY = "rik_another_key_reacharound_does_not_know";

type Thread = {
  id: string;
  subject: string;
  customerEmail: string;
  customerName: string | null;
  status: "open" | "closed" | "spam";
  unread: boolean;
  inboundAddress: string | null;
  lastMessageAt: string;
  lastMessageSnippet: string | null;
  messageCount: number;
  createdAt: string;
};

function fakeReacharound() {
  const thread: Thread = {
    id: randomUUID(),
    subject: "Where is my payout?",
    customerEmail: "fan@gmail.com",
    customerName: "Fan",
    status: "open",
    unread: true,
    inboundAddress: "hello@betterfans.link",
    lastMessageAt: "2026-10-26T10:00:00.000Z",
    lastMessageSnippet: "Hi, where is it?",
    messageCount: 1,
    createdAt: "2026-10-26T10:00:00.000Z",
  };
  const attachmentId = randomUUID();
  const messages: Record<string, unknown>[] = [
    {
      id: randomUUID(),
      threadId: thread.id,
      direction: "inbound",
      fromEmail: "fan@gmail.com",
      fromName: "Fan",
      toEmails: ["hello@betterfans.link"],
      ccEmails: [],
      subject: thread.subject,
      textBody: "Hi, where is it?",
      htmlBody: null,
      bodyTruncated: false,
      snippet: "Hi, where is it?",
      actorLabel: null,
      sentAt: thread.lastMessageAt,
      attachments: [
        { id: attachmentId, filename: "receipt.pdf", contentType: "application/pdf", contentDisposition: null, contentId: null, sizeBytes: 10 },
      ],
    },
  ];
  const outbound: string[] = [];
  const seenActors: unknown[] = [];

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    outbound.push(url.toString());
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== `Bearer ${KEY}`) {
      return Response.json({ error: "invalid token" }, { status: 401 });
    }
    // The key alone names the brand: no brand id in the path (2026-10-28).
    const prefix = "/api/inbox";
    if (url.origin !== RA || !url.pathname.startsWith(prefix)) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const path = url.pathname.slice(prefix.length);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    if (init?.method === "POST") {
      if (!body?.actor) return Response.json({ error: "actor: Required" }, { status: 400 });
      seenActors.push(body.actor);
    }

    if (path === "/threads" && init?.method !== "POST") {
      const status = url.searchParams.get("status") ?? "open";
      const list = status === "all" || thread.status === status ? [thread] : [];
      return Response.json({ threads: list, nextCursor: null });
    }
    if (path === "/threads/unread-count") {
      return Response.json({ count: thread.unread && thread.status === "open" ? 1 : 0 });
    }
    if (path === `/threads/${thread.id}`) {
      return Response.json({ thread, customer: null, messages });
    }
    if (path === `/threads/${thread.id}/read`) {
      thread.unread = !body!.read;
      return Response.json({ thread });
    }
    if (path === `/threads/${thread.id}/status`) {
      thread.status = body!.status as Thread["status"];
      return Response.json({ thread });
    }
    if (path === `/threads/${thread.id}/reply`) {
      const actor = body!.actor as { email: string; name?: string };
      const message = {
        ...messages[0],
        id: randomUUID(),
        direction: "outbound",
        fromEmail: "hello@betterfans.link",
        textBody: body!.text,
        actorLabel: actor.name ?? actor.email,
        attachments: [],
      };
      messages.push(message);
      thread.messageCount += 1;
      return Response.json({ message });
    }
    if (path.startsWith("/threads/") && path.split("/").length === 3) {
      return Response.json({ error: "Conversation not found." }, { status: 404 });
    }
    if (path === `/attachments/${attachmentId}/url`) {
      return Response.json({ url: "https://files.example/receipt.pdf", filename: "receipt.pdf", contentType: "application/pdf", expiresAt: null });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }) as typeof globalThis.fetch;

  return { fetch, thread, attachmentId, outbound, seenActors };
}

/**
 * Point the browser-side `fetch` (what client/api.ts calls with relative URLs)
 * at the app's mounted route handlers, and record every response the
 * "browser" receives so the key-leak check can read all of them.
 */
function mountApp(key = KEY) {
  const ra = fakeReacharound();
  const inbox = createSupportInbox({
    reacharound: { url: RA, keyStore: memoryKeyStore(key) },
    authorize: async () => ({ id: "admin-1", email: "jane@betterfans.link", name: "Jane Support" }),
    fetch: ra.fetch,
  });
  const received: string[] = [];
  const browserFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), APP), {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), cookie: "bfl_session=abc" },
    });
    const handler = request.method === "POST" ? inbox.routeHandlers.POST : inbox.routeHandlers.GET;
    const response = await handler(request);
    const text = await response.text();
    received.push(text, JSON.stringify([...response.headers]));
    return new Response(text, { status: response.status, headers: response.headers });
  }) as typeof globalThis.fetch;
  return { inbox, ra, received, browserFetch };
}

async function withBrowserFetch<T>(browserFetch: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = browserFetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("every screen data call works unchanged against an app in Reacharound mode", async () => {
  const app = mountApp();
  await withBrowserFetch(app.browserFetch, async () => {
    const list = await listThreads({ basePath: BASE_PATH, status: "open", q: "" });
    assert.deepEqual(list.threads.map((t) => t.id), [app.ra.thread.id]);

    assert.deepEqual(await getUnreadCount(BASE_PATH), { count: 1 });

    const detail = await getThread(BASE_PATH, app.ra.thread.id);
    assert.equal(detail.thread.subject, "Where is my payout?");
    assert.equal(detail.messages[0]!.textBody, "Hi, where is it?");

    const read = await setThreadRead(BASE_PATH, app.ra.thread.id, true);
    assert.equal(read.thread.unread, false);
    assert.deepEqual(await getUnreadCount(BASE_PATH), { count: 0 });

    const replied = await postReply(BASE_PATH, app.ra.thread.id, { text: "On its way", replyAttemptId: randomUUID() });
    assert.equal(replied.message.direction, "outbound");
    assert.equal(replied.message.actorLabel, "Jane Support");
    assert.equal((await getThread(BASE_PATH, app.ra.thread.id)).messages.length, 2);

    const closed = await setThreadStatus(BASE_PATH, app.ra.thread.id, "closed");
    assert.equal(closed.thread.status, "closed");
    assert.deepEqual((await listThreads({ basePath: BASE_PATH, status: "open", q: "" })).threads, []);
    assert.equal((await listThreads({ basePath: BASE_PATH, status: "closed", q: "" })).threads.length, 1);

    const link = await getAttachmentUrl(BASE_PATH, app.ra.attachmentId);
    assert.equal(link.url, "https://files.example/receipt.pdf");

    assert.deepEqual(await postSync(BASE_PATH), { scanned: 0, imported: 0, skipped: 0, failed: 0 });
  });

  // Every write carried the acting admin, taken from authorize.
  assert.equal(app.ra.seenActors.length, 3);
  for (const actor of app.ra.seenActors) {
    assert.deepEqual(actor, { email: "jane@betterfans.link", name: "Jane Support" });
  }
});

test("errors reach the screens as ApiRequestError with Reacharound's message", async () => {
  const app = mountApp();
  await withBrowserFetch(app.browserFetch, async () => {
    await assert.rejects(getThread(BASE_PATH, randomUUID()), (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.status, 404);
      assert.equal(error.message, "Conversation not found.");
      return true;
    });
  });
});

test("a revoked key reaches the screens as a clear, key-free message that points to Settings", async () => {
  const app = mountApp("rik_revoked_key_also_secret");
  await withBrowserFetch(app.browserFetch, async () => {
    await assert.rejects(getUnreadCount(BASE_PATH), (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "KEY_REFUSED");
      assert.match(error.message, /Settings/);
      return true;
    });
  });
  assert.ok(app.received.every((text) => !text.includes("rik_revoked_key_also_secret")));
});

test("no Resend: every outbound call goes to Reacharound's inbox API and nowhere else", async () => {
  const app = mountApp();
  await withBrowserFetch(app.browserFetch, async () => {
    await listThreads({ basePath: BASE_PATH, status: "all", q: "payout" });
    await getUnreadCount(BASE_PATH);
    await getThread(BASE_PATH, app.ra.thread.id);
    await postReply(BASE_PATH, app.ra.thread.id, { text: "hi", replyAttemptId: randomUUID() });
    await setThreadRead(BASE_PATH, app.ra.thread.id, false);
    await setThreadStatus(BASE_PATH, app.ra.thread.id, "open");
    await getAttachmentUrl(BASE_PATH, app.ra.attachmentId);
    await postSync(BASE_PATH);
  });
  assert.equal(app.ra.outbound.length, 7); // sync makes no call at all
  for (const url of app.ra.outbound) {
    assert.ok(url.startsWith(`${RA}/api/inbox/`), url);
    assert.ok(!url.includes("resend.com"), url);
  }
  // Built from a config with no Resend key and no webhook secret — and there
  // is no webhook handler to mount.
  assert.equal("webhookHandler" in app.inbox, false);
});

test("the inbox key never reaches the browser — in any body or header, success or error", async () => {
  const app = mountApp();
  await withBrowserFetch(app.browserFetch, async () => {
    await listThreads({ basePath: BASE_PATH, status: "open", q: "" });
    await getUnreadCount(BASE_PATH);
    await getThread(BASE_PATH, app.ra.thread.id);
    await postReply(BASE_PATH, app.ra.thread.id, { text: "hi", replyAttemptId: randomUUID() });
    await getAttachmentUrl(BASE_PATH, app.ra.attachmentId);
    await getThread(BASE_PATH, randomUUID()).catch(() => undefined); // 404 path
    await globalThis.fetch(`${BASE_PATH}/threads/not-a-uuid`); // refused before forwarding
    await globalThis.fetch(`${BASE_PATH}/threads/${app.ra.thread.id}/reply`, {
      method: "POST",
      body: "not json",
    }); // 400 path
    await getConnection(BASE_PATH); // Settings, connected
    await saveInboxKey(BASE_PATH, KEY); // Settings saving the same key again
    await saveInboxKey(BASE_PATH, OTHER_KEY).catch(() => undefined); // refused by Reacharound
  });
  assert.ok(app.received.length >= 22);
  for (const text of app.received) {
    assert.ok(!text.includes(KEY), "the key leaked to the browser");
    assert.ok(!text.includes(OTHER_KEY), "a refused key was repeated to the browser");
  }
});

// --- the Sync button -----------------------------------------------------------

function renderPage(props: { sync?: boolean }): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    createElement(QueryClientProvider, { client }, createElement(SupportInboxPage, props)),
  );
}

test("SupportInboxPage hides the Sync button with sync={false} (Reacharound mode)", () => {
  const html = renderPage({ sync: false });
  assert.ok(!html.includes('aria-label="Sync inbox"'), "Sync button rendered in Reacharound mode");
  // The rest of the screen is still there.
  assert.ok(html.includes('aria-label="Search conversations"'));
  assert.ok(html.includes(">Open<"));
});

test("SupportInboxPage keeps the Sync button by default (self-hosted mode unchanged)", () => {
  const html = renderPage({});
  assert.ok(html.includes('aria-label="Sync inbox"'));
});

// --- Settings and the Connect panel (2026-10-28) -----------------------------

test("Settings saves a key Reacharound takes, and the screens work with it at once", async () => {
  // An app with no key saved yet. The fake Reacharound knows KEY.
  const ra = fakeReacharound();
  const empty = createSupportInbox({
    reacharound: { url: RA, keyStore: memoryKeyStore() },
    authorize: async () => ({ id: "admin-1", email: "jane@betterfans.link", name: "Jane Support" }),
    fetch: ra.fetch,
  });
  const browserFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), APP), init);
    const handler = request.method === "POST" ? empty.routeHandlers.POST : empty.routeHandlers.GET;
    return handler(request);
  }) as typeof globalThis.fetch;
  await withBrowserFetch(browserFetch, async () => {
    await assert.rejects(listThreads({ basePath: BASE_PATH, status: "open", q: "" }), (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, "NOT_CONNECTED");
      return true;
    });
    assert.deepEqual(await getConnection(BASE_PATH), { connected: false, problem: "no_key", key: null });
    const saved = await saveInboxKey(BASE_PATH, KEY);
    assert.equal(saved.connected, true);
    assert.equal(saved.key?.hint, KEY.slice(-4));
    assert.equal((await listThreads({ basePath: BASE_PATH, status: "open", q: "" })).threads.length, 1);
  });
});

function renderWith(client: QueryClient, element: ReturnType<typeof createElement>): string {
  return renderToString(createElement(QueryClientProvider, { client }, element));
}

test("SupportInboxPage shows the Connect panel, with Add the key, when Email isn't connected", async () => {
  // retryOnMount off: render the failed load as the browser ends up showing it.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  await client.prefetchInfiniteQuery({
    queryKey: keys.threads({ status: "open", q: "" }),
    queryFn: async () => {
      throw new ApiRequestError(
        "Email isn't connected to Reacharound yet. An admin can add the brand's inbox key in Settings.",
        409,
        "NOT_CONNECTED",
      );
    },
    initialPageParam: undefined as string | undefined,
  });
  const html = renderWith(client, createElement(SupportInboxPage, { sync: false }));
  assert.ok(html.includes("Connect Email to Reacharound"));
  assert.ok(html.includes("Add the key"));
  assert.ok(!html.includes('aria-label="Search conversations"'), "the list is replaced, not shown with an error");
});

test("a refused key says so on the Connect panel, with Replace the key", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  await client.prefetchInfiniteQuery({
    queryKey: keys.threads({ status: "open", q: "" }),
    queryFn: async () => {
      throw new ApiRequestError("Reacharound refused the saved inbox key.", 409, "KEY_REFUSED");
    },
    initialPageParam: undefined as string | undefined,
  });
  const html = renderWith(client, createElement(SupportInboxPage, { sync: false }));
  assert.ok(html.includes("Reacharound refused the saved key"));
  assert.ok(html.includes("Replace the key"));
});

test("SupportInboxSettings is one Settings button; the dialog opens only when it is clicked", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const html = renderWith(client, createElement(SupportInboxSettings, {}));
  assert.match(html, /Settings<\/button>/);
  assert.ok(!html.includes("Email settings"), "the dialog is closed until clicked");
});
