# @arvo/support-inbox

A self-hosted support-email inbox built on [Resend receiving](https://resend.com/docs/dashboard/receiving/introduction). Customers email your public support address; admins read and answer threads inside your own admin panel. Each project **imports and self-hosts** the package: its own DB tables, its own webhook endpoint and secret, its own Resend domain and API key. Nothing is shared between installs, and improvements ship via a version bump that each host adopts on its own schedule.

Originally built and proven inside the infra-agent dashboard (Arvo-Devs/infra-agent#52); extracted here so any project can install it.

## Installing

Pin to a **commit SHA** (tags are movable labels; the SHA is the pin):

```jsonc
// package.json
"dependencies": {
  "@arvo/support-inbox": "github:Arvo-Devs/support-inbox#<full-commit-sha>"
}
```

```ts
// next.config.ts — the package ships TypeScript source, the host compiles it
transpilePackages: ["@arvo/support-inbox"],
```

Updating a project = review `git diff <old-sha>..<new-sha>` in this repo, bump the SHA, `pnpm install`, commit the lockfile. Builds should use `--frozen-lockfile` so nothing changes out from under you.

Imports:

```ts
import { createSupportInbox } from "@arvo/support-inbox";          // server
import { SupportInboxPage, SupportUnreadBadge } from "@arvo/support-inbox/client";
import { supportThreads, supportMessages } from "@arvo/support-inbox/schema";
```

## Requirements

- **Next.js (App Router) + React.** Route handlers are plain `(Request) => Response`, so other frameworks can mount them too; the client components need React 19 and @tanstack/react-query v5.
- **Postgres + drizzle-orm.** The host passes a drizzle handle (`PgDatabase`) with a working `.transaction`; the package never opens its own connection.
- **Resend with a full-access API key.** Sending-only keys cannot read inbound mail. Keep it server-only, and prefer a dedicated per-app key so rotation stays isolated from your product-email key.
- **Tailwind CSS v4** for the UI. Add a source line so Tailwind sees the package's class names:

  ```css
  /* globals.css */
  @source "../node_modules/@arvo/support-inbox/src";
  ```

## UI theming

The components are self-contained (vendored primitives on @base-ui/react, peer-installed). They style themselves with design-token CSS variables (`--color-card`, `--color-danger-soft`, ...):

- If your app already defines these tokens (house design system), you're done.
- Otherwise import the bundled defaults once:

  ```css
  @import "@arvo/support-inbox/styles/tokens.css";
  ```

Adapting to a completely different design system means editing exactly one file: `src/ui/ui-deps.ts` (the seam every component imports its primitives through).

## Mounting

Three small host files (the config contract is `SupportInboxConfig` in `src/config.ts`):

**1. Server singleton** — lazy, so nothing touches env or the DB at build time:

```ts
// src/server/support/inbox.ts
import { createSupportInbox } from "@arvo/support-inbox";

let cached: ReturnType<typeof createSupportInbox> | null = null;
export function getSupportInbox() {
  if (!cached) {
    cached = createSupportInbox({
      db,                                  // drizzle root handle (.transaction required)
      resendApiKey: process.env.SUPPORT_RESEND_API_KEY ?? "",
      fromEmail: "Acme Support <support@example.com>",
      inboundAddresses: ["support@example.com", "contact@example.com"], // optional; undefined = accept all
      aliasMap: { "support@<id>.resend.app": "support@example.com" },   // optional; for Gmail forwarding
      webhookSecret: process.env.SUPPORT_INBOUND_WEBHOOK_SECRET ?? "",
      authorize,                           // (req: Request) => Promise<{id, email?, name?} | null>
      lookupCustomer,                      // optional: link a sender to your own user/org page
    });
  }
  return cached;
}
```

**2. Admin API route** (default basePath `/api/admin/support`):

```ts
// src/app/api/admin/support/[...route]/route.ts
import { getSupportInbox } from "@/server/support/inbox";
export const runtime = "nodejs";
export const GET = (request: Request) => getSupportInbox().routeHandlers.GET(request);
export const POST = (request: Request) => getSupportInbox().routeHandlers.POST(request);
```

**3. Webhook route** — same shape with `webhookHandler`:

```ts
// src/app/api/webhooks/resend-inbound/route.ts
export const GET = (request: Request) => getSupportInbox().webhookHandler.GET(request);
export const POST = (request: Request) => getSupportInbox().webhookHandler.POST(request);
```

Then render `<SupportInboxPage />` on an admin page, and optionally `<SupportUnreadBadge />` in your nav.

**`authorize` is the entire API auth boundary.** It receives the raw `Request` and returns the acting admin or `null`. Null renders a bare 404 indistinguishable from an unknown route, so the surface stays invisible to non-admins. Read the admin role fresh from your DB on every call (not from a cached session) so a revoked admin loses access on the next request. Returning an actor (not a boolean) lets replies store `actor_id`/`actor_label` without joining your user table.

## Database

Copy `migrations/0001_support_inbox.sql` **verbatim** (with a `-- copied from @arvo/support-inbox migrations/0001_support_inbox.sql` header) into your migration directory and let your runner apply it. Upgrades ship additive numbered migrations that hosts copy the same way; every file is idempotent, so re-application is safe.

Three tables: `support_threads`, `support_messages`, `support_attachments`. RLS is deliberately disabled: the inbox is an instance-admin surface with no tenant context.

## Resend setup

### Dev (zero DNS)

1. Create a **managed inbound address** in Resend: `something@<id>.resend.app`, no DNS needed.
2. Email it from anywhere, press the inbox's **Sync** button. Sync pulls mail through Resend's list API, so no public URL or webhook is needed; the full flow works on localhost.

### Prod

1. Verify your domain in Resend and enable receiving (one MX record), **or** keep your existing mail provider and forward per-address into a managed alias (next section).
2. Add a webhook endpoint `https://<host>/api/webhooks/resend-inbound` subscribed to **`email.received`**.
3. Put that endpoint's signing secret in `SUPPORT_INBOUND_WEBHOOK_SECRET`. Every Resend webhook endpoint has its **own** `whsec_`; never reuse another endpoint's secret.

### Suggested env vars

| Variable | Purpose |
| --- | --- |
| `SUPPORT_RESEND_API_KEY` | Full-access Resend key (server-only). |
| `SUPPORT_FROM_EMAIL` | Outbound sender, e.g. `Acme Support <support@example.com>`. |
| `SUPPORT_INBOUND_ADDRESSES` | Comma-separated addresses that create tickets. Empty = accept all. |
| `SUPPORT_ALIAS_MAP` | `alias=public` pairs for forwarding setups. |
| `SUPPORT_INBOUND_WEBHOOK_SECRET` | `whsec_` of the `email.received` webhook. |
| `SUPPORT_INBOX_ENABLED` | Launch gate: keep unset until the live e2e below passes. |

## Domains that already have mailboxes (Gmail/Workspace forwarding)

If the domain's MX already points at Google (or another provider), do NOT move it; forward instead:

- Use **per-address forwarding only**: a Gmail filter (`to:support@yourdomain` → forward) or a Workspace routing rule per address. Never mailbox-wide auto-forwarding (it forwards everything in that mailbox).
- Forward each public address to its own **distinguishable managed alias** (`support@…` → `support@<id>.resend.app`) and set `aliasMap` accordingly. Forwarding can rewrite headers; the alias map keys routing on the envelope (`received_for`), keeping the stored `inbound_address` deterministic.
- The forwarding-confirmation code email lands in Resend; find it via Sync or the Resend dashboard's Received tab.
- Your provider keeps a backup copy of everything it forwards.
- Fresh domains with no mailboxes skip all of this: point MX straight at Resend. Both setups converge on the same code path.

## Launch gate (per install)

Ship dark, then verify live before enabling:

1. Deploy with `SUPPORT_INBOX_ENABLED` unset (admin UI/API 404; webhook stays live, secret-gated, for fixture capture).
2. Send one real email (through your actual forwarding path, if any) to the inbound address; confirm the thread appears via Sync or webhook.
3. Reply from the inbox; confirm it arrives threaded in the sender's mail client; reply back and confirm same-thread ingestion.
4. Flip the flag.

> **Outstanding, package-level:** the Resend inbound field-mapping layer (`src/server/resend-api.ts`) was written against documented payloads but has never been validated against a **captured live payload**, and the test fixtures are synthetic. The first install to run step 2 should capture the raw webhook JSON + retrieved email and contribute them back here as fixtures with a mapping test. Until then, treat the live e2e as mandatory, not optional.

## Behavior notes

- **Replies are plain-text and sender-only.** CC recipients are displayed, not auto-included (reply-all is future work).
- **Attachments are metadata + on-demand signed links**, expiry driven by the API's `expires_at`. Expired links render as "no longer available."
- **Admin replies do not appear in your mail provider's Sent folder.** The app database is authoritative for outbound support mail.
- **Replies deliberately skip suppression lists** (an explicit human reply outranks an automated suppression), and hard bounces will feed whatever bounce webhook the host already runs.
- **Sync recovers missed or failed mail within the newest `SYNC_MAX_PAGES × SYNC_PAGE_SIZE` (250) inbound emails**, scanning every page up to the cap each run. Older gaps than that need Resend's dashboard. A host scheduler can automate sync by POSTing `{basePath}/sync` with an authorized credential.
- **HTML bodies render in a sandboxed iframe**: no `allow-scripts`, no `allow-same-origin`, default-deny CSP, remote images blocked by default (tracking pixels included) with per-message opt-in. Links escape the sandbox into normal tabs; opened tabs get no opener reference.

## Supply-chain rules for this repo

- No lifecycle scripts, ever (`postinstall` etc.). If a diff adds one, treat it as a red flag; never allowlist this package in pnpm's build-script gate.
- Runtime dependency surface stays `resend` + `drizzle-orm`; UI libs are peers the host already has. New transitive dependencies deserve scrutiny in the update diff.
- Private repo, 2FA on all committers, branch protection on `main`, no third-party apps with write access.

## Optional hardening

Cap the blast radius of a bad version with a dedicated Postgres role granted only the three support tables, and build this package's drizzle handle from that role's connection string:

```sql
CREATE ROLE support_inbox LOGIN PASSWORD '...';
GRANT SELECT, INSERT, UPDATE, DELETE ON support_threads, support_messages, support_attachments TO support_inbox;
```

## Development

```sh
pnpm install          # no lifecycle scripts run
pnpm test             # node:test via tsx
pnpm typecheck        # tsc --noEmit
```
