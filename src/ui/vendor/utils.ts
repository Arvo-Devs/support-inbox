// Vendored from infra-agent packages/ui/src/lib/utils.ts at commit 1cbc809 (cn helper only; the rest of that file is infra-agent domain logic this package does not use).
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
