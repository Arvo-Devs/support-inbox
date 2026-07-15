// Shared guards for reading untrusted JSON (webhook payloads and Resend API
// responses) — one definition so the two parsing surfaces can't drift.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
