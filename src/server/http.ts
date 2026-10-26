// Request plumbing shared by both routers — the self-hosted one (router.ts)
// and the Reacharound pass-through (reacharound.ts). Same parsing, same
// origin rule, same 404/405 answers, so the two modes can't drift on what a
// request is allowed to look like before it reaches either.

// Unauthorized must be byte-identical to an unknown route so probing can't
// distinguish "exists but forbidden" from "does not exist" (the
// adminProcedure NOT_FOUND convention).
export const notFound = () => new Response("Not found", { status: 404 });

export function methodNotAllowed(): Response {
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

/** decodeURIComponent that treats malformed percent-encoding as a miss. */
export function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * The path segments under `basePath`, parsed from the URL pathname ONLY —
 * never framework params. Null when the path is outside the mount or has an
 * empty segment (`//`).
 */
export function routeSegments(url: URL, basePath: string): string[] | null {
  if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return null;
  const subPath = url.pathname.slice(basePath.length).replace(/\/+$/, "");
  const segments = subPath === "" ? [] : subPath.slice(1).split("/");
  if (segments.some((segment) => segment.length === 0)) return null;
  return segments;
}

/**
 * Same-origin check for a state-changing request: an Origin header, when
 * present, must match. Behind a Host-rewriting reverse proxy req.url carries
 * the internal host, so prefer the proxy-provided X-Forwarded-Host (first
 * value) — the same header Next.js trusts for its own origin checks. Returns
 * the 403 to send, or null when the request may proceed.
 */
export function crossOriginRejection(req: Request, url: URL): Response | null {
  const origin = req.headers.get("origin");
  if (origin === null) return null;
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
  return null;
}

/** A JSON-object request body, or the 400 to send. */
export async function readJsonObject(
  req: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return { ok: false, response: Response.json({ error: "Invalid JSON body" }, { status: 400 }) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, response: Response.json({ error: "Invalid JSON body" }, { status: 400 }) };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}
