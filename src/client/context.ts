"use client";

// Base-path context so every component in the tree talks to the same API
// mount point. Components used outside a provider (e.g. SupportUnreadBadge in
// a nav) fall back to the default mount path.

import { createContext, createElement, useContext, type ReactNode } from "react";

export const DEFAULT_BASE_PATH = "/api/admin/support";

const SupportInboxContext = createContext<string>(DEFAULT_BASE_PATH);

export type SupportInboxProviderProps = {
  basePath?: string;
  children: ReactNode;
};

export function SupportInboxProvider({ basePath, children }: SupportInboxProviderProps) {
  return createElement(
    SupportInboxContext.Provider,
    { value: basePath ?? DEFAULT_BASE_PATH },
    children,
  );
}

/** The API base path in effect — provider value, or the default outside one. */
export function useSupportInboxBasePath(): string {
  return useContext(SupportInboxContext);
}
