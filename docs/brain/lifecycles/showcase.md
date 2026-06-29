# Showcase lifecycle

A password-gated, investor/friend-facing **narrative** section under `/showcase`. Read-only, self-contained static prose explaining how ShopCX works — no DB reads, no internal API calls, no live data, no secrets. The flagship writeup is the **Autonomous CTO** (the AI Platform/DevOps director and its agent fleet).

## Route map

The section is a small hierarchy so more director/system writeups slot in later as siblings:

| Route | What | Gated? |
|---|---|---|
| `/showcase` | Top index — one-line framing + category cards | ✅ |
| `/showcase/autonomy` | Category index ("Autonomy") — lists director writeups; today just the CTO card | ✅ |
| `/showcase/autonomy/cto` | **Flagship** — the five-section DevOps explainer (spec/brain · pipeline · the build-box engine · supervision · agent fleet) with inline SVG diagrams | ✅ |
| `/showcase/unlock` | Password form (posts to the unlock API) | ❌ (must be reachable to authenticate) |
| `/api/showcase/unlock` | Route handler — validates password, sets the signed cookie, redirects | ❌ |

Add a new director writeup as `/showcase/autonomy/{slug}` (e.g. `growth`, `cx`) — a new card in `src/app/showcase/autonomy/page.tsx` + a new page dir. Add a whole new category as `/showcase/{category}` + a card in `src/app/showcase/page.tsx`.

## Files

- `src/lib/showcase/auth.ts` — the gate primitives. Shared password (read at request time), HMAC-signed session token mint/verify (constant-time), constant-time password check. **No brain library page** — it's a small `src/lib/showcase/*` leaf, not a top-level `src/lib/*.ts`.
- `src/proxy.ts` — the gate itself (see below).
- `src/app/api/showcase/unlock/route.ts` — POST handler; `runtime = "nodejs"` (needs `crypto`).
- `src/app/showcase/layout.tsx` — self-themed shell (own light/dark token set scoped to `.showcase-root`, pre-paint theme script, topbar + theme toggle).
- `src/app/showcase/showcase.css` — the scoped design system (`sc-*` classes + `--sc-*` tokens). Diagrams read the same tokens via `sc-svg-*` classes so they adapt to theme.
- `src/app/showcase/ThemeToggle.tsx` — client toggle (`useSyncExternalStore`, no setState-in-effect).
- `src/app/showcase/page.tsx`, `src/app/showcase/autonomy/page.tsx`, `src/app/showcase/autonomy/cto/page.tsx`, `src/app/showcase/autonomy/cto/diagrams.tsx` — the pages + inline SVG diagrams.

## The gate (how it's scoped)

The app's only proxy/middleware is `src/proxy.ts` (Next.js 16 renamed `middleware` → `proxy`). Its matcher is **global** (negative-lookahead over all non-asset paths), so `/showcase/*` already hits it. The showcase gate is a **single early branch at the very top of `proxy()`**:

1. `/api/showcase/unlock` → `NextResponse.next()` (let the handler run; without this the supabase auth flow would 307 it to `/login`).
2. `/showcase` or `/showcase/...` (except `/showcase/unlock`) → require a valid signed cookie (`verifyShowcaseToken`); if absent/invalid, **redirect to `/showcase/unlock?from=…`**.
3. `/showcase/unlock` → `NextResponse.next()` (the form must be reachable).

The branch **returns early** for every showcase path, so it never reaches the bot-UA neutralization, the storefront/subdomain rewrites, or `updateSession` (supabase auth). **No other route's behavior changed** — for any non-showcase path the branch falls through untouched and the original proxy logic runs exactly as before. The branch only fires when `pathname === "/showcase"` or `pathname.startsWith("/showcase/")` (or is the unlock API).

### Cookie / token

Signed httpOnly cookie `showcase_session`, value `<issuedAtMs>.<hmac-sha256>`. Signed with `SHOWCASE_COOKIE_SECRET` → falls back to `ENCRYPTION_KEY` → a derived constant (POC). Verified constant-time + 14-day expiry window. The cookie holds **no secret** — it's a signed "you knew the password" proof. `secure` in production, `sameSite=lax`, `path=/`.

## Env vars (set in Vercel)

| Var | Required? | Purpose |
|---|---|---|
| `SHOWCASE_PASSWORD` | **Set in Vercel before sharing externally.** | The shared access phrase. **If unset, the gate falls back to the documented dev default `superfoods` and logs a warning** — fine for the POC, not for a real audience. |
| `SHOWCASE_COOKIE_SECRET` | Optional | HMAC signing key for the session cookie. Falls back to `ENCRYPTION_KEY`, then a constant. Set a dedicated value for a real audience. |

## Theming

The app forces light globally (`globals.css` makes Tailwind's `dark:` class-based and never adds `.dark`). The showcase ships its **own** token set under `.showcase-root` and toggles dark via a `.showcase-dark` class on that root — set pre-paint by an inline script (saved choice → else OS preference), flipped by the client `ThemeToggle`. This is fully isolated from the rest of the app. Mobile-friendly (responsive grid + TOC collapses under 960px).

## Status / open work

✅ Shipped — gate + index + autonomy category + the Autonomous CTO flagship (four sections, inline SVG diagrams, light+dark, mobile). Not box-impacting (Next.js app / Vercel) — deploys via Vercel on merge. **Action item:** set `SHOWCASE_PASSWORD` in Vercel before sharing the link.
