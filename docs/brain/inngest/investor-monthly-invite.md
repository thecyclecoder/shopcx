# investor-monthly-invite

`src/lib/inngest/investor-monthly-invite.ts` — the monthly push behind the [[../lifecycles/investors-area]]. On the 20th it emails + texts every investor/owner a personal magic link to `/investors`, wrapped in a plain-language performance story.

## Triggers

- **`cron: "0 14 20 * *"`** — the 20th of each month, 14:00 UTC (~10am AST / 9am CDT).
- **`event: "investors/send-invites"`** — manual re-send. Optional `data`: `{ workspaceId?, onlyCustomerId?, skipSms? }` (limit to one workspace / one investor / suppress SMS — used for test sends).

## What it does

1. Resolve target workspaces — those with any `comp_role in ('investor','owner')` customer (or just `data.workspaceId`).
2. Per workspace: `buildInvestorPerformance(ws.id)` ([[../libraries/investor-update]]) from [[../tables/qb_pnl_snapshots]] (trailing-12 vs prior-12 windows). Skip if no snapshots.
3. Per investor/owner customer: mint a personal magic link (`generateInvestorMagicLink`, [[../libraries/investors-auth]]), send the email (`sendInvestorUpdateEmail` + `renderInvestorEmailHtml`) and, if a phone is on file, the SMS (`sendSMS` + `renderInvestorSms`).
4. `emitCronHeartbeat("investor-monthly-invite", …)` for Control Tower.

Returns `{ workspaces, emailed, texted, errors }`.

## Reads / writes

- **Reads:** `customers` (comp_role, email, phone, first_name), `qb_pnl_snapshots` (the performance numbers), `workspaces` (Resend/Twilio creds via the senders).
- **Writes:** none in the DB — it sends email (Resend) + SMS (Twilio) and a heartbeat. Idempotent enough to re-run: a duplicate fire just re-sends links (all valid).

## Registered

In `src/lib/inngest/registered-functions.ts` as `investorMonthlyInvite` (served by `src/app/api/inngest/route.ts`).

## Monitoring

Registered in [[../libraries/control-tower]] `MONITORED_LOOPS` (`id:'investor-monthly-invite'`, `kind:'cron'`, `owner:'platform'`, `expectedCadence:'monthly (0 14 20 * *)'`, `livenessWindowMs:32*DAY`, `registeredAt:'2026-07-10T16:15:05.108Z'`) — monitored for liveness by the [[../inngest/control-tower-monitor]] cron. A beat within 32 days (the full month window + 2-day grace) is green; silence beyond that is amber "awaiting first run" (never-fired grace) or red (stale). On the Control Tower dashboard, appears as a tile under "Monthly crons" pool.

## Gotchas

- **The email senders enforce sandbox** (`getResendClient(ws, toEmail)`) — a `sandbox_mode` workspace won't email non-member investors. Superfoods prod has sandbox off.
- **SMS only fires when `customers.phone` is set** — a missing phone silently skips SMS (email still goes).
- **"What we're building"** in the email is the curated `INVESTOR_BUILDING` list ([[../libraries/investor-update]]), not yet live-sourced from specs.

## Related

[[../lifecycles/investors-area]] · [[../libraries/investor-update]] · [[../libraries/investors-auth]] · [[../libraries/email]] · [[../integrations/twilio]] · [[monthly-revenue-snapshot]]
