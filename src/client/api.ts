// Thin typed fetch client for the support-inbox REST API. All requests are
// relative to a host-provided base path (default "/api/admin/support") and the
// responses are exactly the wire DTOs in ../shared/types.

import type {
  AttachmentUrlResponse,
  ReplyResponse,
  SyncResponse,
  ThreadDetailResponse,
  ThreadListResponse,
  ThreadResponse,
  ThreadStatus,
  UnreadCountResponse,
} from "../shared/types";

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

/** Human-readable message for a failed request, favoring the server's `{ error }`. */
export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export async function apiFetch<T>(
  basePath: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${basePath}${path}`, init);
  if (!res.ok) {
    let message = res.statusText || `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body && typeof body.error === "string" && body.error.length > 0) {
        message = body.error;
      }
    } catch {
      // Non-JSON error body — keep the status-text fallback.
    }
    throw new ApiRequestError(message, res.status);
  }
  return (await res.json()) as T;
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function listThreads({
  basePath,
  status,
  q,
  cursor,
}: {
  basePath: string;
  status: string;
  q: string;
  cursor?: string;
}): Promise<ThreadListResponse> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (q) params.set("q", q);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return apiFetch<ThreadListResponse>(basePath, `/threads${query ? `?${query}` : ""}`);
}

export function getUnreadCount(basePath: string): Promise<UnreadCountResponse> {
  return apiFetch<UnreadCountResponse>(basePath, "/threads/unread-count");
}

export function getThread(basePath: string, id: string): Promise<ThreadDetailResponse> {
  return apiFetch<ThreadDetailResponse>(basePath, `/threads/${encodeURIComponent(id)}`);
}

export function postReply(
  basePath: string,
  threadId: string,
  body: { text: string; replyAttemptId: string },
): Promise<ReplyResponse> {
  return apiFetch<ReplyResponse>(
    basePath,
    `/threads/${encodeURIComponent(threadId)}/reply`,
    jsonPost(body),
  );
}

export function setThreadRead(
  basePath: string,
  threadId: string,
  read: boolean,
): Promise<ThreadResponse> {
  return apiFetch<ThreadResponse>(
    basePath,
    `/threads/${encodeURIComponent(threadId)}/read`,
    jsonPost({ read }),
  );
}

export function setThreadStatus(
  basePath: string,
  threadId: string,
  status: ThreadStatus,
): Promise<ThreadResponse> {
  return apiFetch<ThreadResponse>(
    basePath,
    `/threads/${encodeURIComponent(threadId)}/status`,
    jsonPost({ status }),
  );
}

export function postSync(basePath: string): Promise<SyncResponse> {
  return apiFetch<SyncResponse>(basePath, "/sync", jsonPost({}));
}

export function getAttachmentUrl(
  basePath: string,
  attachmentId: string,
): Promise<AttachmentUrlResponse> {
  return apiFetch<AttachmentUrlResponse>(
    basePath,
    `/attachments/${encodeURIComponent(attachmentId)}/url`,
  );
}
