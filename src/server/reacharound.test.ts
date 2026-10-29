import assert from "node:assert/strict";
import test from "node:test";

import { normalizeReacharoundConfig, REACHAROUND_URL } from "../config";
import type { SupportInboxReacharoundConfig } from "../config";
import { createSupportInbox } from "../index";
import type { ConnectionResponse } from "../shared/types";
import { memoryKeyStore, type ReacharoundKeyStore } from "./key-store";
import { createReacharoundRouter } from "./reacharound";

// Reacharound mode (PRO-5000): every route is forwarded to Reacharound's inbox
// API with the inbox key Settings saved and the acting admin, and every
// failure comes back as an `{ error }` the screens can show. Nothing here
// reaches the network — the router's `fetch` is a recorder that answers with
// scripted responses, and the key lives in a memory key store.

const BASE = "https://admin.example/api/admin/support";
const RA = "https://ra.example";
const KEY = "rik_test_key";
// The key alone names the brand: no brand id in the path (2026-10-28).
const UPSTREAM = `${RA}/api/inbox`;
const T1 = "9c19d2f4-494f-4eb6-b923-7d3475753fda";
const A1 = "06477b85-cac9-4346-8158-c35cb9968ecd";

type Call = { url: string; method: string; headers: Headers; body: unknown; redirect?: RequestRedirect };

function setup(
  options: {
    respond?: (call: Call) => Response | Promise<Response>;
    overrides?: Partial<SupportInboxReacharoundConfig>;
    keyStore?: ReacharoundKeyStore;
  } = {},
) {
  const calls: Call[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      redirect: init?.redirect,
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
    reacharound: { url: RA, keyStore: options.keyStore ?? memoryKeyStore(KEY) },
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

test("GET /threads/:id forwards the id and returns the detail", async () => {
  const detail = { thread: { id: T1, customerEmail: "fan@gmail.com" }, customer: null, messages: [] };
  const { handler, calls } = setup({ respond: () => Response.json(detail) });
  const res = await handler(new Request(`${BASE}/threads/${T1}`));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), detail);
  assert.equal(calls[0]!.url, `${UPSTREAM}/threads/${T1}`);
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
  const body = (await (await handler(new Request(`${BASE}/threads/${T1}`))).json()) as Record<string, unknown>;
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
  const res = await handler(new Request(`${BASE}/threads/${T1}`));
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as Record<string, unknown>).customer, null);
});

test("POST reply/read/status forward the body plus the acting admin", async () => {
  const { handler, calls } = setup();
  const attempt = "2b0c7d43-5d3f-4c87-9a8e-1f1f4c1d2e3f";
  await handler(postJson(`${BASE}/threads/${T1}/reply`, { text: "On its way", replyAttemptId: attempt }));
  await handler(postJson(`${BASE}/threads/${T1}/read`, { read: true }));
  await handler(postJson(`${BASE}/threads/${T1}/status`, { status: "closed" }));

  assert.deepEqual(
    calls.map((c) => [c.method, c.url]),
    [
      ["POST", `${UPSTREAM}/threads/${T1}/reply`],
      ["POST", `${UPSTREAM}/threads/${T1}/read`],
      ["POST", `${UPSTREAM}/threads/${T1}/status`],
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
    postJson(`${BASE}/threads/${T1}/reply`, {
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
  await handler(postJson(`${BASE}/threads/${T1}/read`, { read: false }));
  assert.deepEqual((calls[0]!.body as Record<string, unknown>).actor, { email: "ops@betterfans.link" });
});

test("GET /attachments/:id/url forwards and returns the signed link", async () => {
  const link = { url: "https://r.example/a", filename: "a.pdf", contentType: null, expiresAt: null };
  const { handler, calls } = setup({ respond: () => Response.json(link) });
  const res = await handler(new Request(`${BASE}/attachments/${A1}/url`));
  assert.deepEqual(await res.json(), link);
  assert.equal(calls[0]!.url, `${UPSTREAM}/attachments/${A1}/url`);
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
    `${BASE}/threads/${T1}/delete`,
    `${BASE}/threads/%E0%A4%A/reply`,
  ]) {
    const res = await handler(url.endsWith("reply") ? postJson(url, {}) : new Request(url));
    assert.equal(res.status, 404, url);
  }
  assert.equal(calls.length, 0);
});

test("ids that could steer the upstream path (.., encoded /, non-uuid) are 404s, never forwarded", async () => {
  const { handler, calls } = setup();
  // (A lone `.` / `%2E` segment never arrives as an id: the URL parser collapses
  // it first, so `/threads/%2E` is simply `/threads` — the list.)
  for (const id of ["%2E%2E", "..%2F..%2Fdata", "abc", `${T1}%2F..`, "a%2Fb", `${T1}.`]) {
    assert.equal((await handler(new Request(`${BASE}/threads/${id}`))).status, 404, id);
    assert.equal((await handler(postJson(`${BASE}/threads/${id}/reply`, { text: "x" }))).status, 404, id);
    assert.equal((await handler(new Request(`${BASE}/attachments/${id}/url`))).status, 404, id);
  }
  assert.equal(calls.length, 0);
});

test("wrong methods are 405s", async () => {
  const { handler, calls } = setup();
  assert.equal((await handler(new Request(`${BASE}/threads/${T1}/reply`))).status, 405);
  assert.equal((await handler(postJson(`${BASE}/threads/unread-count`, {}))).status, 405);
  assert.equal((await handler(postJson(`${BASE}/threads/${T1}`, {}))).status, 405);
  assert.equal((await handler(new Request(`${BASE}/sync`))).status, 405);
  assert.equal(calls.length, 0);
});

test("a cross-origin write is refused (403) and not forwarded", async () => {
  const { handler, calls } = setup();
  const res = await handler(
    postJson(`${BASE}/threads/${T1}/reply`, { text: "hi" }, { origin: "https://evil.example" }),
  );
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("a same-origin write behind a host-rewriting proxy is allowed", async () => {
  const { handler, calls } = setup();
  const res = await handler(
    postJson(
      `http://internal:3000/api/admin/support/threads/${T1}/read`,
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
    new Request(`${BASE}/threads/${T1}/reply`, { method: "POST", body: "not json" }),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Invalid JSON body" });
  assert.equal(calls.length, 0);
});

test("an actor without an email is a loud 500 and nothing is sent", async () => {
  const { handler, calls } = setup({ overrides: { authorize: async () => ({ id: "a" }) } });
  const res = await handler(postJson(`${BASE}/threads/${T1}/reply`, { text: "hi", replyAttemptId: "x" }));
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
  [429, "This brand has started 100 new conversations in the last 24 hours, the most allowed. Try again later. Replies to existing conversations still work."],
  [500, "The reply WAS sent but couldn't be recorded."],
] as const) {
  test(`Reacharound's ${status} passes through with its message`, async () => {
    const { handler } = setup({ respond: () => Response.json({ error }, { status }) });
    const res = await handler(postJson(`${BASE}/threads/${T1}/reply`, { text: "hi", replyAttemptId: "x" }));
    assert.equal(res.status, status);
    assert.deepEqual(await res.json(), { error });
  });
}

for (const status of [502, 504]) {
  test(`Reacharound's own ${status} reaches the app as a 503 with its message, so no proxy can swap it`, async () => {
    const error = "Sending the reply failed: Resend API 500.";
    const { handler } = setup({ respond: () => Response.json({ error }, { status }) });
    const res = await handler(postJson(`${BASE}/threads/${T1}/reply`, { text: "hi", replyAttemptId: "x" }));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error });
  });
}

test("a refused inbox key (401) is a 409 that sends the admin to Settings, not 'logged out'", async () => {
  const { handler } = setup({
    respond: () => Response.json({ error: "invalid token" }, { status: 401 }),
  });
  const res = await handler(new Request(`${BASE}/threads`));
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string; code: string };
  assert.equal(body.code, "KEY_REFUSED");
  assert.match(body.error, /refused the saved inbox key/);
  assert.match(body.error, /Settings/);
});

test("Reacharound unreachable is a 503 worth retrying", async () => {
  const { handler } = setup({
    respond: () => {
      throw new TypeError("fetch failed");
    },
  });
  const res = await handler(new Request(`${BASE}/threads`));
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: string; code: string };
  assert.equal(body.code, "REACHAROUND_UNAVAILABLE");
  assert.match(body.error, /Could not reach Reacharound/);
});

test("Reacharound too slow: the router gives up at its timeout with a 503", async () => {
  const { handler } = setup({
    overrides: { timeoutMs: 25 },
    respond: () => new Promise<Response>(() => {}), // never answers
  });
  const started = Date.now();
  const res = await handler(new Request(`${BASE}/threads`));
  assert.equal(res.status, 503);
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
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as { error: string }).error, /took too long/);
});

test("no call follows redirects, so the key is never re-sent elsewhere", async () => {
  const { handler, calls } = setup({ respond: () => Response.json({ threads: [], nextCursor: null }) });
  await handler(new Request(`${BASE}/threads`));
  await handler(postJson(`${BASE}/threads/${T1}/reply`, { text: "hi", replyAttemptId: "x" }));
  assert.equal(calls.length, 2);
  // "manual", never "error": Cloudflare Workers throw on "error" before sending.
  for (const call of calls) assert.equal(call.redirect, "manual");
});

const redirectAway = () =>
  new Response(null, { status: 302, headers: { location: "https://elsewhere.example/api/inbox/threads" } });

test("a redirect from Reacharound is a 503, never passed on or followed", async () => {
  const { handler, calls } = setup({ respond: redirectAway });
  const res = await handler(new Request(`${BASE}/threads`));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("location"), null);
  assert.match(((await res.json()) as { error: string }).error, /Could not reach Reacharound/);
  assert.equal(calls.length, 1);
});

test("Settings won't save a key when Reacharound answers the check with a redirect", async () => {
  const keyStore = memoryKeyStore();
  const { handler } = setup({ respond: redirectAway, keyStore });
  const res = await handler(postJson(`${BASE}/connection`, { key: "rik_abcdefghijklmnop1234" }));
  assert.notEqual(res.status, 200);
  assert.equal(await keyStore.read(), null);
});

test("a network error from fetch is still a 503", async () => {
  const { handler } = setup({
    respond: () => {
      throw new TypeError("fetch failed");
    },
  });
  const res = await handler(new Request(`${BASE}/threads`));
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as { error: string }).error, /Could not reach Reacharound/);
});

for (const route of ["threads", "threads/unread-count"]) {
  test(`a 404 on GET /${route} means no inbox API at that address: a 503 that says so`, async () => {
    const { handler } = setup({ respond: () => Response.json({ error: "Not found" }, { status: 404 }) });
    const res = await handler(new Request(`${BASE}/${route}`));
    assert.equal(res.status, 503);
    assert.match(((await res.json()) as { error: string }).error, /didn't recognise this app's request/);
  });
}

test("a 404 on one thread is a real not-found and passes through", async () => {
  const { handler } = setup({
    respond: () => Response.json({ error: "Conversation not found." }, { status: 404 }),
  });
  const res = await handler(new Request(`${BASE}/threads/${T1}`));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Conversation not found." });
});

test("failure logs never carry the search text", async () => {
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    const { handler } = setup({
      respond: () => {
        throw new TypeError("fetch failed");
      },
    });
    await handler(new Request(`${BASE}/threads?q=customer%40example.com`));
    const { handler: notFound } = setup({
      respond: () => Response.json({ error: "Not found" }, { status: 404 }),
    });
    await notFound(new Request(`${BASE}/threads?q=customer%40example.com`));
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 2);
  const text = JSON.stringify(logged, (_k, v: unknown) => (v instanceof Error ? v.message : v));
  assert.doesNotMatch(text, /customer/);
  assert.match(text, /\/threads/);
});

test("a non-JSON answer (a proxy's HTML error page) is a 503", async () => {
  const { handler } = setup({
    respond: () => new Response("<html>Bad gateway</html>", { status: 503, headers: { "content-type": "text/html" } }),
  });
  const res = await handler(new Request(`${BASE}/threads`));
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as { error: string }).error, /unexpected answer/);
});

// --- configuration ----------------------------------------------------------

test("config: the address is Reacharound's own unless url says otherwise", () => {
  for (const url of [undefined, "", "  "]) {
    const c = normalizeReacharoundConfig({
      reacharound: { keyStore: memoryKeyStore(), url },
      authorize: async () => null,
    });
    assert.equal(c.inboxApiBase, "https://reacharound.xyz/api/inbox");
  }
  assert.equal(REACHAROUND_URL, "https://reacharound.xyz");
});

test("config: plain http is allowed only to this machine", () => {
  for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
    const c = normalizeReacharoundConfig({
      reacharound: { url, keyStore: memoryKeyStore() },
      authorize: async () => null,
    });
    assert.ok(c.inboxApiBase.startsWith(url));
  }
});

test("config: builds the inbox API base from a url, trailing slash or not", () => {
  const a = normalizeReacharoundConfig({
    reacharound: { url: `${RA}/`, keyStore: memoryKeyStore() },
    authorize: async () => null,
  });
  assert.equal(a.inboxApiBase, UPSTREAM);
  assert.equal(a.basePath, "/api/admin/support");
  assert.equal(a.timeoutMs, 15_000);
});

test("config: a bad url or a missing key store fails at creation", () => {
  const make = (reacharound: SupportInboxReacharoundConfig["reacharound"]) => () =>
    normalizeReacharoundConfig({ reacharound, authorize: async () => null });
  assert.throws(make({ url: "not a url", keyStore: memoryKeyStore() }), /not a URL/);
  assert.throws(make({ url: "ftp://ra.example", keyStore: memoryKeyStore() }), /must be https/);
  assert.throws(make({ url: "http://ra.example", keyStore: memoryKeyStore() }), /must be https/);
  assert.throws(make({} as SupportInboxReacharoundConfig["reacharound"]), /keyStore is missing/);
});

test("createSupportInbox in Reacharound mode needs no Resend key or webhook", async () => {
  const calls: string[] = [];
  const inbox = createSupportInbox({
    reacharound: { url: RA, keyStore: memoryKeyStore(KEY) },
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

// --- the saved key and Settings (2026-10-28) ------------------------------------

const NEW_KEY = `rik_${"N".repeat(32)}`;

test("no saved key: every Reacharound route is a 409 that points to Settings, and nothing is sent", async () => {
  const { handler, calls } = setup({ keyStore: memoryKeyStore() });
  for (const request of [
    new Request(`${BASE}/threads`),
    new Request(`${BASE}/threads/unread-count`),
    new Request(`${BASE}/threads/${T1}`),
    postJson(`${BASE}/threads/${T1}/reply`, { text: "hi", replyAttemptId: "x" }),
    new Request(`${BASE}/attachments/${A1}/url`),
  ]) {
    const res = await handler(request);
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; code: string };
    assert.equal(body.code, "NOT_CONNECTED");
    assert.match(body.error, /Settings/);
  }
  assert.equal(calls.length, 0);
});

test("a saved key that can't be opened (the secret changed) asks for it again, and sends nothing", async () => {
  const unreadable: ReacharoundKeyStore = {
    read: async () => ({ key: null, hint: "abcd", savedAt: new Date(), savedBy: "kai@example.com" }),
    write: async () => {
      throw new Error("not used");
    },
  };
  const { handler, calls } = setup({ keyStore: unreadable });
  const res = await handler(new Request(`${BASE}/threads`));
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, "KEY_UNREADABLE");
  assert.equal(calls.length, 0);
});

test("every request reads the key fresh, so a key saved in Settings is used at once", async () => {
  const store = memoryKeyStore(KEY);
  const { handler, calls } = setup({ keyStore: store, respond: () => Response.json({ count: 0 }) });
  await handler(new Request(`${BASE}/threads/unread-count`));
  await store.write({ key: NEW_KEY, savedBy: "kai@example.com" });
  await handler(new Request(`${BASE}/threads/unread-count`));
  assert.deepEqual(
    calls.map((call) => call.headers.get("authorization")),
    [`Bearer ${KEY}`, `Bearer ${NEW_KEY}`],
  );
});

test("GET /connection with no key: not connected, no key, and Reacharound is not asked", async () => {
  const { handler, calls } = setup({ keyStore: memoryKeyStore() });
  const res = await handler(new Request(`${BASE}/connection`));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { connected: false, problem: "no_key", key: null });
  assert.equal(calls.length, 0);
});

test("GET /connection checks the saved key with Reacharound and shows only its last four characters", async () => {
  const store = memoryKeyStore();
  await store.write({ key: NEW_KEY, savedBy: "kai@example.com" });
  const { handler, calls } = setup({ keyStore: store, respond: () => Response.json({ count: 3 }) });
  const res = await handler(new Request(`${BASE}/connection`));
  const text = await res.text();
  assert.ok(!text.includes(NEW_KEY), "the key must never reach the browser");
  const body = JSON.parse(text) as ConnectionResponse;
  assert.equal(body.connected, true);
  assert.equal(body.problem, null);
  assert.equal(body.key?.hint, "NNNN");
  assert.equal(body.key?.savedBy, "kai@example.com");
  assert.deepEqual(
    calls.map((call) => [call.url, call.headers.get("authorization")]),
    [[`${UPSTREAM}/threads/unread-count`, `Bearer ${NEW_KEY}`]],
  );
});

test("GET /connection with a key Reacharound refuses says so: it was replaced there", async () => {
  const { handler } = setup({
    respond: () => Response.json({ error: "invalid token" }, { status: 401 }),
  });
  const body = (await (await handler(new Request(`${BASE}/connection`))).json()) as ConnectionResponse;
  assert.equal(body.connected, false);
  assert.equal(body.problem, "key_refused");
  assert.equal(body.key?.hint, KEY.slice(-4));
});

test("GET /connection when Reacharound can't be reached: unreachable, not refused", async () => {
  const { handler } = setup({
    respond: () => {
      throw new TypeError("fetch failed");
    },
  });
  const body = (await (await handler(new Request(`${BASE}/connection`))).json()) as ConnectionResponse;
  assert.equal(body.problem, "unreachable");
});

test("POST /connection saves a key Reacharound takes, trimmed, records who saved it, and never returns it", async () => {
  const store = memoryKeyStore();
  const { handler, calls } = setup({ keyStore: store, respond: () => Response.json({ count: 0 }) });
  const res = await handler(postJson(`${BASE}/connection`, { key: `  ${NEW_KEY}\n` }));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(NEW_KEY), "the key must never reach the browser");
  const body = JSON.parse(text) as ConnectionResponse;
  assert.equal(body.connected, true);
  assert.equal(body.key?.savedBy, "jane@betterfans.link");
  assert.equal((await store.read())?.key, NEW_KEY);
  assert.deepEqual(calls.map((call) => call.headers.get("authorization")), [`Bearer ${NEW_KEY}`]);
});

test("POST /connection refuses what isn't an inbox key, without asking Reacharound or repeating it", async () => {
  const store = memoryKeyStore(KEY);
  const { handler, calls } = setup({ keyStore: store });
  for (const key of [
    "",
    "re_a_resend_key_1234567890",
    "REACHAROUND_INBOX_KEY=rik_abcdefghijklmnopqrstuvwxyz",
    '"rik_abcdefghijklmnopqrstuvwxyz"',
    "rik_abcdefghij klmnopqrstuvwxyz",
    "rik_short",
    42,
  ]) {
    const res = await handler(postJson(`${BASE}/connection`, { key }));
    assert.equal(res.status, 400);
    const text = await res.text();
    if (typeof key === "string" && key) assert.ok(!text.includes(key), "the error must not repeat the key");
  }
  assert.equal(calls.length, 0);
  assert.equal((await store.read())?.key, KEY, "the saved key is untouched");
});

test("POST /connection refuses a key Reacharound doesn't know, and keeps the one that was there", async () => {
  const store = memoryKeyStore(KEY);
  const { handler } = setup({
    keyStore: store,
    respond: () => Response.json({ error: "invalid token" }, { status: 401 }),
  });
  const res = await handler(postJson(`${BASE}/connection`, { key: NEW_KEY }));
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /doesn't know this key/);
  assert.equal((await store.read())?.key, KEY);
});

test("POST /connection when Reacharound can't check the key saves nothing (503)", async () => {
  const store = memoryKeyStore();
  const { handler } = setup({
    keyStore: store,
    respond: () => {
      throw new TypeError("fetch failed");
    },
  });
  const res = await handler(postJson(`${BASE}/connection`, { key: NEW_KEY }));
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as { code: string }).code, "REACHAROUND_UNAVAILABLE");
  assert.equal(await store.read(), null);
});

test("Settings has the same gate as every route: authorize null is a 404, a cross-origin save a 403", async () => {
  const store = memoryKeyStore();
  const denied = setup({ keyStore: store, overrides: { authorize: async () => null } });
  assert.equal((await denied.handler(new Request(`${BASE}/connection`))).status, 404);
  assert.equal((await denied.handler(postJson(`${BASE}/connection`, { key: NEW_KEY }))).status, 404);
  const { handler, calls } = setup({ keyStore: store });
  const res = await handler(
    postJson(`${BASE}/connection`, { key: NEW_KEY }, { origin: "https://evil.example" }),
  );
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
  assert.equal(await store.read(), null);
});
