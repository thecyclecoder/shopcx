# libraries/growth-report-contract

The **Growth director's CEO-mode report contract output** — the output/presentation layer over the
shipped AcqROAS metric ([[../specs/growth-acquisition-roas-spine-report-contract]] Phase 1; M2 of
[[../goals/ceo-mode]]). Wraps `computeAcqROAS(group, window)` ([[acquisition-roas]]) into the standard
director **report contract** ([[director-report-contract]]) so the M4 CEO synthesizer can compose Growth
alongside the other directors. **One metric row per product line** (linked group with a Meta ad-account
mapping): AcqROAS, non-renewal new-customer revenue, channel mix, week-over-week delta, and the
do-NOT-cut guardrail flag.

**File:** `src/lib/growth-report-contract.ts`

## North star

The Growth agent **owns** "profitable new-customer acquisition"; **AcqROAS is its proxy** — named as
such on `contract.proxy` ([[../goals/ceo-mode]] § "Role agents own the objective"). The module flags the
degenerate move the proxy invites — cutting a proven SKU on **on-site ROAS < 1** alone when the
**halo-blended AcqROAS ≥ target** (the Amazon halo carries it) — as a **high-severity risk** + a
do-NOT-cut finding, never as a `recommended_action`. This is the Goodhart guardrail the spec requires.

## Exports

### `buildGrowthReportContract(params): Promise<DirectorReportContract>` — function
```ts
buildGrowthReportContract({
  workspaceId, startDate, endDate,    // window, YYYY-MM-DD Central (AcqROAS snapshot boundaries)
  priorStartDate?, priorEndDate?,     // prior window → week-over-week delta (null without it)
  targetAcqRoas?,                     // setpoint, default DEFAULT_ACQ_ROAS_TARGET (1.0)
  groupIds?,                          // default: every group with an ad-account mapping
})
```
- Enumerates the **measurable product lines** (linked groups with a `product_ad_account_mappings` row),
  calls `computeAcqROAS` for the current (and optional prior) window per line, and builds one
  `MetricVsTarget` row + findings/risks each.
- `health_score` = share of measurable lines at/above target × 100 (50 when nothing scored).
- Surfaces `assumptions`: **revenue-ROAS** (contribution-margin ROAS is a declared dependency on M1
  COGS — not yet available), the numerator/denominator definition, and the shared-account floor caveat.

### `DEFAULT_ACQ_ROAS_TARGET` — const
`1.0` — the break-even revenue-AcqROAS setpoint (ad spend recovered from new-customer revenue).

## Callers

- (planned) the M4 CEO synthesizer — reads this contract as the Growth director's weekly report.
- One-off scripts / the Growth director-agent pass can call it directly to render a contract.

## Gotchas

- **Revenue-ROAS, not margin-ROAS.** Every number is gross revenue ÷ spend until M1 COGS lands; stated
  in `assumptions`. Don't read it as profit.
- **Per-line "product line" = linked group with a Meta ad-account mapping.** Groups without a mapping
  are not measurable and are omitted (a `watch` finding fires when none exist).
- **On-site ROAS vs blended AcqROAS.** The guardrail compares on-site-only ROAS (`channelSplit.onsiteCents
  ÷ spendCents`) against the halo-blended `acqRoas`. The halo (`amazonCents`) only counts when the
  group's mapping sets `credit_amazon_to_meta` — see [[acquisition-roas]].
- **Validate before handing off.** Run `validateDirectorReportContract` ([[director-report-contract]])
  on the result before the synthesizer composes it.

---

[[../README]] · [[../../CLAUDE]] · [[acquisition-roas]] · [[director-report-contract]] · [[../goals/ceo-mode]]
