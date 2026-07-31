# Support Inbox — Setup Playbook (a real integration, start to finish)

A **chronological** walkthrough of how `@arvo/support-inbox` was actually
integrated into a production Next.js admin panel (OnlySearch: Next.js App
Router + Drizzle + Postgres, self-hosted on Coolify). It captures the real
order of operations **and the decisions/gotchas** at each step, so the next
team can follow the same path in their own admin panel.

For exact, copy-pasteable code and config, this playbook cross-links the
reference manual: [SupportInboxGuide.md](../SupportInboxGuide.md). Read this for
the *journey and the "why"*; read the guide for the *snippets*.

---

## Phase 0 — Decide the integration model

**Decision:** consume the package as a **SHA-pinned GitHub dependency**, not a
copied/vendored fork.

We briefly vendored the source in-repo (to freely restyle its UI), then
reversed course to the dependency model because it's the package's intended
shape: the engine stays external and updatable via a reviewed SHA bump, and you
own only a thin glue layer.

**Lesson:** decide this first. Vendoring gives total control but you lose clean
updates; the dependency keeps updates clean but you theme/extend through the
seams the package provides (or build your own UI — see Phase 8). We ended on the
dependency.

---

## Phase 1 — Install

1. Pin the dependency to a **commit SHA** in `package.json`
   (`github:Arvo-Devs/support-inbox#<sha>`), add `transpilePackages:
   ["@arvo/support-inbox"]`, and a Tailwind `@source` line. (Guide §2.)
2. Install the UI peers you're missing (`@base-ui/react`, `sonner`).

**Gotcha — peer versions.** The package declares peers (`next`, `lucide-react`,
…) newer than a typical app pins. You do **not** need to upgrade your app; add a
repo-level `.npmrc` with `legacy-peer-deps=true`. We specifically kept
`lucide-react` on the app's existing v0 — the package only uses icons present
there, so upgrading it (and risking every icon import in the app) was
unnecessary.

---

## Phase 2 — Database

1. Copy the package's `migrations/0001_support_inbox.sql` **verbatim** into your
   migration directory; apply with your runner. (Guide §3.)
2. If you're **replacing an existing inbox**, drop its tables first in a prior
   numbered migration so the package's tables land clean.

**Gotcha — SSL.** Our migration runners assumed managed-Postgres SSL; the
self-hosted Coolify Postgres rejects SSL. Match the runner's `ssl` option to
your database (we used `ssl: false`, same as the app's own DB handle). Apply to
**every** environment's DB (we did dev and prod).

---

## Phase 3 — Mount the engine (the glue)

Four small host files (Guide §4):
- **Server singleton** — supplies your Drizzle handle, Resend key, `fromEmail`,
  and `authorize`.
- **Admin API route** (`/api/admin/support/[...route]`) — forwards GET/POST to
  the package router.
- **Webhook route** (`/api/webhooks/resend-inbound`).
- **Admin page + client shell** — gates access, wraps the UI in a React Query
  provider + a `sonner` Toaster.

**Key point — `authorize` is the entire API auth boundary.** It returns the
acting admin or `null` (null → a bare 404, so the surface is invisible to
non-admins). Read the admin role **fresh per request** (not a cached session) so
a revoked admin loses access immediately. We wired it to the app's existing
permission check.

Then re-add whatever your admin panel needs: a `support` permission, a sidebar
link, a dashboard card.

---

## Phase 4 — Design tokens

The bundled UI is styled by CSS custom properties. Our app already had most
(shadcn-style tokens); we only added the **status** tokens (danger/warning/
success families) it uses. (Guide §5.)

---

## Phase 5 — Resend + email forwarding

1. Create a **full-access** Resend API key (sending-only keys can't read inbound
   mail) and a **managed inbound address** (`something@<id>.resend.app`, zero
   DNS) for testing. (Guide §7.)
2. Our public address lived in a **Google Workspace catch-all** mailbox
   (support@ + team@ + ads@ all landed together). We did **not** move MX;
   instead: a per-address Gmail **filter** forwarding `to:support@…` → the
   managed alias, plus `SUPPORT_ALIAS_MAP` so stored threads use the clean
   public address. (Guide §8, Path B.)
3. Set the env vars (`SUPPORT_RESEND_API_KEY`, `SUPPORT_FROM_EMAIL`,
   `SUPPORT_INBOUND_ADDRESSES`, `SUPPORT_ALIAS_MAP`, and — only for real-time —
   `SUPPORT_INBOUND_WEBHOOK_SECRET`) in `.env.local` **and** each deploy env.

**Lesson — Sync vs webhook.** Sync (pull) works with no public URL, great for
dev and as a fallback. Add the `email.received` webhook for real-time later.

---

## Phase 6 — Import historical mail (Google Takeout optional)

New mail flows via forwarding; anything already in Gmail is backfilled with a
one-time importer over a **Takeout `.mbox`** export. (Guide §12.)

Real decisions we made:
- **Pass Inbox + Sent together** so a conversation's inbound and its sent
  replies group into one thread (via `X-GM-THRID`).
- **Filter by support recipient** — the catch-all mailbox is mostly *not*
  support mail; only import threads where a support address appears in
  Delivered-To/To/Cc/From.
- **Scope call:** we imported *all* support-addressed threads (spam and all),
  accepting that some marketing/cold mail comes along, rather than only
  replied-to threads. Your call.
- Run **dry-run → small `--limit --apply` → full `--apply`**, on dev first, then
  prod (idempotent, so re-runs are safe).

---

## Phase 7 — Deploy (Docker / Coolify)

**Gotcha — the Docker build must resolve peers too.** A `Dockerfile` using
`npm ci` failed on the same peer conflict. Fix: **copy `.npmrc` into the deps
stage** and pass the flag explicitly:

```dockerfile
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --legacy-peer-deps
```

**Gotcha — the host type-checks the package source.** Because the package ships
`.ts` compiled via `transpilePackages`, `next build` type-checks it under your
`tsconfig`. A latent unused-param in the package failed our strict
`noUnusedParameters`. Because we owned the package repo, we fixed it upstream
(one line), pushed, and bumped the SHA — the canonical update flow. If you don't
own it, pin to a SHA that compiles cleanly under your settings.

We deploy `main` → prod and keep a `preview` branch/env; changes land on
`preview` first, then promote to `main`.

---

## Phase 8 — (Optional) Build your own UI on the REST API

We wanted the inbox to match our admin panel exactly, so we **stopped using the
bundled `SupportInboxPage`** and built our own UI against the package's REST API
(`/api/admin/support/*`), keeping the package as the **backend/engine only**.

Why this is safe and clean:
- The engine (routing, threading, ingest, reply, sync, schema) stays a pinned
  dependency and keeps improving on SHA bumps.
- Our UI depends only on the **API shape**, not the package's components — so a
  package UI redesign can never affect our look, and an API-shape change is
  caught at build time (our client is typed against a local copy of the wire
  DTOs).

What we built (all in our repo, scoped to the support page): a typed fetch
client + React Query hooks, a two-pane inbox (thread list + detail), message
bubbles, a reply box, status/search/sync — using our own component library.

**Must-not-regress when you DIY the UI:** port the package's **sandboxed HTML
email renderer** verbatim (iframe with no `allow-scripts`/`allow-same-origin`, a
default-deny CSP, remote images blocked by default). Rendering raw email HTML
any other way is an XSS hole. Also keep the **idempotent reply attempt-id**
(kept across failed sends, regenerated on success).

---

## Phase 9 — Extend the engine when the API is missing something

We needed **compose** (start a brand-new thread, not just reply). The API had no
such endpoint, and this is server-side work (Resend send + DB writes +
threading), so it belongs in the **engine, not the host UI**.

We added `POST {basePath}/threads` to the package — "reply, but create the
thread first," reusing the existing send-then-store + rollup machinery and
idempotency — with tests, pushed it, bumped the SHA, then built the "New
message" dialog in our own UI on top of it.

**Lesson:** if a feature needs Resend/DB/threading, add it to the package (it
owns those) and consume it via the API. Never reimplement the engine's internals
in your host app or write directly to its tables.

---

## The order, condensed

```
0. Choose dependency (SHA-pinned) over vendoring
1. Install + .npmrc(legacy-peer-deps) + transpilePackages + @source + peers
2. Copy migration; apply to every env (mind SSL); drop any old inbox first
3. Mount: singleton (authorize!), API route, webhook route, page + shell
4. Add missing design tokens
5. Resend full-access key + managed address; forward (aliasMap) or MX; env vars
6. Backfill history from Takeout mbox (dry-run → limit → full; dev then prod)
7. Docker: COPY .npmrc + npm ci --legacy-peer-deps; keep the SHA build-clean
8. (Optional) Build your own UI on the REST API — keep the HTML sandbox
9. Missing an endpoint? Add it to the package, bump the SHA, then build UI
```

Full snippets and config for every step: [SupportInboxGuide.md](../SupportInboxGuide.md).
