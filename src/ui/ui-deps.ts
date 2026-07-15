// THE alias seam: the only file in this package that uses host path aliases.
// Every host must resolve `@/components/ui/*` and `@/lib/utils` (this repo
// maps them to packages/ui). On extraction, adapting a host to a different
// design system means editing exactly this file.

export { Badge } from "@/components/ui/badge";
export { Button } from "@/components/ui/button";
export { Card, CardContent } from "@/components/ui/card";
export { ConfirmDialog } from "@/components/ui/dialog";
export { EmptyState } from "@/components/ui/empty-state";
export { ErrorMessage } from "@/components/ui/error-message";
export { Input } from "@/components/ui/input";
export { Textarea } from "@/components/ui/textarea";
export { cn } from "@/lib/utils";
export { toast } from "sonner";
