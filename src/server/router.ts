import type { ResolvedSupportInboxConfig } from "../config";
import type { ResendApi } from "./resend-api";
import { compose, reply, setRead, setStatus } from "./routes/actions";
import { attachmentUrl } from "./routes/attachments";
import { sync } from "./routes/sync";
import { listThreads, threadDetail, unreadCount } from "./routes/threads";
import type { SupportStore } from "./store";

export type RouterDeps = { store: SupportStore; resendApi: ResendApi };

// Unauthorized must be byte-identical to an unknown route so probing can't
// distinguish "exists but forbidden" from "does not exist" (the
// adminProcedure NOT_FOUND convention).
const notFound = () => new Response("Not found", { status: 404 });

function methodNotAllowed(): Response {
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

/** decodeURIComponent that treats malformed percent-encoding as a miss. */
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function createRouter(
  config: ResolvedSupportInboxConfig,
  deps: RouterDeps,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    let path = req.url;
    try {
      const actor = await config.authorize(req);
      if (!actor) return notFound();

      // Parse from the URL pathname ONLY — never framework params.
      const url = new URL(req.url);
      path = url.pathname;
      const { basePath } = config;
      if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
        return notFound();
      }
      const subPath = url.pathname.slice(basePath.length).replace(/\/+$/, "");
      const segments = subPath === "" ? [] : subPath.slice(1).split("/");
      if (segments.some((segment) => segment.length === 0)) return notFound();

      let body: Record<string, unknown> = {};
      if (req.method !== "GET") {
        // Same-origin check: an Origin header, when present, must match.
        // Behind a Host-rewriting reverse proxy req.url carries the internal
        // host, so prefer the proxy-provided X-Forwarded-Host (first value)
        // — the same header Next.js trusts for its own origin checks.
        const origin = req.headers.get("origin");
        if (origin !== null) {
          const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
          const expectedHost = forwardedHost || url.host;
          let originHost: string | null = null;
          try {
            originHost = new URL(origin).host;
          } catch {
            originHost = null;
          }
          if (originHost === null || originHost !== expectedHost) {
            return Response.json({ error: "Cross-origin request rejected" }, { status: 403 });
          }
        }
        let parsed: unknown;
        try {
          parsed = await req.json();
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        body = parsed as Record<string, unknown>;
      }

      const method = req.method;

      if (segments.length === 1 && segments[0] === "threads") {
        if (method === "GET") return await listThreads(deps, config, url);
        if (method === "POST") return await compose(deps, config, actor, body);
        return methodNotAllowed();
      }

      // unread-count must match before the :id route.
      if (segments.length === 2 && segments[0] === "threads" && segments[1] === "unread-count") {
        if (method === "GET") return await unreadCount(deps);
        return methodNotAllowed();
      }

      if (segments.length === 2 && segments[0] === "threads") {
        const threadId = safeDecode(segments[1] ?? "");
        if (threadId === null) return notFound();
        if (method === "GET") return await threadDetail(deps, config, threadId);
        return methodNotAllowed();
      }

      if (segments.length === 3 && segments[0] === "threads") {
        const action = segments[2];
        if (action !== "reply" && action !== "read" && action !== "status") return notFound();
        const threadId = safeDecode(segments[1] ?? "");
        if (threadId === null) return notFound();
        if (method !== "POST") return methodNotAllowed();
        if (action === "reply") return await reply(deps, config, actor, threadId, body);
        if (action === "read") return await setRead(deps, threadId, body);
        return await setStatus(deps, threadId, body);
      }

      if (segments.length === 1 && segments[0] === "sync") {
        if (method === "POST") return await sync(deps, config);
        return methodNotAllowed();
      }

      if (segments.length === 3 && segments[0] === "attachments" && segments[2] === "url") {
        const attachmentId = safeDecode(segments[1] ?? "");
        if (attachmentId === null) return notFound();
        if (method === "GET") return await attachmentUrl(deps, attachmentId);
        return methodNotAllowed();
      }

      return notFound();
    } catch (error) {
      console.error("[support-inbox] request failed", { path, error });
      return Response.json({ error: "Internal error" }, { status: 500 });
    }
  };
}
