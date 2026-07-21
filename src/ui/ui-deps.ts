// THE design-system seam: the only place this package touches UI primitives.
// They are vendored self-contained copies of the infra-agent house components
// (see ./vendor, each file headers its source path and commit). Adapting this
// package to another design system still means editing exactly this file:
// point these exports at your own components with the same names and props.

export { Badge } from "./vendor/badge";
export { Button } from "./vendor/button";
export { Card, CardContent } from "./vendor/card";
export { ConfirmDialog } from "./vendor/dialog";
export { EmptyState } from "./vendor/empty-state";
export { ErrorMessage } from "./vendor/error-message";
export { Input } from "./vendor/input";
export { Textarea } from "./vendor/textarea";
export { cn } from "./vendor/utils";
export { toast } from "sonner";
