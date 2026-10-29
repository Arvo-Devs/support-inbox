import type {
  ResolvedReacharoundConfig,
  SupportInboxActor,
  SupportInboxCustomerLink,
} from "../config";
import type { SyncResponse } from "../shared/types";
import {
  crossOriginRejection,
  methodNotAllowed,
  notFound,
  readJsonObject,
  routeSegments,
  safeDecode,
} from "./http";

// Reacharound mode (PRO-5000): the same routes the self-hosted router serves,
// answered by forwarding to Reacharound's inbox API with this project's inbox
// key. The app keeps no support data: Reacharound receives, threads, stores
// and sends, and its own Inbox shows the same conversations in step.
//
// What stays HERE, in the app, on purpose:
//  - `authorize` — the app decides who its admins are; Reacharound only learns
//    which app is asking (from the key) and who is acting (from us).
//  - the same-origin check and JSON parsing — the browser talks only to the
//    app, so the app is the CSRF boundary.
//  - the inbox key — it never leaves this server, and nothing from the
//    browser's request (cookies, headers) is forwarded upstream.
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
   * the one-key routes. That is this app's configuration, like a refused key.
   * A thread or attachment 404 is a real "not found" and passes through.
   */
  notFoundIsConfig?: boolean;
};

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
   * One call to Reacharound, answered as the screens expect. Reacharound's own
   * statuses and `{ error }` bodies pass through unchanged (404, 409, 410,
   * 422, 502 …) — they already describe the problem in the screens' terms.
   * Four cases do not, and become a 502 with a message for the admin:
   *  - 401: the inbox key was refused (revoked, rotated, or never set). That is
   *    this app's configuration, not the admin's request, and passing a 401 to
   *    a signed-in admin would read as "you are logged out".
   *  - 404 on the list or the count: no inbox API at that address (see
   *    `notFoundIsConfig`), which a bare "Not found" would hide.
   *  - Reacharound unreachable or too slow (network error / timeout), or
   *    answering with a redirect: the key is never re-sent to wherever a
   *    redirect points, so a moved or mistyped URL fails here instead.
   *  - an answer that is not JSON (an HTML error page from a proxy, say).
   */
  async function forward(upstream: Upstream): Promise<Response> {
    let res: Response;
    try {
      res = await config.fetch(`${config.inboxApiBase}${upstream.path}`, {
        method: upstream.method,
        headers: {
          authorization: `Bearer ${config.key}`,
          accept: "application/json",
          ...(upstream.body ? { "content-type": "application/json" } : {}),
        },
        body: upstream.body ? JSON.stringify(upstream.body) : undefined,
        signal: AbortSignal.timeout(config.timeoutMs),
        cache: "no-store",
        redirect: "error",
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      console.error("[support-inbox] Reacharound request failed", {
        path: loggedPath(upstream.path),
        timedOut,
        error,
      });
      return Response.json(
        {
          error: timedOut
            ? "Reacharound took too long to answer. Try again in a moment."
            : "Could not reach Reacharound. Try again in a moment.",
        },
        { status: 502 },
      );
    }

    if (res.status === 401) {
      console.error("[support-inbox] Reacharound refused the inbox key", {
        path: loggedPath(upstream.path),
      });
      return Response.json(
        {
          error:
            "The support inbox isn't connected: Reacharound refused this app's inbox key. Ask an admin to check the key.",
        },
        { status: 502 },
      );
    }

    if (res.status === 404 && upstream.notFoundIsConfig) {
      console.error("[support-inbox] Reacharound has no inbox API at this address", {
        path: loggedPath(upstream.path),
      });
      return Response.json(
        {
          error:
            "The support inbox isn't connected: Reacharound didn't recognise this app's request. Ask the app's developer to check the support inbox setup.",
        },
        { status: 502 },
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
      return Response.json(
        { error: "Reacharound sent an unexpected answer. Try again in a moment." },
        { status: 502 },
      );
    }
    return Response.json(payload, { status: res.status });
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
            { error: "The support inbox is misconfigured: the signed-in admin has no email address." },
            { status: 500 },
          );
        }
        return { ...body, actor: payload };
      };

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
