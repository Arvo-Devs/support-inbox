import { normalizeConfig } from "./config";
import type { SupportInboxConfig } from "./config";
import { createResendApi } from "./server/resend-api";
import { createRouter } from "./server/router";
import { createSupportStore } from "./server/store";
import { createWebhookHandler } from "./server/webhook";

export type { SupportInboxActor, SupportInboxConfig, SupportInboxDb } from "./config";

type RouteHandlers = {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
};

/**
 * Server entry point. Hosts mount `routeHandlers` at `config.basePath` (a
 * catch-all route) and `webhookHandler` at their resend-inbound webhook
 * endpoint; both dispatch on the URL pathname only.
 */
export function createSupportInbox(config: SupportInboxConfig): {
  routeHandlers: RouteHandlers;
  webhookHandler: RouteHandlers;
} {
  const resolved = normalizeConfig(config);
  const store = createSupportStore(resolved.db);
  const resendApi = createResendApi(resolved.resendApiKey);
  const dispatch = createRouter(resolved, { store, resendApi });
  return {
    routeHandlers: { GET: dispatch, POST: dispatch },
    webhookHandler: createWebhookHandler(resolved, { store, resendApi }),
  };
}
