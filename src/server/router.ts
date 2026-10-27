import type { ResolvedSupportInboxConfig } from "../config";
import type { ResendApi } from "./resend-api";
import {
  crossOriginRejection,
  methodNotAllowed,
  notFound,
  readJsonObject,
  routeSegments,
  safeDecode,
} from "./http";
import { compose, reply, setRead, setStatus } from "./routes/actions";
import { attachmentUrl } from "./routes/attachments";
import { sync } from "./routes/sync";
import { listThreads, threadDetail, unreadCount } from "./routes/threads";
import type { SupportStore } from "./store";

export type RouterDeps = { store: SupportStore; resendApi: ResendApi };

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
      const segments = routeSegments(url, config.basePath);
      if (segments === null) return notFound();

      let body: Record<string, unknown> = {};
      if (req.method !== "GET") {
        const rejected = crossOriginRejection(req, url);
        if (rejected) return rejected;
        const parsed = await readJsonObject(req);
        if (!parsed.ok) return parsed.response;
        body = parsed.body;
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
