# Portal account handoff + login chat + Help Center

**Goal:** Make the in-house portal (`portal.superfoodscompany.com`) the single account destination. The Shopify theme's account slide-out points there (auto-authenticating logged-in Shopify customers via a signed handoff, no second login), the drawer is redesigned around one CTA + an exciting "what you can do" showcase, the portal login page gets the live-chat widget for login-help, and the portal gains a searchable Help Center sidebar item that surfaces all KB articles in-app.

Phase legend: ⏳ planned · 🚧 in progress · ✅ shipped

**Status (2026-06-17): 🚧 app-side built, theme pending sign-off.** Built in worktree `worktree-portal-account-handoff`. Phases 1 (SSO handler), 3 (login chat), 4 (Help Center) code-complete + `tsc --noEmit` clean. Phase 2 theme drawer committed to theme-repo branch `account-portal-drawer` (commit `433ffb4`) and **merged into `homepage-rebuild`** (commit `daf424e`) — the standing preview branch with a connected unpublished theme (`theme-superfoodscompany.com/homepage-rebuild`, id `155796177069`), so it previews with no theme-connect step. **Awaiting Dylan sign-off before promotion to `master`.** Prereqs verified: `portal_config.minisite.custom_domain = portal.superfoodscompany.com`, `widget_enabled` + `chat_ticket_creation` = true. Note: `pushThemeFilesToTheme` was NOT built — the store's proven preview path is **branch-connect** (existing `ensureBranch`/`commitThemeFiles`; API theme-duplication unavailable), matching `homepage-rebuild`.

> 🔒 **Deploy gate:** the theme drawer change (Phase 2) must land on an **unpublished preview theme** and be **confirmed by Dylan** before it's committed to `master` (live). See "Phase 2 deploy gate" below. App-side phases (1/3/4) ship normally on the worktree branch.

---

## Context (verified 2026-06-17)

### The account slide-out (Shopify theme)
- **Drawer markup + behavior:** `snippets/account-drawer.liquid` (theme repo `thecyclecoder/theme-superfoodscompany.com@master`). Mounted once globally in `layout/theme.liquid:348`. Its own CSS: `assets/component-account-drawer.css`.
- **Already branches on login state in Liquid** — `{%- if customer -%}` renders the logged-in view (greeting + "View Orders" + "Manage Subscriptions" + Log out), `{%- else -%}` renders the logged-out view (two buttons routed through `…/customer_authentication/login?return_to=…`). **Login detection is pure Liquid; no round-trip needed.**
- **Trigger:** any element with class `.launch-account` is intercepted (inline `<script>` in the snippet) → `open()` slides the drawer; also exposes `window.accountDrawer = {open, close}`. Triggers today: header account icon (`sections/header.liquid:259`), mobile menu item (`snippets/header-drawer.liquid:139`), and footer "My Account" links (`sections/footer.liquid:~349`, JS rewrites `href→#` + adds `.launch-account`).
- **Current links:** logged-in → `https://account.superfoodscompany.com/orders` (Shopify extension) + `https://superfoodscompany.com/pages/portal`. These get replaced.
- Theme editing workflow: read from the GitHub repo (source of truth) → edit → `commitThemeFiles` → Shopify auto-deploys. See [[../recipes/edit-shopify-theme]].

### Portal auth + session (in-house)
- **App location:** `src/app/portal/[slug]/` (Next.js route group; `[slug]` = workspace `help_slug`). Login page `src/app/portal/[slug]/login/page.tsx` + `LoginClient.tsx`. Shell + sidebar `src/app/portal/[slug]/portal-client.tsx`. Sections in `src/app/portal/[slug]/_sections/`.
- **Custom-domain routing:** `portal.superfoodscompany.com` resolves via `portal_config.minisite.custom_domain` on the `workspaces` row; `src/lib/supabase/middleware.ts` rewrites host paths → `/portal/{slug}/…` (`purpose: "portal"`). Clean per-section URLs are whitelisted in a `PORTAL_SECTIONS` set in that middleware (`subscriptions, orders, rewards, payment-methods, support, account, resources`).
- **Login today:** OTP (`/api/portal/otp/{start,verify,resend}`) keyed on **email** (looked up `ILIKE` on `customers`), SMS-first w/ email fallback; plus **magic-link** (`/api/portal/magic-login`) and email-link escape hatch.
- **Session cookies (set on OTP verify or magic-login):** `portal_customer_id` (customer UUID), `portal_workspace_id` (workspace UUID), and signed `sx_session` (HMAC via `src/lib/auth-session.ts`). httpOnly, secure, sameSite=lax.
- **Identity → UUID:** `customers` table — `id` (UUID PK, used in cookies/URLs), `email`, `phone`, `shopify_customer_id` (TEXT, unique per `workspace_id`). Lookup helper: `findCustomer()` in `src/lib/portal/helpers.ts`. Linked accounts via `customer_links.group_id`.

### Magic-link handoff (the SSO bridge)
- `src/lib/magic-link.ts`: `generateMagicToken(customerId, shopifyCustomerId, email, workspaceId, expiryHours?)` → `base64url(payload).hmac(ENCRYPTION_KEY)`; `generateMagicLinkURL(...)` resolves the best host — **prefers `portal_config.minisite.custom_domain` → `https://{portalDomain}/login?token=…&next=…`** (bare `/login`, middleware rewrites). 24h default TTL.
- **The `/login?token=` page already auto-exchanges the token** (POST `/api/portal/magic-login` → verifies HMAC + expiry, confirms customer, sets `portal_customer_id` + `portal_workspace_id` cookies, redirects to `next` or `/`). This is exactly how `generatePaymentRecoveryLink` works hands-free today — proven path.
- **`next` is validated** server-side as a safe same-origin relative path (no open-redirect).

### App Proxy (the verified-identity channel)
- `src/lib/portal/auth.ts` → `requireAppProxy(req)`: verifies Shopify App Proxy HMAC (`SHOPIFY_APP_PROXY_SECRET`), returns `{ shop, loggedInCustomerId, workspaceId }`. `loggedInCustomerId` = Shopify's **verified** `logged_in_customer_id` query param (Shopify appends it automatically when a storefront customer is logged in). Workspace resolved from `shopify_myshopify_domain`.
- **Config confirmed** (`shopify-extension/shopify.app.toml` `[app_proxy]`): `prefix = "apps"`, `subpath = "portal-v2"`, `url = "https://shopcx.ai/api/portal"`. **No Shopify settings change needed.**
- **The App Proxy does NOT support a path tail after `/api/portal`** — everything must come in as a **query param**. That's why the dispatcher (`src/app/api/portal/route.ts`) routes by `?route={name}` against `routeMap` (e.g. `?route=supportList`). So SSO is **`/api/portal?route=sso`**, i.e. a new handler in `routeMap` — NOT a `/api/portal/sso` sub-route. Storefront link = `/apps/portal-v2?route=sso`.
- The dispatcher's `resolveAuth()` already branches on the presence of the `signature` query param → `requireAppProxy(req)`, so an App-Proxy hit lands in the handler with verified `{ loggedInCustomerId, workspaceId }`. Handlers return a `NextResponse`; the `sso` handler returns a **302** (App Proxy passes the `Location` header back to the browser, which follows it to the portal). The 4xx error-logging/ticket block in the dispatcher only fires on `status >= 400`, so a 302 is untouched.

### Chat widget (KB mini-site + storefront)
- **Anonymous-capable.** React page `src/app/widget/[workspaceId]/page.tsx`; embeddable bubble `public/widget.js` (`<script src="https://shopcx.ai/widget.js" data-workspace="{wsId}" async>`); storefront wrapper `src/app/(storefront)/_components/ChatOverlay.tsx` (iframe to `/widget/{wsId}?…`).
- **Backend (no auth required):** `POST /api/widget/[workspaceId]/messages` finds/creates `customers` + `widget_sessions` + a `channel="chat"` ticket; `GET` loads the thread. Config: `GET /api/widget/[workspaceId]/config`. CORS is `*` (and `proxy.ts` bypasses auth for `/widget/`, `/api/widget/`). Works for logged-out visitors — exactly the login-page case.
- Gating: workspace `widget_enabled` + `chat_ticket_creation` must be true. "Mini-site mirrors chat" rule applies (identical ticket messages).

### KB / Help Center
- **Table `knowledge_base`:** `id, workspace_id, title, content, content_html, category, slug, excerpt, published, active, view_count, helpful_yes/no, product_id`. RAG chunks + embeddings in `kb_chunks` (pgvector 1536). [[../tables/knowledge_base]].
- **Mini-site:** `src/app/help/[slug]/` (list `page.tsx`, single `[articleSlug]/page.tsx` renders `content_html` via `dangerouslySetInnerHTML` inside a `prose` wrapper; client filter `help-search.tsx`).
- **JSON API (no auth):** `GET /api/help/[slug]` → `{ workspace_name, articles[], categories{}, products[] }`, supports `?search=` (server-side `ilike` on title+content). `GET /api/widget/[workspaceId]/articles/[articleId]` → full single article. Semantic search exists for the AI agent (`retrieveContext()` in `src/lib/rag.ts`) but public search is keyword today.

---

## Phase 1 — Shopify → portal SSO endpoint ✅/⏳

**New `sso` handler** in `src/lib/portal/handlers/sso.ts`, registered in `routeMap` (`src/lib/portal/handlers/index.ts`). Reached via the App Proxy at storefront `/apps/portal-v2?route=sso` → `https://shopcx.ai/api/portal?route=sso&signature=…&shop=…&logged_in_customer_id=…`. The dispatcher's `resolveAuth()` verifies the signature (`requireAppProxy`) and hands the handler `auth = { shop, loggedInCustomerId, workspaceId }`. Handler logic:
1. If `auth.loggedInCustomerId`: look up `customers` by `workspace_id` + `shopify_customer_id` → `{ id, email }`.
   - Found → `const url = await generateMagicLinkURL(customer.id, auth.loggedInCustomerId, customer.email, auth.workspaceId, next)` and return `NextResponse.redirect(url, 302)` — lands on `portal.superfoodscompany.com/login?token=…`, which auto-exchanges.
   - Not found (no internal customer row yet) → 302 to bare portal home/login (they sign in normally).
2. If no `loggedInCustomerId` (logged-out / session expired between render & click) → 302 to bare `https://portal.superfoodscompany.com/`. (Normally the drawer's logged-out branch already renders the bare link, so this is defensive.)
- Invalid signature is handled upstream by the dispatcher (`requireAppProxy` throws → 401). Consider catching it in the handler path to 302 to bare login instead, so a stale/invalid click never shows an error — TBD in build.
- Accept an optional `next` passthrough (validated downstream by `magic-login`) so a CTA could deep-link (e.g. `/subscriptions`). Default `/`.
- **Security:** identity comes ONLY from the App-Proxy-verified `logged_in_customer_id`, never from a client-supplied param. Token is short-lived; never logged.

## Phase 2 — Theme: rewire + redesign the account drawer ⏳

Edit `snippets/account-drawer.liquid` (+ `assets/component-account-drawer.css`) and commit via `commitThemeFiles`.

- **Keep** the `.launch-account` interception + open/close JS untouched (header / mobile-menu / footer triggers keep working).
- **Logged-in (`{% if customer %}`):** replace the two buttons with **one primary CTA** → the App Proxy SSO route: `<a href="/apps/portal-v2?route=sso" class="account-drawer__btn account-drawer__cta">Go to My Account</a>`. Greeting stays. Log out stays.
- **Below the CTA — the "what you can do" showcase** (static Liquid + CSS, the exciting part): an attractive grid/list of portal capabilities so they *want* to click. Cards w/ icon + label + one-liner:
  - Manage subscriptions — skip, swap, change frequency or next date, pause
  - Track orders & shipments
  - Earn & redeem rewards points
  - Update payment methods
  - Browse the Help Center
  - Message support
- **Logged-out (`{% else %}`):** single CTA → `https://portal.superfoodscompany.com/` (no token) with copy like "Sign in to manage your account" + the same showcase (aspirational). They log in on the portal (chat widget there to help — Phase 3).
- Remove the `account.superfoodscompany.com` (extension) and `/pages/portal` links entirely.

### Phase 2 deploy gate — preview theme FIRST, `master` only on Dylan's confirm 🔒
**Hard requirement (Dylan, 2026-06-17):** do NOT commit the drawer change to `master` (which auto-deploys live). Land it on an **unpublished preview theme** first, give Dylan the preview URL, and promote to `master` only after he confirms it works.

Our model is "GitHub `master` → Shopify auto-deploys live MAIN", so a preview needs its own path. Recommended mechanism:
- **Push the 2 changed files directly to an unpublished preview theme via the Shopify Theme API** (the `write_themes` scope is present). Add a small helper `pushThemeFilesToTheme(workspaceId, themeId, changes[])` to `src/lib/shopify-theme.ts` (Shopify GraphQL `themeFilesUpsert` / REST asset PUT) — writes to a throwaway unpublished theme, NOT GitHub, so the single-writer invariant on `master` is untouched.
  - Step 1: duplicate/create an unpublished "ShopCX Preview — account drawer" theme from current live MAIN (or reuse an existing preview theme). Capture its theme id + preview URL.
  - Step 2: push `snippets/account-drawer.liquid` + `assets/component-account-drawer.css` to it.
  - Step 3: **pause and hand Dylan the preview URL.** Do not touch `master`.
- **Alternative** (if direct API push proves fiddly): commit the change to a theme-repo **branch** (not `master`) and connect an unpublished theme to that branch in Shopify admin (one manual step) for preview.
- **Promotion (after Dylan's 👍):** `commitThemeFiles(target /*master*/, [...], "Account drawer → portal SSO + capability showcase")` → live. Then delete the preview theme.
- The app-side work (Phases 1, 3, 4) is independent and ships on the normal Vercel/worktree branch → preview deployment; it does not wait on the theme gate, but the end-to-end SSO click can only be fully verified once both the deployed `sso` handler and the (preview) theme link coexist — test the SSO hop against the preview theme + a preview/prod deploy of the route.

## Phase 3 — Chat widget on the portal login page only ⏳

- Mount the existing widget on `src/app/portal/[slug]/login/` **only** (not the authenticated portal — Support section already covers logged-in help).
- Embed: render the iframe to `/widget/{workspaceId}?path=/login` (the login page already loads workspace branding server-side, so `workspace.id` is in scope), or drop the `widget.js` bubble. Prefer the iframe/`ChatOverlay`-style mount for styling control; reuse the storefront pattern.
- No auth needed (widget endpoints are anonymous). Confirm Superfoods workspace has `widget_enabled` + `chat_ticket_creation` = true.
- Purpose: help people who can't log in (wrong email, no code received) reach a human/AI without being locked out. Page-context `path=/login` lets the agent see it's a login issue.

## Phase 4 — Help Center sidebar item in the portal ⏳

- **Add nav item** to `NAV_ITEMS` in `src/app/portal/[slug]/portal-client.tsx`: `{ id: "help", label: "Help Center", icon: … }` (place above/below Support).
- **Add `"help"` to the `PORTAL_SECTIONS` set** in `src/lib/supabase/middleware.ts` so `/help` gets a clean URL rewrite like the other sections.
- **New `src/app/portal/[slug]/_sections/HelpCenterSection.tsx`** (mirror `ResourcesSection`/`SupportSection` structure):
  - Fetch articles via the existing `GET /api/help/[slug]?search=` (no new endpoint needed; reuse). Pass the workspace `help_slug` from server props.
  - Searchable list (server `?search=` or client filter on title+excerpt), grouped by `category`. Cards: title + excerpt + category.
  - On click, render the full article **inline** (no leaving the portal) — fetch `GET /api/widget/[workspaceId]/articles/[articleId]` (or `/api/help/[slug]` already returns bodies) and render `content_html` in a `prose` wrapper, reusing the mini-site render pattern (trusted HTML, admin-authored).
  - Match portal styling (`--portal-primary`).
- Optional enhancement (not required v1): wire semantic search via `retrieveContext()` for better matching.

## Files

| File | Change |
|---|---|
| `src/lib/portal/handlers/sso.ts` | **new** — `sso` handler: App-Proxy-verified id → mint magic token → 302 to portal |
| `src/lib/portal/handlers/index.ts` | register `sso` in `routeMap` |
| theme `snippets/account-drawer.liquid` | rewire to portal SSO; 1 CTA + capability showcase (both states) — **preview theme first** |
| theme `assets/component-account-drawer.css` | styles for CTA + showcase grid — **preview theme first** |
| `src/lib/shopify-theme.ts` | **new helper** `pushThemeFilesToTheme(...)` — write files to an unpublished preview theme via Shopify API (for the preview gate) |
| `src/app/portal/[slug]/login/*` | mount chat widget on login page only |
| `src/app/portal/[slug]/portal-client.tsx` | add "Help Center" nav item |
| `src/app/portal/[slug]/_sections/HelpCenterSection.tsx` | **new** — searchable in-portal KB browser |
| `src/lib/supabase/middleware.ts` | add `help` to `PORTAL_SECTIONS` |
| `docs/brain/lifecycles/customer-portal.md` | + SSO handoff, login chat, Help Center sections |
| `docs/brain/recipes/edit-shopify-theme.md` | (touch only if drawer becomes a reference example) |
| `docs/brain/integrations/shopify.md` | note `/api/portal/sso` App Proxy endpoint |

## Decisions / open questions

1. ~~**App Proxy subpath / route shape**~~ — ✅ resolved 2026-06-17: `prefix=apps`, `subpath=portal-v2`, `url=https://shopcx.ai/api/portal`. App Proxy can't take a path tail after `/api/portal`, so SSO is a **query-param route**: theme CTA href = `/apps/portal-v2?route=sso`, handled by a new `sso` entry in `routeMap` (`/api/portal?route=sso`). **No Shopify settings change.**
2. **`portal.superfoodscompany.com` wired?** — verify `workspaces.portal_config.minisite.custom_domain = "portal.superfoodscompany.com"` for Superfoods so `generateMagicLinkURL` + middleware resolve it. If not set, set it (or fall back to the `help_slug.shopcx.ai` host).
3. **Token TTL for SSO** — default 24h is fine (link is generated at click time, used immediately). Keep default.
4. **Customer with no internal `customers` row** — SSO falls back to plain portal login (OTP). Acceptable; the OTP path will create/lookup as today.
5. **Showcase copy/visual** — Phase 2 needs final capability list + icons; draft above, refine with Dylan.

## Brain coverage (on ship)

Fold into [[../lifecycles/customer-portal.md]] (SSO handoff + login chat + Help Center), [[../integrations/shopify]] (SSO App Proxy route), and delete this spec. Theme drawer change is reversible via `git revert` on the theme repo.

## Related

[[../lifecycles/customer-portal]] · [[../lifecycles/help-center]] · [[../recipes/edit-shopify-theme]] · [[../integrations/shopify]] · [[../libraries/magic-link]] · [[../libraries/portal__auth]] · [[../tables/knowledge_base]]
