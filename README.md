# @infra-agent/support-inbox

A self-hosted support-email inbox built on [Resend receiving](https://resend.com/docs/dashboard/receiving/introduction). Customers email your public support address; admins read and answer threads inside your own dashboard. Each project **imports and self-hosts** the package: its own DB tables, its own webhook endpoint and secret, its own Resend domain. Nothing is shared between installs, and improvements ship via a version bump that each host adopts on its own schedule.

## Requirements

- **Postgres + drizzle-orm.** The host passes a drizzle handle (`PgDatabase`) with a working `.transaction` — the package never opens its own connection.
- **Resend** with a **full-access API key.** This is non-negotiable: sending-only keys cannot read inbound mail (the inbound list/get APIs and attachment links all require full access). Keep it server-only and prefer a dedicated per-app key so rotation stays isolated from your product-email key.
- **@tanstack/react-query** in the host app (the client components use it).
- **The ui-deps seam.** `src/ui/ui-deps.ts` is the only file that uses host path aliases: it expects `@/components/ui/*` primitives (Badge, Button, Card, ConfirmDialog, EmptyState, ErrorMessage, Input, Textarea) plus `cn` from `@/lib/utils`, and `toast` from sonner. Adapting to a different design system means editing exactly that file.

## Mounting (in-repo)

While the package lives in this monorepo there is no build step — the host compiles the TypeScript source directly:

1. **tsconfig path alias + include glob** (already present in `apps/dashboard/tsconfig.json`):

   ```jsonc
   "paths": { "@support-inbox/*": ["../../packages/support-inbox/src/*"] },
   "include": ["../../packages/support-inbox/src/**/*.ts", "../../packages/support-inbox/src/**/*.tsx"]
   ```

2. **Workspace dependency** on `@infra-agent/support-inbox` in the host's `package.json` (brings in `resend`; `drizzle-orm` is shared).

3. **Three host files** wire everything up (see `apps/dashboard/src/server/support/inbox.ts` and the two routes for the canonical example):

   **Server singleton** — lazy so nothing touches env or the DB at module-eval/build time:

   ```ts
   // src/server/support/inbox.ts
   let cached: ReturnType<typeof createSupportInbox> | null = null;
   export function getSupportInbox() {
     if (!cached) {
       cached = createSupportInbox({
         db: getAdminDb(),            // root handle; .transaction guaranteed
         resendApiKey: env.SUPPORT_RESEND_API_KEY || env.RESEND_API_KEY || "",
         fromEmail: env.SUPPORT_FROM_EMAIL || "...",
         inboundAddresses: [...],     // optional; undefined = accept all
         aliasMap: {...},             // optional; managed alias -> public address
         webhookSecret: env.SUPPORT_INBOUND_WEBHOOK_SECRET || "",
         authorize,                   // (req: Request) => Promise<actor | null>
         lookupCustomer,              // optional customer link in thread view
       });
     }
     return cached;
   }
   ```

   **REST route handler** at the basePath (default `/api/admin/support`):

   ```ts
   // src/app/api/admin/support/[...route]/route.ts
   import { getSupportInbox } from "@/server/support/inbox";
   export const runtime = "nodejs";
   export const GET = (request: Request) => getSupportInbox().routeHandlers.GET(request);
   export const POST = (request: Request) => getSupportInbox().routeHandlers.POST(request);
   ```

   **Webhook route** — same pattern with `webhookHandler`:

   ```ts
   // src/app/api/webhooks/resend-inbound/route.ts
   export const GET = (request: Request) => getSupportInbox().webhookHandler.GET(request);
   export const POST = (request: Request) => getSupportInbox().webhookHandler.POST(request);
   ```

4. **Admin page** rendering `<SupportInboxPage />` from `@support-inbox/client`, plus (optionally) `<SupportUnreadBadge />` next to the nav label.

**`authorize` is the entire API auth boundary.** Page-level layout gates (like `/admin`'s) protect pages only; the REST and webhook routes rely entirely on the config's `authorize`. It receives the raw `Request` and returns the acting admin (`{ id, email?, name? }`) or `null`. Null renders a bare 404 **indistinguishable from an unknown route**, so the surface stays invisible to non-admins. Read the role fresh from the DB on every call (not from the session) so a revoked admin loses access on their next request. Returning an actor rather than a boolean lets replies store `actor_id` and a denormalized `actor_label` without joining your user table.

## Database

Copy `migrations/0001_support_inbox.sql` **verbatim** — with a `-- copied from @infra-agent/support-inbox migrations/0001_support_inbox.sql` header — into the host's migration directory and let the host's migration runner apply it. Upgrades ship additive numbered migrations (`0002_...`, `0003_...`) that hosts copy the same way; the files are idempotent so re-application is safe.

Three tables: `support_threads`, `support_messages`, `support_attachments`. RLS is **deliberately disabled** on all three: the inbox is an instance-admin surface with no tenant context, so no org scoping applies. That is also why the config takes the root/admin DB handle.

## Resend setup

### Dev (zero DNS)

1. In Resend, create a **managed inbound address** — you get `something@<id>.resend.app` immediately, no DNS.
2. Email it from any account, then press the inbox's **Sync** button. Sync pulls inbound mail through Resend's list API, so **no public URL or webhook is needed** — the full flow works on localhost.

### Prod

1. Verify your domain in Resend and enable receiving (MX), or use Gmail forwarding to a managed address (next section).
2. Add a webhook endpoint `https://<host>/api/webhooks/resend-inbound` subscribed to **`email.received`**.
3. Put that endpoint's signing secret in `SUPPORT_INBOUND_WEBHOOK_SECRET`. Every Resend webhook endpoint has its **own** `whsec_` — do not reuse the secret of another endpoint (e.g. a bounce/suppression webhook).

### Environment variables

| Variable | Purpose |
| --- | --- |
| `SUPPORT_RESEND_API_KEY` | Full-access Resend key (sending-only cannot read inbound mail). Falls back to `RESEND_API_KEY` in this repo's wiring. |
| `SUPPORT_FROM_EMAIL` | Outbound sender, e.g. `Infra Agent Support <support@infraagent.app>`. |
| `SUPPORT_INBOUND_ADDRESSES` | Comma-separated public addresses that create tickets. Empty = accept all inbound. |
| `SUPPORT_ALIAS_MAP` | `alias=public` pairs, comma-separated — managed-alias routing for Gmail forwarding. |
| `SUPPORT_INBOUND_WEBHOOK_SECRET` | `whsec_` of the `email.received` webhook pointing at `/api/webhooks/resend-inbound`. |

## Routing infraagent.app mail via Gmail forwarding

The public domain keeps its Google Workspace mailboxes; Workspace keeps receiving and spam-filtering, and forwards support mail into Resend:

- Use **per-address forwarding only** — a Gmail filter (`to:support@infraagent.app` → forward) or a Workspace Admin routing rule per address. **Never enable mailbox-wide auto-forwarding**: it forwards *everything* in that mailbox, not just support mail.
- Forward **each public address to its own distinguishable managed alias** (e.g. `support@…` → `support@<id>.resend.app`, `contact@…` → `contact@<id>.resend.app`) and set `SUPPORT_ALIAS_MAP` accordingly. Forwarding can rewrite or drop headers; the alias map keys routing on the envelope (`received_for`) so the stored `inbound_address` stays deterministic regardless of header handling.
- Gmail's forwarding-confirmation code email lands in Resend, not in a mailbox — find it via the **Sync** button or the dashboard's Received tab and enter the code in Gmail.
- Gmail keeps a backup copy of everything it forwards, so nothing is lost if the app is down.
- A fresh domain with no mailboxes can skip all of this and point MX straight at Resend — the code path is identical (`received_for` covers forwarded mail too, so both setups converge).

## Behavior notes

- **Replies are plain-text and sender-only.** CC recipients are displayed on messages, but reply-all is a v1.1 item.
- **Attachments are metadata + on-demand signed links.** The DB stores filename/type/size; clicking fetches a short-lived signed URL from Resend. Expiry is driven by the API's `expires_at` — never a hard-coded window — and expired links render as "no longer available".
- **Admin replies do not appear in Gmail's Sent folder.** Outbound mail goes through Resend; the app database is authoritative for outbound support mail.
- **Hard-bounced replies feed the host's Resend suppression webhook** when one exists (e.g. `/api/webhooks/resend`), which will suppress that address for other product email too. Known and accepted: an address that hard-bounces support mail will bounce product mail as well.
- **Replies deliberately do not consult suppression lists.** A human explicitly replying to a customer outranks an automated suppression entry.
- **v1 sync is the manual button.** A host scheduler can automate it by POSTing `{basePath}/sync` on a cron with an authorized session/credential.

## Supply-chain defaults (once extracted to its own repo)

- Install pinned to a **commit SHA**: `"@infra-agent/support-inbox": "github:<owner>/support-inbox#<sha>"`, with `--frozen-lockfile` builds. Tags are human-readable markers only — the SHA is the pin.
- Updating = review `git diff <old-sha>..<new-sha>`, bump the SHA, `pnpm install`, commit the lockfile.
- The package **never has lifecycle scripts** (no postinstall) and must never be allowlisted in pnpm 10's build-script gate. If an update suddenly needs one, treat that as a red flag.
- Dependency surface stays `resend` + `drizzle-orm` + peers (react, next, @tanstack/react-query, lucide-react, sonner). New transitive dependencies deserve scrutiny in the diff.
- Repo hygiene: private repo, 2FA/passkey on all committers, branch protection on main, no third-party apps with write access.

## Optional hardening (not built in v1)

The package runs on whatever DB handle you give it. To cap the blast radius of a bad package version, create a per-project `support_inbox` postgres role granted **only** the three support tables and build the drizzle handle for this package from that role's connection string:

```sql
CREATE ROLE support_inbox LOGIN PASSWORD '...';
GRANT SELECT, INSERT, UPDATE, DELETE ON support_threads TO support_inbox;
GRANT SELECT, INSERT, UPDATE, DELETE ON support_messages TO support_inbox;
GRANT SELECT, INSERT, UPDATE, DELETE ON support_attachments TO support_inbox;
-- No other grants: a compromised version could touch support data,
-- but never users, API keys, or billing.
```

## HTML viewer security posture

Inbound HTML bodies render inside a **sandboxed iframe** with no `allow-scripts` and no `allow-same-origin`, under a default-deny CSP. Remote images are blocked by default (tracking pixels included) with a per-message opt-in to load them.
