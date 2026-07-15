import type { AttachmentUrlResponse } from "../../shared/types";
import { ResendApiError } from "../resend-api";
import type { ResendApi } from "../resend-api";
import type { RouterDeps } from "../router";

// Attachment URL resolution. Attachment bytes are never stored locally: the
// route re-lists the inbound email's attachments on demand and hands back
// Resend's short-lived URL. Expiry is driven entirely by the API's own
// expires_at — there is no hard-coded retention window anywhere.

function unavailable(): Response {
  return Response.json({ error: "unavailable" }, { status: 410 });
}

export async function attachmentUrl(deps: RouterDeps, attachmentId: string): Promise<Response> {
  const found = await deps.store.getAttachment(attachmentId);
  if (!found) return Response.json({ error: "Attachment not found" }, { status: 404 });
  if (!found.messageResendInboundId) return unavailable();

  let links: Awaited<ReturnType<ResendApi["listAttachments"]>>;
  try {
    links = await deps.resendApi.listAttachments(found.messageResendInboundId);
  } catch (error) {
    if (error instanceof ResendApiError && (error.status === 404 || error.status === 410)) {
      return unavailable();
    }
    throw error;
  }

  const link = links.find((entry) => entry.id === found.attachment.resendAttachmentId);
  if (!link || !link.url) return unavailable();
  if (link.expiresAt && new Date(link.expiresAt) <= new Date()) return unavailable();

  return Response.json({
    url: link.url,
    filename: found.attachment.filename,
    contentType: found.attachment.contentType,
    expiresAt: link.expiresAt,
  } satisfies AttachmentUrlResponse);
}
