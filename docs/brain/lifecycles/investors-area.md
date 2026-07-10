# Investors area (magic-link financial portal)

A private, READ-ONLY financial portal at **`/investors`** that renders the exact CFO Financials charts ([[../functions/cfo]]) to the company's **investors + owners**. Structurally a sibling of the password-gated [[showcase]], but the gate is a per-person **magic link** instead of a shared password, and a monthly cron pushes each investor a fresh link wrapped in a plain-language performance story.

**Who sees it:** any customer whose `comp_role` is `investor` or `owner` ([[../tables/customers]]). Same enum that drives comp subscriptions — one flag, two uses. Currently: David Stecher (`investor`), Alan Gold (`investor`), Dylan Ralston (`owner`).

## The pieces

| Piece | File | Role |
|---|---|---|
| Auth primitives | [[../libraries/investors-auth]] (`src/lib/investors/auth.ts`) | `investors_session` cookie mint/verify, `generateInvestorMagicLink`, `isInvestorRole` |
| Magic token | [[../libraries/magic-link]] (`src/lib/magic-link.ts`) | The emailed link carries the app's standard signed `generateMagicToken` (40-day TTL) — reused, not reinvented |
| Gate | `src/proxy.ts` (investors branch) | Early-return branch: `/investors/*` needs a valid `investors_session` cookie except `/investors/enter` + `/investors/expired`; `/api/investors/*` pass through (they self-auth) |
| Entry | `src/app/investors/enter/route.ts` | GET: verify magic token → re-check `comp_role` → set cookie → redirect to `/investors` (else `/investors/expired`) |
| Area | `src/app/investors/{layout,page}.tsx` + `investors.css` | Greets the viewer, renders `<CfoFinancials endpoint="/api/investors/pnl" />` — the **same 11-chart component** as the CFO director page |
| Data | `src/app/api/investors/pnl/route.ts` | Cookie-gated clone of `/api/director/cfo/pnl` — same qb_pnl_snapshots select |
| Self-service | `src/app/investors/expired/page.tsx` + `src/app/api/investors/request/route.ts` | "email me a fresh link" — always returns ok (never reveals who's on the list) |
| Narrative | [[../libraries/investor-update]] (`src/lib/investor-update.ts`) | Turns the numbers into what's-working / needs-help / what-we're-building bullets + the email HTML + SMS |
| Senders | [[../libraries/email]] `sendInvestorUpdateEmail` / `sendInvestorLinkEmail`; [[../integrations/twilio]] `sendSMS` | Deliver the email + text |
| Monthly push | [[../inngest/investor-monthly-invite]] | Cron on the **20th** (+ `investors/send-invites` event) — one email + text per investor |

## The flow

1. **Tag.** A customer gets `comp_role='investor'|'owner'` (script `scripts/_seed-investor-owners.ts`, or any comp-role write). That single flag is the whole allowlist.
2. **Monthly push (the 20th).** [[../inngest/investor-monthly-invite]] finds every investor/owner, builds the performance story from [[../tables/qb_pnl_snapshots]] (trailing-12 vs prior-12), mints a personal magic link (`…/investors/enter?token=…`), and sends the email ([[../libraries/investor-update]] `renderInvestorEmailHtml`) + SMS (`renderInvestorSms`).
3. **Click.** The link hits `/investors/enter` → `verifyMagicToken` → re-check `comp_role` (a revoked investor can't ride an old link in) → set signed httpOnly `investors_session` cookie (30-day) → redirect to `/investors`.
4. **View.** The proxy sees the cookie and serves `/investors`; the page renders the charts, fed by cookie-gated `/api/investors/pnl`.
5. **Lapsed link.** Anything missing/expired → `/investors/expired`, where they can request a fresh link (`/api/investors/request` → `sendInvestorLinkEmail`).

## Why magic-link (not password)

Showcase uses one shared password for a broad "friends" audience. Investors are a **named, tiny, sensitive** list — a per-person signed token means access is individual (revoke = flip `comp_role`), there's nothing to remember or leak-by-sharing, and the same monthly email that carries the numbers carries the key.

## Design notes / gotchas

- **The link IS the credential.** Personal, non-forwardable (re-checked against `comp_role` at click time). The 40-day token TTL is deliberately longer than the 30-day cookie so last month's email still works if this month's send is late.
- **`/api/investors/*` must stay un-gated in the proxy** — otherwise the supabase auth flow redirects them to `/login`. They do their own cookie + role check. Same pattern as `/api/showcase/unlock`.
- **Charts are reused, not copied.** `CfoFinancials` grew one optional prop (`endpoint`, default `/api/director/cfo/pnl`); the investors page passes `/api/investors/pnl`. "Same charts, same separators" is literally the same component.
- **Sandbox safety.** The email senders pass `recipientEmail` to `getResendClient`, so a workspace in `sandbox_mode` won't send to non-member investor addresses. Superfoods prod has sandbox off.
- **"What we're building" is a curated list** (`INVESTOR_BUILDING` in [[../libraries/investor-update]]) — the one hand-maintained part of the auto-email. **Follow-up:** source it from the live specs board so it stays current without edits.
- **Performance uses trailing-12-month windows**, not single-month deltas, so the story is stable month-to-month (needs ≥24 snapshots for the YoY comparison; degrades gracefully below that).

## Related

[[showcase]] · [[../functions/cfo]] · [[../tables/qb_pnl_snapshots]] · [[../tables/customers]] · [[../libraries/investors-auth]] · [[../libraries/investor-update]] · [[../libraries/magic-link]] · [[../inngest/investor-monthly-invite]] · [[../integrations/twilio]] · [[../integrations/resend]]
