import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { createSupportInbox } from "../index";
import {
  ApiRequestError,
  getAttachmentUrl,
  getThread,
  getUnreadCount,
  listThreads,
  postReply,
  postSync,
  setThreadRead,
  setThreadStatus,
} from "./api";
import { SupportInboxPage } from "./support-inbox-page";

// PRO-5000 Part 2, judged against the plan rather than the router's internals:
//
//   "keeps the same routes and screens" — the screens' OWN data layer
//     (client/api.ts, what every component calls) works unchanged against an
//     app mounted in Reacharound mode, end to end.
//   "passes the request on … with the key and the acting person"
//   "no tables, no webhook and no Resend key" — every outbound call goes to
//     Reacharound and nowhere else; the app is built with no db/Resend config.
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
    reacharound: { url: RA, key },
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

test("a revoked key reaches the screens as a clear, key-free message", async () => {
  const app = mountApp("rik_revoked_key_also_secret");
  await withBrowserFetch(app.browserFetch, async () => {
    await assert.rejects(getUnreadCount(BASE_PATH), (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.status, 502);
      assert.match(error.message, /refused this app's inbox key/);
      return true;
    });
  });
  assert.ok(app.received.every((text) => !text.includes("rik_revoked_key_also_secret")));
});

test("no tables, no Resend: every outbound call goes to Reacharound's inbox API and nowhere else", async () => {
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
  // Built from a config with no db, no Resend key and no webhook secret — and
  // there is no webhook handler to mount.
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
  });
  assert.ok(app.received.length >= 16);
  for (const text of app.received) assert.ok(!text.includes(KEY), "the key leaked to the browser");
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
