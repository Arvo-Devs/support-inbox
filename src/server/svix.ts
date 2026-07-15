import { createHmac, timingSafeEqual } from "node:crypto";

// Vendored copy of verifySvixSignature from
// apps/dashboard/src/server/notifications/resend-webhook.ts so the package
// stays dependency-free (no svix SDK) and alias-free.
//
// Resend signs webhooks via Svix: base64 HMAC-SHA256 over "{id}.{timestamp}.{payload}"
// with the base64-decoded secret (after the "whsec_" prefix).
// https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests

const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export type SvixHeaders = {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
};

export function verifySvixSignature(options: {
  secret: string;
  payload: string;
  headers: SvixHeaders;
  now?: Date;
}): boolean {
  const { id, timestamp, signature } = options.headers;
  if (!id || !timestamp || !signature) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const nowSeconds = (options.now ?? new Date()).getTime() / 1000;
  if (Math.abs(nowSeconds - timestampSeconds) > TIMESTAMP_TOLERANCE_SECONDS) return false;

  let key: Buffer;
  try {
    key = Buffer.from(options.secret.replace(/^whsec_/, ""), "base64");
  } catch {
    return false;
  }
  if (key.length === 0) return false;

  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${options.payload}`)
    .digest();

  // The header holds space-separated "v1,<base64>" entries (one per active secret).
  for (const candidate of signature.split(" ")) {
    const [version, encoded] = candidate.split(",");
    if (version !== "v1" || !encoded) continue;
    let provided: Buffer;
    try {
      provided = Buffer.from(encoded, "base64");
    } catch {
      continue;
    }
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return true;
    }
  }

  return false;
}
