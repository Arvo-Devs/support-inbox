# Support Inbox Integration Guide (`@arvo/support-inbox`)

A portable, step-by-step guide to adding a self-hosted support-email inbox to
**any Next.js (App Router) admin panel**, using the [`@arvo/support-inbox`](https://github.com/Arvo-Devs/support-inbox)
package. Customers email your public support address; your admins read and reply
to threads inside your own admin panel. Built on [Resend receiving](https://resend.com/docs/dashboard/receiving/introduction);
Postgres + Drizzle for storage.

This guide covers the whole lifecycle: install → database → mounting → design →
env → Resend → email forwarding → importing historical mail from Google Takeout
→ deploy. OnlySearch is used as the concrete example, but every step is generic.

---

## 0. Mental model

The package is split into two layers, and you own the boundary between them:

- **The engine (the dependency).** All the logic: REST API routing, RFC-5322
  threading, inbound ingest, reply/send, sync, webhook verification, the DB
  schema, and a ready-made UI (`SupportInboxPage`). You consume this as a
  pinned dependency and never edit it.
- **The host glue (your code, ~5 small files).** A server singleton that
  supplies your DB handle + auth + config, three route files that mount the
  package's handlers, and one admin page. Plus a copied migration and a few
  env vars.

Everything below is either "install the engine" or "write the glue."

---

## 1. Requirements

- **Next.js App Router + React 19**, `@tanstack/react-query` v5.
- **Postgres + `drizzle-orm`.** You pass the package a Drizzle handle with a
  working `.transaction`; it never opens its own connection.
- **Resend account with a full-access API key** (sending-only keys cannot read
  inbound mail).
- **Tailwind CSS v4** for the bundled UI.

---

## 2. Install the dependency

Pin to a **commit SHA** (immutable — a branch/tag can move under you):

```jsonc
// package.json
"dependencies": {
  "@arvo/support-inbox": "github:Arvo-Devs/support-inbox#<full-commit-sha>"
}
```

The package ships TypeScript source (no build step), so the host compiles it:

```ts
// next.config.ts / next.config.mjs
transpilePackages: ["@arvo/support-inbox"],
```

### 2a. Peer dependencies

The package's bundled UI uses `@base-ui/react` and `sonner`, and declares peers
for `next`, `react`, `lucide-react`, `@tanstack/react-query`, `clsx`,
`class-variance-authority`, `tailwind-merge`. Install what you're missing:

```bash
npm install @base-ui/react sonner
```

If your app pins **older** major versions of a peer than the package requests
(a common case with `lucide-react`), you do **not** need to upgrade — the
package only uses widely-available symbols. Tell npm to allow the version skew
with a repo-level `.npmrc`:

```ini
# .npmrc
legacy-peer-deps=true
```

> This one file matters for **every** install path — local, CI, and Docker.
> See §11 for the Docker specifics.

### 2b. Let Tailwind see the package's classes

Tailwind v4 ignores `node_modules` by default. Add a `@source` line to your
Tailwind entry stylesheet so it generates the utility classes the package uses:

```css
/* globals.css */
@import "tailwindcss";
@source "../../node_modules/@arvo/support-inbox/src"; /* path relative to THIS file */
```

---

## 3. Database

The package can't run migrations against your DB — you copy its DDL into your
own migration directory and apply it with your runner.

1. Copy `node_modules/@arvo/support-inbox/migrations/0001_support_inbox.sql`
   **verbatim** into your migrations folder (add a `-- copied from …` header).
   It creates three tables: `support_threads`, `support_messages`,
   `support_attachments`. It is idempotent (`CREATE TABLE IF NOT EXISTS`), so
   re-applying is safe.
2. Apply it with your migration tooling. If you don't have one, a minimal
   standalone runner (reads `.env.local`, dry-run by default, `--apply` to
   execute) is shown in [§12 Appendix A](#appendix-a--minimal-migration-runner).

> Upgrades: the package ships additive numbered migrations. On a version bump,
> copy any new ones the same way and apply them.

---

## 4. Mount the engine (the host glue)

### 4a. Server singleton

The single place you wire your DB, auth, and config. Lazy so nothing touches
env or the DB at build time.

```ts
// src/server/support/inbox.ts
import { createSupportInbox } from "@arvo/support-inbox";
import { db } from "@/db";                       // your Drizzle handle (.transaction required)
import { checkPermission } from "@/server/.../accessControl"; // your admin-auth fn

let cached: ReturnType<typeof createSupportInbox> | null = null;

function parseAddresses(v?: string) {
  const list = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined; // undefined = accept all inbound
}
function parseAliasMap(v?: string) {
  const map: Record<string, string> = {};
  for (const pair of (v ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i === -1) continue;
    const alias = pair.slice(0, i).trim();
    const publicAddr = pair.slice(i + 1).trim();
    if (alias && publicAddr) map[alias] = publicAddr;
  }
  return map;
}

export function getSupportInbox() {
  if (!cached) {
    cached = createSupportInbox({
      db,
      resendApiKey: process.env.SUPPORT_RESEND_API_KEY ?? "",
      fromEmail: process.env.SUPPORT_FROM_EMAIL ?? "Acme Support <support@example.com>",
      inboundAddresses: parseAddresses(process.env.SUPPORT_INBOUND_ADDRESSES),
      aliasMap: parseAliasMap(process.env.SUPPORT_ALIAS_MAP),
      webhookSecret: process.env.SUPPORT_INBOUND_WEBHOOK_SECRET ?? "",
      // authorize is the ENTIRE API auth boundary. Read the admin role fresh on
      // every call (not a cached session) so a revoked admin loses access
      // immediately. Return null => the route answers a bare 404,
      // indistinguishable from an unknown route, so the surface stays invisible
      // to non-admins. Returning an actor lets replies record who sent them.
      authorize: async () => {
        const access = await checkPermission("support");
        if (!access.hasAccess || !access.user) return null;
        return { id: access.user.id, email: access.user.email, name: access.user.username };
      },
      // optional: link a sender to their user/org page in the thread view
      // lookupCustomer: async (email) => ({ label, href }) | null,
    });
  }
  return cached;
}
```

### 4b. Admin API route (catch-all)

```ts
// src/app/api/admin/support/[...route]/route.ts
import { getSupportInbox } from "@/server/support/inbox";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (req: Request) => getSupportInbox().routeHandlers.GET(req);
export const POST = (req: Request) => getSupportInbox().routeHandlers.POST(req);
```

Default `basePath` is `/api/admin/support`. To mount elsewhere, pass
`basePath` in the config **and** move this route to match.

### 4c. Inbound webhook route

```ts
// src/app/api/webhooks/resend-inbound/route.ts
import { getSupportInbox } from "@/server/support/inbox";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (req: Request) => getSupportInbox().webhookHandler.GET(req);
export const POST = (req: Request) => getSupportInbox().webhookHandler.POST(req);
```

The webhook verifies the Resend/svix signature itself; it answers `503` while
`webhookSecret` is unset, so it's safe to deploy before you configure it.

### 4d. Admin page + client shell

The page gates access; the client shell provides the React Query context and a
`sonner` Toaster the UI needs.

```tsx
// src/app/admin/support/page.tsx
import { redirect } from "next/navigation";
import { checkPermission } from "@/server/.../accessControl";
import { SupportInboxClient } from "./SupportInboxClient";

export default async function SupportInboxAdminPage() {
  const access = await checkPermission("support");
  if (!access.hasAccess) redirect("/admin");
  return <SupportInboxClient />;
}
```

```tsx
// src/app/admin/support/SupportInboxClient.tsx
"use client";
import { Toaster } from "sonner";
import { QueryProvider } from "@/context/QueryProvider"; // any QueryClientProvider wrapper
import { SupportInboxPage } from "@arvo/support-inbox/client";

export function SupportInboxClient() {
  return (
    <QueryProvider>
      <div className="h-[calc(100vh-9rem)]">
        <SupportInboxPage /> {/* defaults to basePath /api/admin/support */}
      </div>
      <Toaster richColors position="top-right" />
    </QueryProvider>
  );
}
```

### 4e. Admin nav + permission

Add a `support` permission to whatever role/permission system your admin panel
uses, gate the route on it, and add a sidebar link + dashboard card to
`/admin/support`. `authorize` in §4a reads this same permission.

---

## 5. Design tokens

The bundled UI is styled entirely with CSS custom properties. If your app
already defines a design system (shadcn-style tokens), you likely have most of
these: `--color-card`, `--color-muted`, `--color-muted-foreground`,
`--color-foreground`, `--color-border`, `--color-input`, `--color-primary`,
`--color-primary-foreground`, `--color-ring`.

You'll usually need to add the **status** tokens (used by the inbox's Badge and
error states). Add to your Tailwind `@theme` + `:root` + `.dark`:

```css
/* @theme inline { … } */
--color-danger: var(--danger);
--color-danger-strong: var(--danger-strong);
--color-danger-soft: var(--danger-soft);
--color-danger-border: var(--danger-border);
--color-warning-strong: var(--warning-strong);
--color-warning-soft: var(--warning-soft);
--color-warning-border: var(--warning-border);
--color-success-strong: var(--success-strong);
--color-success-soft: var(--success-soft);
--color-success-border: var(--success-border);

/* :root (light) */
--danger: #e11d48; --danger-strong: #9f1239;
--danger-soft: color-mix(in oklab, var(--danger) 9%, var(--card));
--danger-border: color-mix(in oklab, var(--danger) 25%, var(--card));
--warning: #b45309; --warning-strong: #92400e;
--warning-soft: color-mix(in oklab, var(--warning) 9%, var(--card));
--warning-border: color-mix(in oklab, var(--warning) 28%, var(--card));
--success: #059669; --success-strong: #047857;
--success-soft: color-mix(in oklab, var(--success) 9%, var(--card));
--success-border: color-mix(in oklab, var(--success) 25%, var(--card));
/* .dark: brighten the hues a step (see the package's styles/tokens.css) */
```

Alternatively, import the package's bundled defaults **once** (only if your app
does NOT already define the base tokens, or import order will clobber yours):
`@import "@arvo/support-inbox/styles/tokens.css";`

> **Using a completely different design system?** The package routes every UI
> primitive through one seam file (`src/ui/ui-deps.ts`). Adapting to your own
> components means editing that one file — which requires vendoring/forking the
> package rather than consuming it as a pure dependency. As a plain dependency
> you get its Base-UI look, themed by the tokens above.

---

## 6. Environment variables

| Variable | Purpose |
| --- | --- |
| `SUPPORT_RESEND_API_KEY` | **Full-access** Resend key (server-only). Prefer a dedicated per-app key. |
| `SUPPORT_FROM_EMAIL` | Outbound sender, e.g. `Acme Support <support@example.com>`. Domain must be verified in Resend for sending. |
| `SUPPORT_INBOUND_ADDRESSES` | Comma-separated public address(es) that create tickets. Empty = accept all. |
| `SUPPORT_ALIAS_MAP` | `alias=public` pairs for forwarding setups (see §8). |
| `SUPPORT_INBOUND_WEBHOOK_SECRET` | `whsec_` of the `email.received` webhook. Only needed for real-time push. |

Set these in `.env.local` for dev **and** in your deploy platform's env for
each environment (they must be present at build/runtime, not just locally).

---

## 7. Resend setup

1. **Full-access API key** → `SUPPORT_RESEND_API_KEY`.
2. **Dev (zero DNS):** create a **managed inbound address**
   (`something@<id>.resend.app`). Mail to it is retrievable via the inbox's
   **Sync** button — no public URL or webhook needed, so the full flow works on
   localhost.
3. **Prod:** either verify your domain and enable receiving (one MX record),
   **or** keep your existing mail provider and forward per-address into a
   managed alias (§8).

---

## 8. Email forwarding / receiving

Two ways for mail sent to your public address to reach Resend:

### Path A — MX straight to Resend (fresh domains / no existing mailbox)
Point the domain's MX at Resend and enable receiving. `SUPPORT_INBOUND_ADDRESSES`
is your public address; no alias map needed.

### Path B — Domain already has mailboxes (Gmail/Workspace) — forward, don't move MX
If the domain's MX already points at Google (or another provider), do **not**
repoint it. Forward per-address instead:

1. Create a managed alias in Resend: `support@<id>.resend.app`.
2. In Gmail/Workspace, add that alias as a **forwarding address** (Settings →
   Forwarding). Google emails a confirmation code to it — retrieve the code via
   the inbox's **Sync** button or Resend's *Received* tab, then confirm.
3. Create a **filter** (not mailbox-wide auto-forward): `to:support@example.com`
   → forward to the alias. A scoped filter matters when the mailbox is a
   **catch-all** (e.g. `support@`, `team@`, `ads@` all land in one inbox) — you
   only want the support address forwarded.
4. Set the alias map so stored threads use the clean public address:
   ```ini
   SUPPORT_INBOUND_ADDRESSES=support@example.com
   SUPPORT_ALIAS_MAP=support@<id>.resend.app=support@example.com
   ```
   Forwarding can rewrite headers; the alias map keys routing on the envelope
   (`received_for`) so the stored `inbound_address` stays deterministic.

Notes: your provider keeps a backup copy of everything it forwards; admin
replies are sent via Resend and won't appear in your provider's Sent folder
(the app DB is authoritative for outbound support mail).

---

## 9. Real-time (webhook) vs. Sync

- **Sync** pulls recent inbound mail through Resend's list API. Works with no
  public URL — ideal for dev and as a resilient fallback. A scheduler can
  automate it by POSTing `{basePath}/sync` with an authorized credential.
- **Webhook (real-time):** in Resend, add an endpoint
  `https://<host>/api/webhooks/resend-inbound` subscribed to `email.received`,
  and put its signing secret in `SUPPORT_INBOUND_WEBHOOK_SECRET`. Each Resend
  endpoint has its **own** `whsec_`; never reuse another endpoint's secret.

---

## 10. Launch checklist (per install)

The inbox is admin-only from day one (`authorize` gates every route) and boots
safely when unconfigured (webhook `503`s, page shows an empty inbox). The gate
is rollout **order** — wire the real public address last:

1. Deploy with the inbox mounted, configured against a managed
   `@<id>.resend.app` test address. No customer mail can arrive yet.
2. Send one real email (through your actual forwarding path, if any); confirm
   the thread appears via Sync or webhook.
3. Reply from the inbox; confirm it arrives threaded in the sender's client;
   reply back and confirm same-thread ingestion.
4. Only then point the real public address at it (MX or the forwarding rule).

---

## 11. Docker / CI builds

If you build in Docker or CI with `npm ci`, two things must line up so the
install step resolves the package's peer deps:

1. **Copy `.npmrc` into the install stage** (it carries `legacy-peer-deps`), and
2. **pass the flag explicitly** on `npm ci` (belt-and-suspenders):

```dockerfile
# deps stage
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --legacy-peer-deps
```

Confirm `.npmrc` is **not** excluded by your `.dockerignore`. Because the
package ships `.ts` source compiled via `transpilePackages`, your host's
`tsconfig` type-checks that source during `next build` — so the package must
pass your strictness settings (e.g. `noUnusedParameters`). Keep the package on a
SHA that compiles cleanly under your config.

---

## 12. Importing historical mail from Google Takeout

New mail flows in via forwarding/webhook, but anything already in Gmail predates
the cutover and must be backfilled directly. **Google Takeout → Mail** exports
`.mbox` files (e.g. `Inbox.mbox`, `Sent.mbox`) that retain Gmail's `X-GM-THRID`
(thread id), `X-Gmail-Labels`, and `Delivered-To` headers — enough to reconstruct
threads, direction, and routing faithfully.

A one-time importer (see [Appendix B](#appendix-b--google-takeout-mbox-importer))
parses those files and writes rows that match what the package's own ingest
produces. Key behaviors:

- **Pass multiple files together** (Inbox + Sent) so a conversation's inbound
  mail and its sent replies — which Takeout splits across files — group into one
  thread via `X-GM-THRID`.
- **Recipient filter:** a catch-all mailbox contains far more than support mail.
  Only import threads where a support address appears in any message's
  `Delivered-To`/`To`/`Cc`/`From`.
- **Direction:** the `Sent` label marks outbound; everything else is inbound.
- **Skips** Draft/Spam/Trash.
- **Idempotent:** each message gets a synthetic `gmail:<message-id>` value on the
  unique index, and threads use a deterministic `gmail-<thrid>` id, so re-runs
  skip already-imported mail.
- **Attachments are not imported** (the package's attachment viewer fetches from
  Resend; Takeout attachments were never there). Bodies (text + HTML) import.
- Imported threads land `open` and `read`, so a backfill doesn't flood the
  unread badge.

Run it dry (no writes) first, then a small `--limit` batch to eyeball in the
panel, then the full import:

```bash
node scripts/import-mbox.mjs "Inbox.mbox" "Sent.mbox"                 # dry run
node scripts/import-mbox.mjs "Inbox.mbox" "Sent.mbox" --limit 50 --apply
node scripts/import-mbox.mjs "Inbox.mbox" "Sent.mbox" --apply
```

---

## Appendix A — minimal migration runner

A standalone runner pattern (reads `.env.local`, dry-run by default, `--apply`
to execute, `--prod` to target a prod connection string). Match the `ssl` option
to your database — self-hosted Postgres often needs `ssl: false`; managed
providers may require SSL.

```js
// scripts/migrate.mjs (sketch)
import fs from "node:fs"; import path from "node:path"; import pg from "pg";
// load .env.local into process.env …
const sql = fs.readFileSync(path.resolve("migrations/0001_support_inbox.sql"), "utf8");
const apply = process.argv.includes("--apply");
const prod = process.argv.includes("--prod");
const conn = prod ? process.env.DB_URL_PROD : process.env.DB_URL_DEV;
if (!apply) { console.log(sql); process.exit(0); }
const client = new pg.Client({ connectionString: conn, ssl: false });
await client.connect();
await client.query("BEGIN");
try { await client.query(sql); await client.query("COMMIT"); }
catch (e) { await client.query("ROLLBACK"); throw e; }
await client.end();
```

## Appendix B — Google Takeout mbox importer

Add a one-time importer as `scripts/import-mbox.mjs` in your **consuming
project** (not the package). A working reference implementation is maintained in
the OnlySearch repo; the importer is host-side tooling, so it lives with the app
that owns the database, not with this package. It depends on `pg`,
`mbox-reader`, and `mailparser` (dev deps). It reads support-address config from
env
(`SUPPORT_MATCH_ADDRESSES`/`SUPPORT_INBOUND_ADDRESSES`, `SUPPORT_ALIAS_MAP`,
`SUPPORT_FROM_EMAIL`) and writes directly to `support_threads`/
`support_messages`, replicating the package's field mapping (subject
normalization, snippet/body truncation, threading, direction). See §12 for its
behavior and run commands.

---

## Updating the package

The two repos are decoupled — nothing changes in your app until you opt in:

1. Review `git diff <old-sha>..<new-sha>` in the package repo.
2. Bump the SHA in `package.json`; `npm install` (with `legacy-peer-deps`).
3. If the diff adds a numbered migration, copy + apply it (§3).
4. If it changes the `SupportInboxConfig` contract, adjust your singleton (§4a).
5. Commit the updated lockfile.
