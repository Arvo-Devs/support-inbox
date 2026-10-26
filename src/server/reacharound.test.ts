import assert from "node:assert/strict";
import test from "node:test";

import { normalizeReacharoundConfig } from "../config";
import type { SupportInboxReacharoundConfig } from "../config";
import { createSupportInbox } from "../index";
import { createReacharoundRouter } from "./reacharound";

// Reacharound mode (PRO-5000): every route is forwarded to Reacharound's inbox
// API with the inbox key and the acting admin, and every failure comes back as
// an `{ error }` the screens can show. Nothing here reaches the network — the
// router's `fetch` is a recorder that answers with scripted responses.

const BASE = "https://admin.example/api/admin/support";
const RA = "https://ra.example";
const PROJECT = "9fb8d83e-277c-4e0c-93e8-e73b699b6cc3";
const KEY = "rik_test_key";
const UPSTREAM = `${RA}/api/inbox/${PROJECT}`;

type Call = { url: string; method: string; headers: Headers; body: unknown };

function setup(
  options: {
    respond?: (call: Call) => Response | Promise<Response>;
    overrides?: Partial<SupportInboxReacharoundConfig>;
  } = {},
) {
  const calls: Call[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const answer = Promise.resolve(options.respond ? options.respond(call) : Response.json({ ok: true }));
    // Like real fetch: an aborted signal (the router's timeout) rejects the call.
    const signal = init?.signal;
    if (!signal) return answer;
    return Promise.race([
      answer,
      new Promise<Response>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]);
  }) as typeof fetch;
  const config: SupportInboxReacharoundConfig = {
    reacharound: { url: RA, projectId: PROJECT, key: KEY },
    authorize: async () => ({ id: "admin-1", email: "jane@betterfans.link", name: "Jane Support" }),
    fetch: fetchStub,
    ...options.overrides,
  };
  const handler = createReacharoundRouter(normalizeReacharoundConfig(config));
  return { handler, calls };
}

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const ACTOR = { email: "jane@betterfans.link", name: "Jane Support" };

// --- pass-through, route by route -----------------------------------------

test("GET /threads forwards only the list params, with the key and no browser headers", async () => {
  const { handler, calls } = setup({
    respond: () => Response.json({ threads: [], nextCursor: null }),
  });
  const res = await handler(
    new Request(`${BASE}/threads?status=closed&q=refund&cursor=abc&limit=10&evil=1`, {
      headers: { cookie: "session=secret", authorization: "Bearer browser-token" },
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { threads: [], nextCursor: null });

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.method, "GET");
  assert.equal(call.url, `${UPSTREAM}/threads?status=closed&q=refund&cursor=abc&limit=10`);
  assert.equal(call.headers.get("authorization"), `Bearer ${KEY}`);
  assert.equal(call.headers.get("cookie"), null);
  assert.equal(call.body, undefined);
});

test("GET /threads with no params forwards a bare path", async () => {
  const { handler, calls } = setup();
  await handler(new Request(`${BASE}/threads`));
  assert.equal(calls[0]!.url, `${UPSTREAM}/threads`);
});

test("GET /threads/unread-count is not mistaken for a thread id", async () => {
  const { handler, calls } = setup({ respond: () => Response.json({ count: 3 }) });
  const res = await handler(new Request(`${BASE}/threads/unread-count`));
  assert.deepEqual(await res.json(), { count: 3 });
  assert.equal(calls[0]!.url, `${UPSTREAM}/threads/unread-count`);
});

test("GET /threads/:id forwards the encoded id and returns the detail", async () => {
  const detail = { thread: { id: "t 1", customerEmail: "fan@gmail.com" }, customer: null, messages: [] };
  const { handler, calls } = setup({ respond: () => Response.json(detail) });
  const res = await handler(new Request(`${BASE}/threads/t%201`));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), detail);
  assert.equal(calls[0]!.url, `${UPSTREAM}/threads/t%201`);
});

test("GET /threads/:id fills `customer` from the app's own lookup", async () => {
  const detail = { thread: { id: "t1", customerEmail: "fan@gmail.com" }, customer: null, messages: [] };
  const seen: string[] = [];
  const { handler } = setup({
    respond: () => Response.json(detail),
    overrides: {
      lookupCustomer: async (email) => {
        seen.push(email);
        return { label: "Fan (Pro plan)", href: "/admin/users/42" };
      },
    },
  });
  const body = (await (await handler(new Request(`${BASE}/threads/t1`))).json()) as Record<string, unknown>;
  assert.deepEqual(seen, ["fan@gmail.com"]);
  assert.deepEqual(body.customer, { label: "Fan (Pro plan)", href: "/admin/users/42" });
});

test("a failing customer lookup never breaks the thread view", async () => {
  const detail = { thread: { id: "t1", customerEmail: "fan@gmail.com" }, customer: null, messages: [] };
  const { handler } = setup({
    respond: () => Response.json(detail),
    overrides: {
      lookupCustomer: async () => {
        throw new Error("users db down");
      },
    },
  });
  const res = await handler(new Request(`${BASE}/threads/t1`));
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as Record<string, unknown>).customer, null);
});

test("POST reply/read/status forward the body plus the acting admin", async () => {
  const { handler, calls } = setup();
  const attempt = "2b0c7d43-5d3f-4c87-9a8e-1f1f4c1d2e3f";
  await handler(postJson(`${BASE}/threads/t1/reply`, { text: "On its way", replyAttemptId: attempt }));
  await handler(postJson(`${BASE}/threads/t1/read`, { read: true }));
  await handler(postJson(`${BASE}/threads/t1/status`, { status: "closed" }));

  assert.deepEqual(
    calls.map((c) => [c.method, c.url]),
    [
      ["POST", `${UPSTREAM}/threads/t1/reply`],
      ["POST", `${UPSTREAM}/threads/t1/read`],
      ["POST", `${UPSTREAM}/threads/t1/status`],
    ],
  );
  assert.deepEqual(calls[0]!.body, { text: "On its way", replyAttemptId: attempt, actor: ACTOR });
  assert.deepEqual(calls[1]!.body, { read: true, actor: ACTOR });
  assert.deepEqual(calls[2]!.body, { status: "closed", actor: ACTOR });
  for (const call of calls) {
    assert.equal(call.headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(call.headers.get("content-type"), "application/json");
  }
});

test("POST /threads (start a conversation) forwards with the acting admin", async () => {
  const { handler, calls } = setup({
    respond: () => Response.json({ thread: { id: "t9" }, message: { id: "m9" } }),
  });
  const res = await handler(
    postJson(`${BASE}/threads`, { to: "new@gmail.com", subject: "Hi", text: "Hello", replyAttemptId: "x" }),
  );
  assert.equal(res.status, 200);
  assert.equal(calls[0]!.url, `${UPSTREAM}/threads`);
  assert.deepEqual(calls[0]!.body, {
    to: "new@gmail.com",
    subject: "Hi",
    text: "Hello",
    replyAttemptId: "x",
    actor: ACTOR,
  });
});

test("the browser cannot choose who is acting — `actor` comes from authorize", async () => {
  const { handler, calls } = setup();
  await handler(
    postJson(`${BASE}/threads/t1/reply`, {
      text: "hi",
      replyAttemptId: "x",
      actor: { email: "ceo@betterfans.link", name: "The CEO" },
    }),
  );
  assert.deepEqual((calls[0]!.body as Record<string, unknown>).actor, ACTOR);
});

test("an actor with no name sends only the email", async () => {
  const { handler, calls } = setup({
    overrides: { authorize: async () => ({ id: "a", email: "ops@betterfans.link" }) },
  });
  await handler(postJson(`${BASE}/threads/t1/read`, { read: false }));
  assert.deepEqual((calls[0]!.body as Record<string, unknown>).actor, { email: "ops@betterfans.link" });
});

test("GET /attachments/:id/url forwards and returns the signed link", async () => {
  const link = { url: "https://r.example/a", filename: "a.pdf", contentType: null, expiresAt: null };
  const { handler, calls } = setup({ respond: () => Response.json(link) });
  const res = await handler(new Request(`${BASE}/attachments/att-1/url`));
  assert.deepEqual(await res.json(), link);
  assert.equal(calls[0]!.url, `${UPSTREAM}/attachments/att-1/url`);
});

test("POST /sync is a harmless no-op that never calls Reacharound", async () => {
  const { handler, calls } = setup();
  const res = await handler(postJson(`${BASE}/sync`, {}));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { scanned: 0, imported: 0, skipped: 0, failed: 0 });
  assert.equal(calls.length, 0);
});

// --- refused before anything is forwarded ----------------------------------

test("authorize null is a bare 404, identical to an unknown route, and forwards nothing", async () => {
  const denied = setup({ overrides: { authorize: async () => null } });
  const allowed = setup();
  const deniedRes = await denied.handler(new Request(`${BASE}/threads`));
  const missRes = await allowed.handler(new Request(`${BASE}/definitely-not-a-route`));
  assert.equal(deniedRes.status, 404);
  assert.equal(missRes.status, 404);
  assert.equal(await deniedRes.text(), await missRes.text());
  assert.equal(denied.calls.length + allowed.calls.length, 0);
});

test("paths outside the mount, empty segments and unknown actions are 404s", async () => {
  const { handler, calls } = setup();
  for (const url of [
    "https://admin.example/api/other/threads",
    `${BASE}//threads`,
    `${BASE}/threads/t1/delete`,
    `${BASE}/threads/%E0%A4%A/reply`,
  ]) {
    const res = await handler(url.endsWith("reply") ? postJson(url, {}) : new Request(url));
    assert.equal(res.status, 404, url);
  }
  assert.equal(calls.length, 0);
});

test("wrong methods are 405s", async () => {
  const { handler, calls } = setup();
  assert.equal((await handler(new Request(`${BASE}/threads/t1/reply`))).status, 405);
  assert.equal((await handler(postJson(`${BASE}/threads/unread-count`, {}))).status, 405);
  assert.equal((await handler(postJson(`${BASE}/threads/t1`, {}))).status, 405);
  assert.equal((await handler(new Request(`${BASE}/sync`))).status, 405);
  assert.equal(calls.length, 0);
});

test("a cross-origin write is refused (403) and not forwarded", async () => {
  const { handler, calls } = setup();
  const res = await handler(
    postJson(`${BASE}/threads/t1/reply`, { text: "hi" }, { origin: "https://evil.example" }),
  );
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("a same-origin write behind a host-rewriting proxy is allowed", async () => {
  const { handler, calls } = setup();
  const res = await handler(
    postJson(
      "http://internal:3000/api/admin/support/threads/t1/read",
      { read: true },
      { origin: "https://admin.example", "x-forwarded-host": "admin.example" },
    ),
  );
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
});

test("an invalid JSON body is a 400 and not forwarded", async () => {
  const { handler, calls } = setup();
  const res = await handler(
    new Request(`${BASE}/threads/t1/reply`, { method: "POST", body: "not json" }),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Invalid JSON body" });
  assert.equal(calls.length, 0);
});

test("an actor without an email is a loud 500 and nothing is sent", async () => {
  const { handler, calls } = setup({ overrides: { authorize: async () => ({ id: "a" }) } });
  const res = await handler(postJson(`${BASE}/threads/t1/reply`, { text: "hi", replyAttemptId: "x" }));
  assert.equal(res.status, 500);
  assert.match(((await res.json()) as { error: string }).error, /no email address/);
  assert.equal(calls.length, 0);
});

// --- Reacharound's answers --------------------------------------------------

for (const [status, error] of [
  [400, "text: Too small"],
  [404, "Conversation not found."],
  [409, "That reply attempt belongs to a different conversation."],
  [410, "This attachment is no longer available from Resend."],
  [422, "This brand has no verified sending domain to reply from."],
  [500, "The reply WAS sent but couldn't be recorded."],
  [502, "Sending the reply failed: Resend API 500."],
] as const) {
  test(`Reacharound's ${status} passes through with its message`, async () => {
    const { handler } = setup({ respond: () => Response.json({ error }, { status }) });
    const res = await handler(postJson(`${BASE}/threads/t1/reply`, { text: "hi", replyAttemptId: "x" }));
    assert.equal(res.status, status);
    assert.deepEqual(await res.json(), { error });
  });
}

test("a refused inbox key (401) becomes a 502 that names the key, not 'logged out'", async () => {
  const { handler } = setup({
    respond: () => Response.json({ error: "invalid token" }, { status: 401 }),
  });
  const res = await handler(new Request(`${BASE}/threads`));
  assert.equal(res.status, 502);
  assert.match(((await res.json()) as { error: string }).error, /refused this app's inbox key/);
});

test("Reacharound unreachable is a 502", async () => {
  const { handler } = setup({
    respond: () => {
      throw new TypeError("fetch failed");
    },
  });
  const res = await handler(new Request(`${BASE}/threads`));
  assert.equal(res.status, 502);
  assert.match(((await res.json()) as { error: string }).error, /Could not reach Reacharound/);
});

test("Reacharound too slow: the router gives up at its timeout with a 502", async () => {
  const { handler } = setup({
    overrides: { timeoutMs: 25 },
    respond: () => new Promise<Response>(() => {}), // never answers
  });
  const started = Date.now();
  const res = await handler(new Request(`${BASE}/threads`));
  assert.equal(res.status, 502);
  assert.match(((await res.json()) as { error: string }).error, /took too long/);
  assert.ok(Date.now() - started < 2000);
});

test("a timeout from fetch (TimeoutError) says Reacharound took too long", async () => {
  const { handler } = setup({
    respond: () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    },
  });
  const res = await handler(new Request(`${BASE}/threads`));
  assert.equal(res.status, 502);
  assert.match(((await res.json()) as { error: string }).error, /took too long/);
});

test("a non-JSON answer (a proxy's HTML error page) is a 502", async () => {
  const { handler } = setup({
    respond: () => new Response("<html>Bad gateway</html>", { status: 503, headers: { "content-type": "text/html" } }),
  });
  const res = await handler(new Request(`${BASE}/threads`));
  assert.equal(res.status, 502);
  assert.match(((await res.json()) as { error: string }).error, /unexpected answer/);
});

// --- configuration ----------------------------------------------------------

test("config: builds the inbox API base from url + projectId, trailing slash or not", () => {
  const a = normalizeReacharoundConfig({
    reacharound: { url: `${RA}/`, projectId: PROJECT, key: KEY },
    authorize: async () => null,
  });
  assert.equal(a.inboxApiBase, UPSTREAM);
  assert.equal(a.basePath, "/api/admin/support");
  assert.equal(a.timeoutMs, 15_000);
});

test("config: a bad url, project id or empty key fails at creation", () => {
  const make = (reacharound: SupportInboxReacharoundConfig["reacharound"]) => () =>
    normalizeReacharoundConfig({ reacharound, authorize: async () => null });
  assert.throws(make({ url: "not a url", projectId: PROJECT, key: KEY }), /not a URL/);
  assert.throws(make({ url: "ftp://ra.example", projectId: PROJECT, key: KEY }), /http\(s\)/);
  assert.throws(make({ url: RA, projectId: "bfl", key: KEY }), /not a uuid/);
  assert.throws(make({ url: RA, projectId: PROJECT, key: "  " }), /key is empty/);
});

test("createSupportInbox in Reacharound mode needs no db, Resend key or webhook", async () => {
  const calls: string[] = [];
  const inbox = createSupportInbox({
    reacharound: { url: RA, projectId: PROJECT, key: KEY },
    authorize: async () => ({ id: "a", email: "jane@betterfans.link" }),
    fetch: (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({ count: 0 });
    }) as typeof fetch,
  });
  assert.equal("webhookHandler" in inbox, false);
  const res = await inbox.routeHandlers.GET(new Request(`${BASE}/threads/unread-count`));
  assert.deepEqual(await res.json(), { count: 0 });
  assert.deepEqual(calls, [`${UPSTREAM}/threads/unread-count`]);
});
