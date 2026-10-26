import { normalizeConfig, normalizeReacharoundConfig } from "./config";
import type { SupportInboxConfig, SupportInboxReacharoundConfig } from "./config";
import { createReacharoundRouter } from "./server/reacharound";
import { createResendApi } from "./server/resend-api";
import { createRouter } from "./server/router";
import { createSupportStore } from "./server/store";
import { createWebhookHandler } from "./server/webhook";

export type {
  SupportInboxActor,
  SupportInboxConfig,
  SupportInboxDb,
  SupportInboxReacharoundConfig,
} from "./config";

type RouteHandlers = {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
};

/**
 * Server entry point. Hosts mount `routeHandlers` at `config.basePath` (a
 * catch-all route); both dispatch on the URL pathname only.
 *
 * Two modes, chosen by the config's shape:
 *  - **Reacharound** (`{ reacharound: { url, projectId, key }, authorize }`) —
 *    the standard install. Routes forward to Reacharound, which holds the
 *    mail; there is no database, no Resend key and no webhook, so only
 *    `routeHandlers` is returned.
 *  - **Self-hosted** (`{ db, resendApiKey, fromEmail, webhookSecret, … }`) —
 *    the app stores and sends its own mail; mount `webhookHandler` at the
 *    resend-inbound endpoint too.
 */
export function createSupportInbox(config: SupportInboxReacharoundConfig): {
  routeHandlers: RouteHandlers;
};
export function createSupportInbox(config: SupportInboxConfig): {
  routeHandlers: RouteHandlers;
  webhookHandler: RouteHandlers;
};
export function createSupportInbox(config: SupportInboxConfig | SupportInboxReacharoundConfig): {
  routeHandlers: RouteHandlers;
  webhookHandler?: RouteHandlers;
} {
  if ("reacharound" in config) {
    const dispatch = createReacharoundRouter(normalizeReacharoundConfig(config));
    return { routeHandlers: { GET: dispatch, POST: dispatch } };
  }
  const resolved = normalizeConfig(config);
  const store = createSupportStore(resolved.db);
  const resendApi = createResendApi(resolved.resendApiKey);
  const dispatch = createRouter(resolved, { store, resendApi });
  return {
    routeHandlers: { GET: dispatch, POST: dispatch },
    webhookHandler: createWebhookHandler(resolved, { store, resendApi }),
  };
}
