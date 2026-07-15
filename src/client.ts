// Client entry for @infra-agent/support-inbox. The host mounts these inside
// its own QueryClientProvider (and Toaster); basePath defaults to
// "/api/admin/support".

export { SupportInboxPage } from "./client/support-inbox-page";
export type { SupportInboxPageProps } from "./client/support-inbox-page";
export { SupportUnreadBadge } from "./client/unread-badge";
export type { SupportUnreadBadgeProps } from "./client/unread-badge";
