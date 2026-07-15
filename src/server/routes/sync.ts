import type { ResolvedSupportInboxConfig } from "../../config";
import type { SyncResponse } from "../../shared/types";
import { ingestReceivedEmail } from "../ingest";
import { ResendApiError } from "../resend-api";
import type { ResendApi } from "../resend-api";
import type { RouterDeps } from "../router";

/** Hard page cap per run — a run scans at most 5 * 50 = 250 emails. */
export const SYNC_MAX_PAGES = 5;
export const SYNC_PAGE_SIZE = 50;

/**
 * Bounded incremental import of anything the webhook missed, newest-first.
 *
 * Everything runs inside one store transaction: the try-lock serializing
 * concurrent /sync runs is transaction-scoped, and nested ingest transactions
 * become drizzle savepoints on the same connection (which the store contract
 * explicitly supports). Making network calls inside the transaction is an
 * accepted trade-off for v1: sync is admin-triggered and page-capped, so the
 * transaction stays short-lived.
 *
 * Rate limiting (429) never fails the run — it just stops early and returns
 * the partial counts with a 200.
 *
 * A single bad email (content fetch persistently failing, mapping error) must
 * never wedge sync: it is logged and counted as failed, the rest of the run
 * proceeds, and the transaction still commits. Failed ids stay unknown, so
 * the next run retries them. Nested ingest transactions are savepoints, so a
 * mid-ingest failure rolls back only that email.
 */
export async function sync(deps: RouterDeps, config: ResolvedSupportInboxConfig): Promise<Response> {
  const result = await deps.store.transaction(async (tx) => {
    if (!(await tx.tryAcquireSyncLock())) return null;

    let cursor: string | undefined;
    let scanned = 0;
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    let rateLimited = false;

    for (let page = 0; page < SYNC_MAX_PAGES; page++) {
      let listing: Awaited<ReturnType<ResendApi["listReceivedEmails"]>>;
      try {
        listing = await deps.resendApi.listReceivedEmails({
          limit: SYNC_PAGE_SIZE,
          after: cursor,
        });
      } catch (error) {
        if (error instanceof ResendApiError && error.status === 429) {
          rateLimited = true;
          break;
        }
        throw error;
      }

      scanned += listing.emails.length;
      const known = await tx.findKnownInboundIds(listing.emails.map((email) => email.id));
      skipped += known.size;
      const unknown = listing.emails.filter((email) => !known.has(email.id));
      // Fully-known page: everything older is already imported.
      if (unknown.length === 0) break;

      for (const email of unknown) {
        try {
          const outcome = await ingestReceivedEmail(
            { store: tx, resendApi: deps.resendApi, config },
            email.id,
          );
          if (outcome.outcome === "ingested") imported++;
          else skipped++;
        } catch (error) {
          if (error instanceof ResendApiError && error.status === 429) {
            rateLimited = true;
            break;
          }
          // Non-fatal: rethrowing would abort the whole transaction and let
          // one poison email block every future run.
          failed++;
          console.error("[support-inbox] sync ingest failed", { emailId: email.id, error });
        }
      }

      if (rateLimited || !listing.hasMore || !listing.nextCursor) break;
      cursor = listing.nextCursor;
    }

    return { scanned, imported, skipped, failed };
  });

  if (!result) return Response.json({ error: "A sync is already running" }, { status: 409 });
  return Response.json(result satisfies SyncResponse);
}
