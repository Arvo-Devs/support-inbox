// Query-key factory for the support inbox. Every key is rooted at
// ["support-inbox"] so a single invalidateQueries({ queryKey: keys.all })
// refreshes every list, detail, and unread-count query this package owns.

export const keys = {
  all: ["support-inbox"] as const,
  threads: (filter: { status: string; q: string }) =>
    [...keys.all, "threads", filter] as const,
  thread: (id: string) => [...keys.all, "thread", id] as const,
  unreadCount: () => [...keys.all, "unread-count"] as const,
};
