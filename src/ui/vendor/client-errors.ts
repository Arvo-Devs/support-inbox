"use client";

// Vendored from infra-agent packages/ui/src/lib/client-errors.ts at commit 1cbc809; no import rewrites needed.
import { toast } from "sonner";

type ErrorToast = {
  title: string;
  description?: string;
};

type FailureDetail = {
  email?: string;
  name?: string;
  message?: string;
  reason?: string;
  error?: string;
};

const CODE_MESSAGES: Record<string, string> = {
  NO_ACTIVE_TEAM: "No active organization. Create or switch to an organization, then try again.",
  NO_ACTIVE_APP: "No active workspace view. Refresh and try again.",
  missing_webhook_url: "The Discord webhook URL is missing.",
  missing_recipients: "No email recipients are configured.",
  missing_resend_api_key: "Email alerts are not configured because RESEND_API_KEY is missing.",
  all_recipients_suppressed:
    "Every recipient previously hard-bounced or marked an alert as spam, so email to them is suppressed.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readPath(source: unknown, path: string[]): unknown {
  let current = source;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function firstMessageFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  const direct =
    stringValue(payload.message) ??
    stringValue(payload.error) ??
    stringValue(readPath(payload, ["error", "message"])) ??
    stringValue(readPath(payload, ["data", "message"]));
  if (direct) return direct;

  const code =
    stringValue(payload.code) ??
    stringValue(readPath(payload, ["error", "code"])) ??
    stringValue(readPath(payload, ["data", "code"]));
  return code ? (CODE_MESSAGES[code] ?? code) : null;
}

function zodMessages(error: unknown): string[] {
  const zodError =
    readPath(error, ["data", "zodError"]) ??
    readPath(error, ["shape", "data", "zodError"]);

  if (!isRecord(zodError)) return [];

  const messages: string[] = [];
  const formErrors = zodError.formErrors;
  if (Array.isArray(formErrors)) {
    messages.push(...formErrors.map(String).filter(Boolean));
  }

  const fieldErrors = zodError.fieldErrors;
  if (isRecord(fieldErrors)) {
    for (const [field, fieldMessages] of Object.entries(fieldErrors)) {
      if (!Array.isArray(fieldMessages)) continue;
      for (const message of fieldMessages) {
        const text = stringValue(message);
        if (text) messages.push(`${field}: ${text}`);
      }
    }
  }

  return Array.from(new Set(messages));
}

function normalizeMessage(message: string, fallback: string): string {
  const trimmed = message.trim();
  if (!trimmed) return fallback;
  if (CODE_MESSAGES[trimmed]) return CODE_MESSAGES[trimmed];
  if (/^Failed to fetch$/i.test(trimmed)) {
    return "The request did not reach the server. Check your connection and try again.";
  }
  if (/^Load failed$/i.test(trimmed)) {
    return "The browser could not load the request. Check your connection and try again.";
  }
  return trimmed;
}

export function getErrorMessage(error: unknown, fallback: string): string {
  const zod = zodMessages(error);
  if (zod.length > 0) return zod[0];

  const payloadMessage = firstMessageFromPayload(error);
  if (payloadMessage) return normalizeMessage(payloadMessage, fallback);

  if (error instanceof Error) return normalizeMessage(error.message, fallback);
  if (typeof error === "string") return normalizeMessage(error, fallback);

  return fallback;
}

export function getErrorToast(error: unknown, fallbackTitle: string): ErrorToast {
  const messages = zodMessages(error);
  if (messages.length > 0) {
    return {
      title: fallbackTitle,
      description: messages.slice(0, 5).join("\n"),
    };
  }

  const message = getErrorMessage(error, fallbackTitle);
  if (message === fallbackTitle) return { title: fallbackTitle };
  return { title: fallbackTitle, description: message };
}

export function showErrorToast(error: unknown, fallbackTitle: string) {
  const { title, description } = getErrorToast(error, fallbackTitle);
  toast.error(title, description ? { description } : undefined);
}

async function parseResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function getResponseErrorToast(
  response: Response,
  fallbackTitle: string,
): Promise<ErrorToast> {
  const payload = await parseResponsePayload(response);
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;

  if (typeof payload === "string" && payload.trim()) {
    return { title: fallbackTitle, description: `${status}: ${payload.trim()}` };
  }

  const message = firstMessageFromPayload(payload);
  if (message) {
    return { title: fallbackTitle, description: `${status}: ${normalizeMessage(message, fallbackTitle)}` };
  }

  return { title: fallbackTitle, description: status };
}

export async function showResponseErrorToast(response: Response, fallbackTitle: string) {
  const { title, description } = await getResponseErrorToast(response, fallbackTitle);
  toast.error(title, description ? { description } : undefined);
}

export function formatFailureDetails(failures: FailureDetail[], maxItems = 5): string | undefined {
  if (failures.length === 0) return undefined;

  const visible = failures.slice(0, maxItems).map((failure) => {
    const label = failure.email ?? failure.name ?? "Item";
    const reason =
      failure.message ??
      failure.reason ??
      failure.error ??
      "The server did not provide a reason.";
    return `${label}: ${CODE_MESSAGES[reason] ?? reason}`;
  });

  const remaining = failures.length - visible.length;
  if (remaining > 0) visible.push(`${remaining} more failed.`);
  return visible.join("\n");
}
