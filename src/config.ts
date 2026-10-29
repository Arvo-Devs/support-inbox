import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { parseAddress } from "./server/recipients";

/**
 * Minimal drizzle handle the package needs: any postgres drizzle instance with
 * select/insert/update/execute/transaction satisfies it. Hosts pass their
 * root/admin handle (e.g. getAdminDb()) — the package never constructs its own
 * connection and never touches the host's RLS/txStore machinery.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SupportInboxDb = PgDatabase<PgQueryResultHKT, any, any>;

export type SupportInboxActor = {
  id: string;
  email?: string;
  name?: string;
};

export type SupportInboxCustomerLink = { label: string; href: string };

export type SupportInboxConfig = {
  /** Drizzle handle with `.transaction` (root handle, not a nested tx). */
  db: SupportInboxDb;
  /**
   * MUST be a full-access Resend key: sending-only keys cannot read inbound
   * mail. Keep server-only; prefer a dedicated per-app key so rotation is
   * isolated.
   */
  resendApiKey: string;
  /** Outbound sender, e.g. `Acme Support <support@example.com>`. */
  fromEmail: string;
  /**
   * Public addresses that create tickets, matched (lowercased) against
   * to/cc/received_for. Undefined = accept all inbound mail.
   */
  inboundAddresses?: string[];
  /**
   * Managed alias -> public address (e.g. `support@<id>.resend.app` ->
   * `support@example.com`). Makes Gmail-forwarding routing deterministic;
   * matched aliases store the mapped public address as inbound_address.
   */
  aliasMap?: Record<string, string>;
  /** whsec_ secret for the resend-inbound endpoint (its OWN secret). */
  webhookSecret: string;
  /**
   * Returns the acting admin or null. Null renders a bare 404 identical to an
   * unknown route (adminProcedure NOT_FOUND convention). Returning an actor
   * (not a boolean) lets replies store actor_id + a denormalized actor_label
   * without joining the host's user table.
   */
  authorize: (req: Request) => Promise<SupportInboxActor | null>;
  /** Optional customer lookup rendered in the thread detail view. */
  lookupCustomer?: (email: string) => Promise<SupportInboxCustomerLink | null>;
  /** Mount point of the route handlers. Default: /api/admin/support */
  basePath?: string;
};

export type ResolvedSupportInboxConfig = {
  db: SupportInboxDb;
  resendApiKey: string;
  fromEmail: string;
  /** Parsed (lowercased) address part of fromEmail, validated at creation. */
  fromAddress: string;
  /** Display-name part of fromEmail, when present. */
  fromName: string | null;
  /** Domain part of fromAddress; used for synthesized Message-IDs. */
  fromDomain: string;
  inboundAddresses: string[] | null;
  aliasMap: Record<string, string>;
  webhookSecret: string;
  authorize: (req: Request) => Promise<SupportInboxActor | null>;
  lookupCustomer: ((email: string) => Promise<SupportInboxCustomerLink | null>) | null;
  basePath: string;
};

export function normalizeConfig(config: SupportInboxConfig): ResolvedSupportInboxConfig {
  // fromEmail feeds real outbound mail (sender + synthesized Message-ID
  // domain), so an unparseable value must fail here — at creation, where the
  // misconfiguration is — not corrupt threading identity per-request.
  const fromEmail = config.fromEmail.trim();
  const fromParsed = parseAddress(fromEmail);
  if (!fromParsed) {
    throw new Error(
      `[support-inbox] fromEmail is not a parseable address: ${JSON.stringify(config.fromEmail)}`,
    );
  }
  const fromDomain = fromParsed.address.split("@")[1];
  if (!fromDomain) {
    throw new Error(`[support-inbox] fromEmail has no domain part: ${JSON.stringify(fromEmail)}`);
  }

  // Missing key/secret is tolerated (the webhook answers 503 unconfigured by
  // design), but it should be one loud creation-time signal, not a trail of
  // opaque per-request failures.
  if (!config.resendApiKey) {
    console.warn(
      "[support-inbox] resendApiKey is empty — inbound content fetches, sync, and replies will fail",
    );
  }
  if (!config.webhookSecret) {
    console.warn("[support-inbox] webhookSecret is empty — the inbound webhook will answer 503");
  }

  const inboundAddresses =
    config.inboundAddresses
      ?.map((address) => address.trim().toLowerCase())
      .filter(Boolean) ?? null;

  const aliasMap: Record<string, string> = {};
  for (const [alias, publicAddress] of Object.entries(config.aliasMap ?? {})) {
    const key = alias.trim().toLowerCase();
    const value = publicAddress.trim().toLowerCase();
    if (key && value) aliasMap[key] = value;
  }

  const basePath = normalizeBasePath(config.basePath);

  return {
    db: config.db,
    resendApiKey: config.resendApiKey,
    fromEmail,
    fromAddress: fromParsed.address,
    fromName: fromParsed.name,
    fromDomain,
    inboundAddresses: inboundAddresses && inboundAddresses.length > 0 ? inboundAddresses : null,
    aliasMap,
    webhookSecret: config.webhookSecret,
    authorize: config.authorize,
    lookupCustomer: config.lookupCustomer ?? null,
    basePath,
  };
}

/** Mount point of the route handlers: leading slash, no trailing slash. */
export function normalizeBasePath(value: string | undefined): string {
  let basePath = (value ?? "/api/admin/support").trim();
  if (!basePath.startsWith("/")) basePath = `/${basePath}`;
  return basePath.replace(/\/+$/, "");
}

/**
 * The fetch the Reacharound router calls. A plain function type rather than
 * `typeof fetch`: runtimes add extra properties to their global fetch (Bun's
 * types add `preconnect`), so `typeof fetch` would reject an ordinary
 * `(input, init) => fetch(input, init)` passed by a host on that runtime.
 */
export type SupportInboxFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Where Reacharound lives. Every app talks to this one hub, so the package
 * knows the address and an app never sets it (2026-10-28: one key, nothing
 * else to configure).
 */
export const REACHAROUND_URL = "https://reacharound.xyz";

/**
 * Reacharound mode (PRO-5000): the app keeps the package's routes and screens,
 * but holds no support data. Reacharound — the hub that receives every
 * project's support mail — is the store, and each route forwards to its inbox
 * API (`/api/inbox/…`) with this brand's inbox key and the acting admin. The
 * key alone tells Reacharound which brand is asking, so it is the app's one
 * setting. No `db`, no Resend key, no webhook: Reacharound receives, threads
 * and sends; the app is a window onto it, kept in step with the hub's own
 * Inbox by construction.
 */
export type SupportInboxReacharoundConfig = {
  reacharound: {
    /**
     * The brand's inbox key (`rik_…`), from Reacharound: Inbox › Connect an
     * app › Get a key. It names the brand, so nothing else is needed. It can
     * SEND mail as this brand: server-only, never in client code or a
     * `NEXT_PUBLIC_` variable. The browser only ever talks to this app.
     */
    key: string;
    /**
     * Leave it out. Defaults to `REACHAROUND_URL`, the one hub every app talks
     * to; only for pointing a development copy at a Reacharound running on
     * this machine. https only (http for localhost). Empty means the default.
     */
    url?: string;
  };
  /**
   * Returns the acting admin or null (null = bare 404, as in self-hosted mode).
   * In this mode the actor MUST carry an `email`: Reacharound records it as
   * the sender of every reply and requires it on every write.
   */
  authorize: (req: Request) => Promise<SupportInboxActor | null>;
  /** Optional customer lookup rendered in the thread detail view. */
  lookupCustomer?: (email: string) => Promise<SupportInboxCustomerLink | null>;
  /** Mount point of the route handlers. Default: /api/admin/support */
  basePath?: string;
  /** Per-request timeout for calls to Reacharound. Default: 15000 ms. */
  timeoutMs?: number;
  /** Test seam: the fetch used to call Reacharound. Default: global fetch. */
  fetch?: SupportInboxFetch;
};

export type ResolvedReacharoundConfig = {
  /** `{url}/api/inbox`, no trailing slash. */
  inboxApiBase: string;
  key: string;
  authorize: (req: Request) => Promise<SupportInboxActor | null>;
  lookupCustomer: ((email: string) => Promise<SupportInboxCustomerLink | null>) | null;
  basePath: string;
  timeoutMs: number;
  fetch: SupportInboxFetch;
};

/**
 * Validates at creation, where the misconfiguration is, rather than failing
 * every request: a missing or wrong key, or a malformed URL, would otherwise
 * surface as an opaque 502 on the first admin page load. Errors never repeat
 * the key: it can send mail.
 */
export function normalizeReacharoundConfig(
  config: SupportInboxReacharoundConfig,
): ResolvedReacharoundConfig {
  const { key } = config.reacharound;
  const url = config.reacharound.url?.trim() || REACHAROUND_URL;
  let base: URL;
  try {
    base = new URL(url.trim());
  } catch {
    throw new Error(`[support-inbox] reacharound.url is not a URL: ${JSON.stringify(url)}`);
  }
  // The inbox key rides in every request's Authorization header, so plain
  // http is allowed only to this machine (a Reacharound running locally).
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && local)) {
    throw new Error(
      `[support-inbox] reacharound.url must be https (http only for localhost): ${JSON.stringify(url)}`,
    );
  }
  const trimmedKey = key.trim();
  if (!trimmedKey) {
    throw new Error("[support-inbox] reacharound.key is empty — set the brand's inbox key (REACHAROUND_INBOX_KEY)");
  }
  // Catches the likely slips (a Resend key, a pasted `NAME=value` line, quotes)
  // here rather than as "Reacharound refused this app's inbox key" later.
  if (!trimmedKey.startsWith("rik_")) {
    throw new Error("[support-inbox] reacharound.key isn't a Reacharound inbox key: those start with rik_");
  }
  const origin = base.toString().replace(/\/+$/, "");
  return {
    inboxApiBase: `${origin}/api/inbox`,
    key: trimmedKey,
    authorize: config.authorize,
    lookupCustomer: config.lookupCustomer ?? null,
    basePath: normalizeBasePath(config.basePath),
    timeoutMs: config.timeoutMs ?? 15_000,
    fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
  };
}
