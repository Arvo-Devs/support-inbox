import type { ResolvedSupportInboxConfig } from "../config";
import { ingestReceivedEmail } from "./ingest";
import { isRecord, readString } from "./json";
import type { ResendApi } from "./resend-api";
import type { SupportStore } from "./store";
import { verifySvixSignature } from "./svix";

// Route handlers for the Resend inbound webhook. Response shape mirrors
// apps/dashboard/src/app/api/webhooks/resend/route.ts: any throw after
// signature verification returns a 500 so Resend redelivers.

export function createWebhookHandler(
  config: ResolvedSupportInboxConfig,
  deps: { store: SupportStore; resendApi: ResendApi },
): { GET: (req: Request) => Promise<Response>; POST: (req: Request) => Promise<Response> } {
  return {
    GET: async () => Response.json({ ok: true, endpoint: "support-inbox" }),

    POST: async (request: Request) => {
      if (!config.webhookSecret) {
        return Response.json(
          { success: false, error: "support inbox webhook secret is not configured" },
          { status: 503 },
        );
      }

      const payload = await request.text();
      const verified = verifySvixSignature({
        secret: config.webhookSecret,
        payload,
        headers: {
          id: request.headers.get("svix-id"),
          timestamp: request.headers.get("svix-timestamp"),
          signature: request.headers.get("svix-signature"),
        },
      });
      if (!verified) {
        return Response.json(
          { success: false, error: "Invalid webhook signature" },
          { status: 401 },
        );
      }

      let event: unknown;
      try {
        event = JSON.parse(payload);
      } catch {
        return Response.json({ success: false, error: "Invalid JSON payload" }, { status: 400 });
      }

      const type = isRecord(event) ? readString(event.type) : null;
      if (type !== "email.received") {
        return Response.json({ ignored: true, reason: "event_type" });
      }

      const data: Record<string, unknown> =
        isRecord(event) && isRecord(event.data) ? event.data : {};
      const emailId = readString(data.email_id) ?? readString(data.id);
      if (!emailId) {
        return Response.json(
          { success: false, error: "Missing received email id in event payload" },
          { status: 400 },
        );
      }

      try {
        const result = await ingestReceivedEmail(
          { store: deps.store, resendApi: deps.resendApi, config },
          emailId,
        );
        if (result.outcome === "ignored") {
          return Response.json({ ignored: true, reason: result.reason });
        }
        if (result.outcome === "skipped") {
          return Response.json({ skipped: true });
        }
        return Response.json({
          success: true,
          threadId: result.threadId,
          messageId: result.messageId,
        });
      } catch (error) {
        // 500 so Resend redelivers: content fetch and DB errors are transient.
        console.error("[support-inbox] webhook ingest failed", { emailId, error });
        return Response.json(
          { success: false, error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    },
  };
}
