import type {
  ResolvedReacharoundConfig,
  SupportInboxActor,
  SupportInboxCustomerLink,
} from "../config";
import { isInboxKey } from "../config";
import type { ConnectionProblem, ConnectionResponse, SyncResponse } from "../shared/types";
import {
  crossOriginRejection,
  methodNotAllowed,
  notFound,
  readJsonObject,
  routeSegments,
  safeDecode,
} from "./http";
import type { ReacharoundSavedKey } from "./key-store";

// Reacharound mode (PRO-5000): the same routes the self-hosted router serves,
// answered by forwarding to Reacharound's inbox API with the brand's inbox
// key. The app keeps no support mail: Reacharound receives, threads, stores
// and sends, and its own Inbox shows the same conversations in step.
//
// What stays HERE, in the app, on purpose:
//  - `authorize` — the app decides who its admins are; Reacharound only learns
//    which app is asking (from the key) and who is acting (from us).
//  - the same-origin check and JSON parsing — the browser talks only to the
//    app, so the app is the CSRF boundary.
//  - the inbox key — an admin saves it on the Email page's Settings
//    (`/connection`), the app keeps it encrypted in its own database
//    (`keyStore`), and it never leaves this server: the browser sees its last
//    four characters at most, and nothing from the browser's request
//    (cookies, headers) is forwarded upstream.
//
// The wire shapes are identical in both modes, so the screens cannot tell the
// difference; Reacharound speaks the package's `shared/types.ts` contract
// (CWRAP-Inbox-API in Arvo-Devs/Reacharound-Emails).

/**
 * Reacharound's thread and attachment ids are uuids. Anything else in that
 * path position — `..`, an encoded `/`, a dot — is refused here as a plain 404
 * rather than placed into the upstream URL, where `..` would be resolved
 * against Reacharound's path and could point the inbox key at a different
 * endpoint than the route the admin called.
 */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pathId(segment: string | undefined): string | null {
  const decoded = safeDecode(segment ?? "");
  return decoded !== null && ID_PATTERN.test(decoded) ? decoded : null;
}

/** The query parameters the list route accepts — nothing else is forwarded. */
const LIST_PARAMS = ["status", "q", "cursor", "limit"] as const;

const READ_WRITE_ACTIONS = new Set(["reply", "read", "status"]);

/** Sync is Reacharound's job (webhook + poll); the button is hidden in this mode. */
const NOTHING_TO_SYNC: SyncResponse = { scanned: 0, imported: 0, skipped: 0, failed: 0 };

type Upstream = {
  method: "GET" | "POST";
  /** Path under `{url}/api/inbox`, already encoded. */
  path: string;
  body?: Record<string, unknown>;
  /**
   * The list and the unread count can only 404 when there is no inbox API at
   * the address: a `url` pointing somewhere else, or a Reacharound older than
   * the one-key routes. That is this app's configuration, not a missing
   * conversation. A thread or attachment 404 is a real "not found" and passes
   * through.
   */
  notFoundIsConfig?: boolean;
};

/**
 * Why this app can't use Reacharound right now, sent as `code` beside the
 * `{ error }`. The first three are fixed in Settings, so the page shows its
 * Connect panel for them instead of an error (client/api.ts `needsSettings`);
 * the last one is worth a retry.
 *
 * Never a 502 or 504: a proxy in front of the app can swap those for its own
 * error page. That is how BetterFans Link's admins saw a bare "Request failed
 * (502)" instead of "Reacharound refused this app's inbox key" (2026-10-28).
 * The Settings fixes answer 409 (client errors pass through proxies untouched)
 * and the retries 503.
 */
type SettingsFix = "NOT_CONNECTED" | "KEY_UNREADABLE" | "KEY_REFUSED";

const SETTINGS_FIXES: Record<SettingsFix, string> = {
  NOT_CONNECTED:
    "Email isn't connected to Reacharound yet. An admin can add the brand's inbox key in Settings.",
  KEY_UNREADABLE:
    "The saved inbox key can't be read: the app's secret changed since it was saved. Add the key again in Settings.",
  KEY_REFUSED:
    "Reacharound refused the saved inbox key. It was probably replaced in Reacharound: add the new one in Settings.",
};

function needsSettings(code: SettingsFix): Response {
  return Response.json({ error: SETTINGS_FIXES[code], code }, { status: 409 });
}

function reacharoundUnavailable(error: string): Response {
  return Response.json({ error, code: "REACHAROUND_UNAVAILABLE" }, { status: 503 });
}

/**
 * The path as logged: without its query, which carries the admin's search
 * text (`q`) — customer names and email addresses, more often than not.
 */
function loggedPath(path: string): string {
  const q = path.indexOf("?");
  return q === -1 ? path : path.slice(0, q);
}

export function createReacharoundRouter(
  config: ResolvedReacharoundConfig,
): (req: Request) => Promise<Response> {
  /**
   * One request to Reacharound with `key`. Redirects are never followed, so
   * the key is never re-sent to wherever one points, and nothing is cached.
   * Throws on a network error, the timeout or a redirect; the callers put
   * that into words.
   *
   * `redirect: "manual"` plus the status check, not `redirect: "error"`:
   * Cloudflare Workers throw on "error" before sending anything, so every
   * call from an app hosted there failed as "couldn't reach Reacharound"
   * (OFManager, 2026-10-29).
   */
  async function call(
    path: string,
    key: string,
    init: { method: "GET" | "POST"; body?: Record<string, unknown> },
  ): Promise<Response> {
    const res = await config.fetch(`${config.inboxApiBase}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(config.timeoutMs),
      cache: "no-store",
      redirect: "manual",
    });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      throw new TypeError(`Reacharound answered with a redirect (${res.status}), which is never followed`);
    }
    return res;
  }

  /** The saved key, or the 409 that sends the admin to Settings. */
  async function savedKey(): Promise<string | Response> {
    const saved = await config.keyStore.read();
    if (!saved) return needsSettings("NOT_CONNECTED");
    if (saved.key === null) return needsSettings("KEY_UNREADABLE");
    return saved.key;
  }

  /**
   * One call to Reacharound, answered as the screens expect. Reacharound's own
   * statuses and `{ error }` bodies pass through (404, 409, 410, 422, 429 …),
   * except a 502 or 504, which becomes a 503 with the same body so no proxy in
   * front of the app can swap it for its own page. These do not pass through:
   *  - no saved key, or one that can't be opened: a 409, and nothing is sent.
   *  - 401: Reacharound refused the saved key (replaced or revoked there, or
   *    its brand archived). A 409 that sends the admin to Settings: passing a
   *    401 to a signed-in admin would read as "you are logged out".
   *  - 404 on the list or the count: no inbox API at that address (see
   *    `notFoundIsConfig`), which a bare "Not found" would hide.
   *  - Reacharound unreachable or too slow (network error / timeout),
   *    answering with a redirect, or with something that is not JSON (an HTML
   *    error page from a proxy, say): a 503.
   */
  async function forward(upstream: Upstream): Promise<Response> {
    const key = await savedKey();
    if (key instanceof Response) return key;

    let res: Response;
    try {
      res = await call(upstream.path, key, upstream);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      console.error("[support-inbox] Reacharound request failed", {
        path: loggedPath(upstream.path),
        timedOut,
        error,
      });
      return reacharoundUnavailable(
        timedOut
          ? "Reacharound took too long to answer. Try again in a moment."
          : "Could not reach Reacharound. Try again in a moment.",
      );
    }

    if (res.status === 401) {
      console.error("[support-inbox] Reacharound refused the inbox key", {
        path: loggedPath(upstream.path),
      });
      return needsSettings("KEY_REFUSED");
    }

    if (res.status === 404 && upstream.notFoundIsConfig) {
      console.error("[support-inbox] Reacharound has no inbox API at this address", {
        path: loggedPath(upstream.path),
      });
      return reacharoundUnavailable(
        "Reacharound didn't recognise this app's request. Ask the app's developer to check the Email setup.",
      );
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      console.error("[support-inbox] Reacharound answered with non-JSON", {
        path: loggedPath(upstream.path),
        status: res.status,
      });
      return reacharoundUnavailable("Reacharound sent an unexpected answer. Try again in a moment.");
    }
    const status = res.status === 502 || res.status === 504 ? 503 : res.status;
    return Response.json(payload, { status });
  }

  /**
   * Whether Reacharound takes `key`: null when it does. Asks for the unread
   * count, the cheapest read there is, which only answers 200 to a key it
   * knows. Never logs the key.
   */
  async function checkKey(key: string): Promise<null | "key_refused" | "unreachable"> {
    let res: Response;
    try {
      res = await call("/threads/unread-count", key, { method: "GET" });
    } catch (error) {
      console.error("[support-inbox] could not check the inbox key with Reacharound", {
        timedOut: error instanceof Error && error.name === "TimeoutError",
        error,
      });
      return "unreachable";
    }
    if (res.status === 401) return "key_refused";
    if (!res.ok) {
      console.error("[support-inbox] Reacharound answered the key check with", { status: res.status });
      return "unreachable";
    }
    return null;
  }

  function connection(saved: ReacharoundSavedKey | null, problem: ConnectionProblem | null): Response {
    const body: ConnectionResponse = {
      connected: problem === null,
      problem,
      key: saved
        ? { hint: saved.hint, savedAt: saved.savedAt.toISOString(), savedBy: saved.savedBy }
        : null,
    };
    return Response.json(body);
  }

  /** GET /connection — what Settings shows: is a key saved, and does Reacharound take it. */
  async function connectionStatus(): Promise<Response> {
    const saved = await config.keyStore.read();
    if (!saved) return connection(null, "no_key");
    if (saved.key === null) return connection(saved, "key_unreadable");
    return connection(saved, await checkKey(saved.key));
  }

  /**
   * POST /connection `{ key }` — Settings saving the brand's inbox key.
   * Reacharound checks it first, so a mistyped or old key is refused here
   * rather than saved and failing on every page load. Saving replaces
   * whatever key was there, and the next request uses it.
   */
  async function saveKey(body: Record<string, unknown>, actor: SupportInboxActor): Promise<Response> {
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!key) return Response.json({ error: "Paste the brand's inbox key first." }, { status: 400 });
    if (!isInboxKey(key)) {
      return Response.json(
        {
          error:
            "That isn't a Reacharound inbox key. Inbox keys start with rik_ and have no spaces or quotes.",
        },
        { status: 400 },
      );
    }
    const problem = await checkKey(key);
    if (problem === "key_refused") {
      return Response.json(
        {
          error:
            "Reacharound doesn't know this key. Copy it again, or get a new one in Reacharound: Today › Inbox › Connect an app.",
        },
        { status: 400 },
      );
    }
    if (problem === "unreachable") {
      return reacharoundUnavailable(
        "Couldn't reach Reacharound to check the key, so it wasn't saved. Try again in a moment.",
      );
    }
    const savedBy = actor.email?.trim() || actor.id;
    const saved = await config.keyStore.write({ key, savedBy });
    console.info("[support-inbox] inbox key saved in Settings", { savedBy });
    return connection(saved, null);
  }

  /** The acting admin, as Reacharound requires it on every write. */
  function actorPayload(actor: SupportInboxActor): { email: string; name?: string } | null {
    const email = actor.email?.trim();
    if (!email) return null;
    const name = actor.name?.trim();
    return name ? { email, name } : { email };
  }

  async function withCustomer(res: Response): Promise<Response> {
    if (!res.ok || !config.lookupCustomer) return res;
    const body = (await res.json()) as { thread?: { customerEmail?: string } } & Record<
      string,
      unknown
    >;
    // A customer-lookup failure must never break the thread view.
    let customer: SupportInboxCustomerLink | null = null;
    const email = body.thread?.customerEmail;
    if (email) {
      try {
        customer = await config.lookupCustomer(email);
      } catch {
        customer = null;
      }
    }
    return Response.json({ ...body, customer }, { status: res.status });
  }

  return async (req: Request): Promise<Response> => {
    // Pathname only: the query can carry the admin's search text.
    let path = new URL(req.url).pathname;
    try {
      const actor = await config.authorize(req);
      if (!actor) return notFound();

      const url = new URL(req.url);
      path = url.pathname;
      const segments = routeSegments(url, config.basePath);
      if (segments === null) return notFound();

      const method = req.method;
      let body: Record<string, unknown> = {};
      if (method === "POST") {
        const rejected = crossOriginRejection(req, url);
        if (rejected) return rejected;
        const parsed = await readJsonObject(req);
        if (!parsed.ok) return parsed.response;
        body = parsed.body;
      }

      /**
       * Every write carries the acting admin. Set here from `authorize`,
       * overwriting anything the browser put in the body under `actor`: the
       * browser must not be able to send a reply as someone else.
       */
      const write = (): Record<string, unknown> | Response => {
        const payload = actorPayload(actor);
        if (!payload) {
          console.error(
            "[support-inbox] authorize returned an actor without an email; Reacharound mode needs one",
          );
          return Response.json(
            { error: "Email is misconfigured: the signed-in admin has no email address." },
            { status: 500 },
          );
        }
        return { ...body, actor: payload };
      };

      // Settings: the brand's inbox key. Same gate as every other route.
      if (segments.length === 1 && segments[0] === "connection") {
        if (method === "GET") return await connectionStatus();
        if (method === "POST") return await saveKey(body, actor);
        return methodNotAllowed();
      }

      if (segments.length === 1 && segments[0] === "threads") {
        if (method === "GET") {
          const query = new URLSearchParams();
          for (const name of LIST_PARAMS) {
            const value = url.searchParams.get(name);
            if (value !== null) query.set(name, value);
          }
          const qs = query.toString();
          return await forward({
            method: "GET",
            path: `/threads${qs ? `?${qs}` : ""}`,
            notFoundIsConfig: true,
          });
        }
        if (method === "POST") {
          const payload = write();
          if (payload instanceof Response) return payload;
          return await forward({ method: "POST", path: "/threads", body: payload });
        }
        return methodNotAllowed();
      }

      // unread-count must match before the :id route.
      if (segments.length === 2 && segments[0] === "threads" && segments[1] === "unread-count") {
        if (method === "GET") {
          return await forward({
            method: "GET",
            path: "/threads/unread-count",
            notFoundIsConfig: true,
          });
        }
        return methodNotAllowed();
      }

      if (segments.length === 2 && segments[0] === "threads") {
        const threadId = pathId(segments[1]);
        if (threadId === null) return notFound();
        if (method === "GET") {
          return await withCustomer(
            await forward({ method: "GET", path: `/threads/${encodeURIComponent(threadId)}` }),
          );
        }
        return methodNotAllowed();
      }

      if (segments.length === 3 && segments[0] === "threads") {
        const action = segments[2] ?? "";
        if (!READ_WRITE_ACTIONS.has(action)) return notFound();
        const threadId = pathId(segments[1]);
        if (threadId === null) return notFound();
        if (method !== "POST") return methodNotAllowed();
        const payload = write();
        if (payload instanceof Response) return payload;
        return await forward({
          method: "POST",
          path: `/threads/${encodeURIComponent(threadId)}/${action}`,
          body: payload,
        });
      }

      // Kept answering so a host that still renders the Sync button gets a
      // harmless "up to date" rather than an error: Reacharound catches up
      // on its own (webhook + its 10-minute poll).
      if (segments.length === 1 && segments[0] === "sync") {
        if (method === "POST") return Response.json(NOTHING_TO_SYNC);
        return methodNotAllowed();
      }

      if (segments.length === 3 && segments[0] === "attachments" && segments[2] === "url") {
        const attachmentId = pathId(segments[1]);
        if (attachmentId === null) return notFound();
        if (method === "GET") {
          return await forward({
            method: "GET",
            path: `/attachments/${encodeURIComponent(attachmentId)}/url`,
          });
        }
        return methodNotAllowed();
      }

      return notFound();
    } catch (error) {
      console.error("[support-inbox] request failed", { path, error });
      return Response.json({ error: "Internal error" }, { status: 500 });
    }
  };
}
