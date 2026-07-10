# investor-update

`src/lib/investor-update.ts` — turns the [[../tables/qb_pnl_snapshots]] numbers into a **non-technical performance story** (what's working / what needs help / what we're building) and renders the monthly investor email + SMS. Consumed by [[../inngest/investor-monthly-invite]]. Part of the [[../lifecycles/investors-area]].

## Exports

- `buildInvestorPerformance(workspaceId, admin?)` → `InvestorPerformance | null` — pulls the snapshots and computes **trailing-12-month** figures (revenue + YoY vs the prior 12, economic profit direction, ad efficiency = sales per $1 of ad spend, refund+chargeback rate, fixed-cost trend), then generates plain-English `working[]` / `needsHelp[]` bullets by rule from the deltas. Null if no snapshots. Uses TTM windows (not single-month) so the story is stable month-to-month; needs ≥24 months for the YoY comparison and degrades gracefully below that.
- `INVESTOR_BUILDING: string[]` — the curated "what we're doing about it" list. The one hand-maintained part of the email. **Follow-up:** source from the live specs board.
- `renderInvestorEmailHtml({ firstName, link, perf })` → email-client-safe HTML (inline styles + tables, light theme): headline, one-tap magic-link button (×2), the three bullet sections.
- `renderInvestorSms(perf, link)` → short SMS with the headline number + link.

All framing is deliberately jargon-free (e.g. "for every $1 on ads we made $X in sales", "profit once we add back the intercompany fee" is shown as "underlying profit"). Profit uses `adjusted_net_income` (economic profit); the tax-strategy booked line stays in the charts, not belabored in prose.

## Callers

- [[../inngest/investor-monthly-invite]] (monthly email + SMS). The email HTML is also what the first hand-sent invite used.

## Related

[[../lifecycles/investors-area]] · [[../tables/qb_pnl_snapshots]] · [[email]] · [[../integrations/twilio]]
