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
  /** Outbound sender, e.g. `Infra Agent Support <support@infraagent.app>`. */
  fromEmail: string;
  /**
   * Public addresses that create tickets, matched (lowercased) against
   * to/cc/received_for. Undefined = accept all inbound mail.
   */
  inboundAddresses?: string[];
  /**
   * Managed alias -> public address (e.g. `support@<id>.resend.app` ->
   * `support@infraagent.app`). Makes Gmail-forwarding routing deterministic;
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

  let basePath = (config.basePath ?? "/api/admin/support").trim();
  if (!basePath.startsWith("/")) basePath = `/${basePath}`;
  basePath = basePath.replace(/\/+$/, "");

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
