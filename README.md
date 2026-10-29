# @arvo/support-inbox

A support-email inbox for your admin panel. Customers email your public support address; admins read and answer the conversations on a Support page inside your own app.

It runs in one of two modes:

- **Reacharound mode — the standard install.** [Reacharound](https://github.com/Arvo-Devs/Reacharound-Emails) is the shared hub for support mail. Your app keeps the package's routes and screens, and each route passes the request on to Reacharound with your brand's **inbox key** and the admin who is acting. The key is the one setting: it tells Reacharound which brand you are, and the package already knows where Reacharound is. Your app has **no tables, no webhook and no Resend key**; the same conversations show in Reacharound's own Inbox, in step. See [Reacharound mode](#reacharound-mode-standard).
- **Self-hosted mode — for an app whose support mail must stay on its own servers.** The app stores and sends its own mail: its own DB tables, webhook endpoint and secret, Resend domain and API key, and nothing goes through Reacharound. Fully supported; see [Self-hosted mode](#self-hosted-mode).

Improvements ship via a version bump that each host adopts on its own schedule.

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
import { supportThreads, supportMessages } from "@arvo/support-inbox/schema"; // self-hosted mode only
```

## Requirements

- **Node 24 or newer** (`engines`), the Arvo framework's version and what CI runs. Node 22 cancels part of the test suite.
- **Next.js (App Router) + React.** Route handlers are plain `(Request) => Response`, so other frameworks can mount them too; the client components need React 19 and @tanstack/react-query v5.
- **Self-hosted mode only:** Postgres + drizzle-orm (the host passes a drizzle handle with a working `.transaction`; the package never opens its own connection) and a full-access Resend API key (sending-only keys cannot read inbound mail). Reacharound mode needs neither.
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

## Reacharound mode (standard)

**One setting: the brand's inbox key.** The key tells Reacharound which brand this app is, and the package knows Reacharound's address (`https://reacharound.xyz`), so there is nothing else to configure.

**Before you start**, in [Reacharound](https://reacharound.xyz) (needs a Reacharound team admin):

1. The brand for this app exists and receives its mail: **Settings › Brands › Add brand**, then **Today › Inbox › Set up receiving** while that button shows.
2. **Today › Inbox › Connect an app › Get a key** (the same panel is on the brand's card in Settings › Brands). It is shown once; copy it.
3. Optional, in the same place: **App sends from**, the address conversations started from the Support page go out from (e.g. `hello@yourbrand.com`, on a verified domain). Left empty, they go out from `support@` the brand's domain.

**Env var** (server-only — never `NEXT_PUBLIC_`):

| Variable | Value |
| --- | --- |
| `REACHAROUND_INBOX_KEY` | The inbox key (`rik_…`). **It can send email as your brand.** |

Two small host files (the config contract is `SupportInboxReacharoundConfig` in `src/config.ts`):

**1. Server singleton** — lazy, so nothing reads env at build time:

```ts
// src/server/support/inbox.ts
import { createSupportInbox } from "@arvo/support-inbox";

let cached: ReturnType<typeof createSupportInbox> | null = null;
export function getSupportInbox() {
  if (!cached) {
    cached = createSupportInbox({
      reacharound: { key: process.env.REACHAROUND_INBOX_KEY ?? "" },
      authorize,      // (req: Request) => Promise<{ id, email, name? } | null> — email REQUIRED here
      lookupCustomer, // optional: link a sender to your own user/org page
    });
  }
  return cached;
}
```

A missing key, or one that isn't an inbox key (they start with `rik_`), throws on the first call, so a misconfigured deploy fails loudly instead of showing an empty inbox. There is also `reacharound.url`, only for pointing a development copy at a Reacharound running on your own machine (`http://localhost:3000`); leave it out everywhere else. It must be `https://` (plain `http://` only for localhost): the key rides in every request.

**Upgrading from a pin before the one-key change** (2026-10-28): delete `url` and `projectId` from the config, and the `REACHAROUND_URL` and `REACHAROUND_PROJECT_ID` settings from your server. The key itself stays the same.

**2. Admin API route** (default basePath `/api/admin/support`) — the same file as self-hosted mode:

```ts
// src/app/api/admin/support/[...route]/route.ts
import { getSupportInbox } from "@/server/support/inbox";
export const runtime = "nodejs";
export const GET = (request: Request) => getSupportInbox().routeHandlers.GET(request);
export const POST = (request: Request) => getSupportInbox().routeHandlers.POST(request);
```

Then render `<SupportInboxPage sync={false} />` on an admin page (Reacharound catches up on its own, so there is nothing to sync), and optionally `<SupportUnreadBadge />` in your nav. **No webhook route, no migration, no Resend key.**

How it behaves:

- **`authorize` stays the auth boundary**, exactly as in self-hosted mode (null = bare 404). The returned actor **must have an `email`**: Reacharound records it — and `name`, when given — as the sender of every reply and conversation, and shows "via <your brand>" beside it in its own Inbox. The actor is always taken from `authorize`, never from the browser's request.
- **The key never leaves your server.** The browser only talks to your app; your app's routes call Reacharound with the key. Nothing from the browser's request (cookies, headers) is forwarded, and only the list route's own query parameters are.
- **Errors arrive as `{ error }` the screens can show.** Reacharound's own answers pass through (400, 404, 409, 410, 422, 429, 502 …). A refused key (revoked or replaced in Reacharound, or its brand archived) becomes a 502 telling the admin to check the key, and a 404 on the conversation list or unread count (no inbox API at that address: a wrong `url`, or a Reacharound older than the one-key routes) a 502 saying the app isn't connected; a 404 on one conversation stays a 404. Reacharound unreachable, too slow (15 s, `timeoutMs`), answering with a redirect (never followed, so the key is never re-sent elsewhere) or with something that is not JSON is a 502 too. Logs name the route, never the search text.
- **Revoking or replacing the key in Reacharound cuts the app off immediately**; update `REACHAROUND_INBOX_KEY` after a replacement.
- **Every Reacharound-side rule applies**: replies go from the address the customer wrote to, conversations the app starts go from *App sends from*, and only this brand's mail is ever reachable with this key.
- **Starting a conversation (`POST /threads`) is limited**: `to` must be one address (`jane@example.com` or `Jane <jane@example.com>`; a list is a 400), and a brand can start at most 100 conversations in any 24 hours, after which Reacharound answers 429 until the window rolls on. Replies to existing conversations are not limited. Self-hosted mode takes one address too, but has no daily limit.

## Self-hosted mode

The app stores and sends its own mail. Everything in this section, down to *Behavior notes*, applies to self-hosted installs only.

To keep the mail out of Reacharound entirely, the Resend account the app receives on must not also be a brand in Reacharound: Reacharound's webhook takes every email that account receives.

### Mounting

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

### Database

Copy `migrations/0001_support_inbox.sql` **verbatim** (with a `-- copied from @arvo/support-inbox migrations/0001_support_inbox.sql` header) into your migration directory and let your runner apply it. Upgrades ship additive numbered migrations that hosts copy the same way; every file is idempotent, so re-application is safe.

Three tables: `support_threads`, `support_messages`, `support_attachments`. RLS is deliberately disabled: the inbox is an instance-admin surface with no tenant context.

### Resend setup

#### Dev (zero DNS)

1. Create a **managed inbound address** in Resend: `something@<id>.resend.app`, no DNS needed.
2. Email it from anywhere, press the inbox's **Sync** button. Sync pulls mail through Resend's list API, so no public URL or webhook is needed; the full flow works on localhost.

#### Prod

1. Verify your domain in Resend and enable receiving (one MX record), **or** keep your existing mail provider and forward per-address into a managed alias (next section).
2. Add a webhook endpoint `https://<host>/api/webhooks/resend-inbound` subscribed to **`email.received`**.
3. Put that endpoint's signing secret in `SUPPORT_INBOUND_WEBHOOK_SECRET`. Every Resend webhook endpoint has its **own** `whsec_`; never reuse another endpoint's secret.

#### Suggested env vars

| Variable | Purpose |
| --- | --- |
| `SUPPORT_RESEND_API_KEY` | Full-access Resend key (server-only). |
| `SUPPORT_FROM_EMAIL` | Outbound sender, e.g. `Acme Support <support@example.com>`. |
| `SUPPORT_INBOUND_ADDRESSES` | Comma-separated addresses that create tickets. Empty = accept all. |
| `SUPPORT_ALIAS_MAP` | `alias=public` pairs for forwarding setups. |
| `SUPPORT_INBOUND_WEBHOOK_SECRET` | `whsec_` of the `email.received` webhook. |

### Domains that already have mailboxes (Gmail/Workspace forwarding)

If the domain's MX already points at Google (or another provider), do NOT move it; forward instead:

- Use **per-address forwarding only**: a Gmail filter (`to:support@yourdomain` → forward) or a Workspace routing rule per address. Never mailbox-wide auto-forwarding (it forwards everything in that mailbox).
- Forward each public address to its own **distinguishable managed alias** (`support@…` → `support@<id>.resend.app`) and set `aliasMap` accordingly. Forwarding can rewrite headers; the alias map keys routing on the envelope (`received_for`), keeping the stored `inbound_address` deterministic.
- The forwarding-confirmation code email lands in Resend; find it via Sync or the Resend dashboard's Received tab.
- Your provider keeps a backup copy of everything it forwards.
- Fresh domains with no mailboxes skip all of this: point MX straight at Resend. Both setups converge on the same code path.

### Launch checklist (per install)

There is no feature flag: the inbox is admin-only from day one (`authorize` gates every route) and boots safely when unconfigured (webhook 503s, page shows an empty inbox). The gate is rollout **order**: wire the real public address last.

1. Deploy with the inbox mounted, configured against a managed `@<id>.resend.app` test address. No customer mail can arrive yet.
2. Send one real email (through your actual forwarding path, if any); confirm the thread appears via Sync or webhook.
3. Reply from the inbox; confirm it arrives threaded in the sender's mail client; reply back and confirm same-thread ingestion.
4. Only then point the real public address at it (the MX record or the forwarding rule). Customer traffic starts after verification, by construction.

> **Outstanding, package-level:** the Resend inbound field-mapping layer (`src/server/resend-api.ts`) was written against documented payloads but has never been validated against a **captured live payload**, and the test fixtures are synthetic. The first install to run step 2 should capture the raw webhook JSON + retrieved email and contribute them back here as fixtures with a mapping test. Until then, treat the live e2e as mandatory, not optional.

## Behavior notes

These hold in both modes unless marked; in Reacharound mode Reacharound is the store, so "the app database" below means Reacharound's.

- **Replies are plain-text and sender-only.** CC recipients are displayed, not auto-included (reply-all is future work).
- **A retried reply is never sent twice.** The reply's attempt id and the unsent draft are kept per conversation for the browser tab's session, so after a lost answer a reload (or switching conversations) and sending again replays the same id, which the server dedupes.
- **Closing or marking spam:** self-hosted clears unread; Reacharound keeps the two flags apart (as its own Inbox does). The screen shows whichever the server did.
- **Attachments are metadata + on-demand signed links**, expiry driven by the API's `expires_at`. Expired links render as "no longer available."
- **Admin replies do not appear in your mail provider's Sent folder.** The app database is authoritative for outbound support mail.
- **Replies deliberately skip suppression lists** (an explicit human reply outranks an automated suppression), and hard bounces will feed whatever bounce webhook the host already runs.
- **(Self-hosted) Sync recovers missed or failed mail within the newest `SYNC_MAX_PAGES × SYNC_PAGE_SIZE` (250) inbound emails**, scanning every page up to the cap each run. Older gaps than that need Resend's dashboard. A host scheduler can automate sync by POSTing `{basePath}/sync` with an authorized credential.
- **HTML bodies render in a sandboxed iframe**: no `allow-scripts`, no `allow-same-origin`, default-deny CSP, remote images blocked by default (tracking pixels included) with per-message opt-in. Links escape the sandbox into normal tabs; opened tabs get no opener reference.

## Supply-chain rules for this repo

- No lifecycle scripts, ever (`postinstall` etc.). If a diff adds one, treat it as a red flag; never allowlist this package in pnpm's build-script gate.
- Runtime dependency surface stays `resend` + `drizzle-orm`; UI libs are peers the host already has. New transitive dependencies deserve scrutiny in the update diff.
- Public repo: 2FA on all committers, branch protection on `main`, no third-party apps with write access. Being public means installs need no auth tokens; it also means the update-diff review before bumping a SHA pin is the trust boundary — never skip it.

## Optional hardening (self-hosted)

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

CI (`.github/workflows/ci.yml`) runs both on Node 24 for every PR and every push to `main`.
