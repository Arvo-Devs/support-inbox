"use client";

// Fail-quiet unread counter for navs and sidebars. Renders nothing while
// loading, on ANY error (e.g. a 404 from a not-yet-mounted API), and when the
// count is zero.

import { useQuery } from "@tanstack/react-query";

import { Badge } from "../ui/ui-deps";
import { getUnreadCount } from "./api";
import { useSupportInboxBasePath } from "./context";
import { keys } from "./keys";

export type SupportUnreadBadgeProps = { basePath?: string };

export function SupportUnreadBadge({ basePath }: SupportUnreadBadgeProps) {
  const contextBasePath = useSupportInboxBasePath();
  const resolvedBasePath = basePath ?? contextBasePath;

  const query = useQuery({
    queryKey: keys.unreadCount(),
    queryFn: () => getUnreadCount(resolvedBasePath),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: false,
    throwOnError: false,
  });

  const count = query.data?.count;
  if (query.isError || count === undefined || count === 0) return null;

  return (
    <Badge
      tone="down"
      className="h-5 px-1.5 text-[11px]"
      aria-label={`${count} unread support ${count === 1 ? "conversation" : "conversations"}`}
    >
      {count > 99 ? "99+" : count}
    </Badge>
  );
}
