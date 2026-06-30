# libraries/growth-report-contract

The **Growth director's CEO-mode report contract output** — the output/presentation layer over the
shipped AcqROAS metric ([[../specs/growth-acquisition-roas-spine-report-contract]] Phase 1; M2 of
[[../goals/ceo-mode]]). Wraps `computeAcqROAS(group, window)` ([[acquisition-roas]]) +
`computeBlendedCacLtv(window)` ([[blended-cac-ltv]]) into the standard director **report contract**
([[director-report-contract]]) so the M4 CEO synthesizer can compose Growth alongside the other
directors. **Top-line is the BLENDED `blended_cac_ltv` row** (with `blended_payback_days` secondary)
— the Growth Director optimizes **one** blended number, not per-channel ROAS
([[../specs/growth-blended-cac-ltv-objective]] Phase 2). **One per-product AcqROAS row follows per
linked group with a Meta ad-account mapping**: AcqROAS, non-renewal new-customer revenue, channel
mix, week-over-week delta, and the do-NOT-cut guardrail flag.

**File:** `src/lib/growth-report-contract.ts`

## North star

The Growth agent **owns** "profitable new-customer acquisition"; **`blended_cac_ltv` is its proxy**
— named as such on `contract.proxy` ([[../goals/ceo-mode]] § "Role agents own the objective"). Per-line
AcqROAS is supporting detail / the do-NOT-cut surface, not the optimization target. The module flags
the degenerate move the proxy invites — cutting a proven SKU on **on-site ROAS < 1** alone when the
**halo-blended AcqROAS ≥ target** (the Amazon halo carries it) — as a **high-severity risk** + a
do-NOT-cut finding, never as a `recommended_action`. This is the Goodhart guardrail the spec requires.

**Cross-cutting do_not_cut (Phase 3).** A director-level finding fires when the BLENDED CAC:LTV ≥
target AND any per-channel on-site ROAS is < 1: `severity: "high"`, summary `do_not_cut: blended
CAC:LTV X× ≥ target Y× but per-channel on-site ROAS < 1 on {lines} — hold spend`. Lives on
`contract.findings`; the agent has no "cut" move to push to `recommended_actions`. Distinct from the
per-line halo-carries risk: this one compares the blended top-line (not the per-line halo-blended
AcqROAS) against the per-channel on-site ROAS, so it surfaces the cross-cutting trap even when a
single line's per-line halo-blended AcqROAS is itself below the per-line setpoint.

## Exports

### `buildGrowthReportContract(params): Promise<DirectorReportContract>` — function
```ts
buildGrowthReportContract({
  workspaceId, startDate, endDate,    // window, YYYY-MM-DD Central (AcqROAS snapshot boundaries)
  priorStartDate?, priorEndDate?,     // prior window → week-over-week delta (null without it)
  targetAcqRoas?,                     // per-line setpoint, default DEFAULT_ACQ_ROAS_TARGET (1.0)
  targetCacLtv?,                      // blended setpoint, default DEFAULT_BLENDED_CAC_LTV_TARGET (3×)
  targetPaybackDays?,                 // blended payback setpoint; null → row.target=null
  groupIds?,                          // default: every group with an ad-account mapping
})
```
- Calls `computeBlendedCacLtv` for the current (and optional prior) window → emits the **top-line
  `blended_cac_ltv` row + secondary `blended_payback_days` row** before any per-product row.
- Enumerates the **measurable product lines** (linked groups with a `product_ad_account_mappings` row),
  calls `computeAcqROAS` for the current (and optional prior) window per line, and builds one
  `MetricVsTarget` row + findings/risks each.
- `health_score` = `round(clamp(blended.cacLtvRatio / targetCacLtv, 0, 1) × 100)` (neutral 50 when
  the blended ratio is undefined).
- Surfaces `assumptions` (verbatim from [[blended-cac-ltv]]): `marginRoasBlockedOnCogs=true` (the
  COGS-deferred line — REVENUE-ROAS until CFO M1 COGS lands), `ltvProxyUncalibrated=true`,
  `paybackUsesWindowRateExtrapolation=true`, plus the per-line numerator/denominator definition and
  the shared-account floor caveat.

### `assembleGrowthReportContract(input): DirectorReportContract` — function

The **pure assembler** the unit test pins the wiring on (top-line first, payback second, per-line
after, assumptions appended, health from blended). Takes pre-computed `passes` +
`blendedCurrent`/`blendedPrior` and the three targets; no database. Used by `buildGrowthReportContract`
internally.

### `DEFAULT_ACQ_ROAS_TARGET` — const
`1.0` — the per-line break-even revenue-AcqROAS setpoint (ad spend recovered from new-customer revenue).

## Callers

- (planned) the M4 CEO synthesizer — reads this contract as the Growth director's weekly report.
- One-off scripts / the Growth director-agent pass can call it directly to render a contract.

## Tests

`src/lib/growth-report-contract.test.ts` — `npm run test:growth-report-contract`. Pins the assembler
wiring on fixture inputs without a database: blended row first + key `blended_cac_ltv`, payback row
second + `lower is better` note, per-line rows after, COGS-deferred + LTV-uncalibrated +
window-rate-extrapolation assumptions surfaced, `health_score` derived from the blended ratio
(100 when above target, proportional when below, 50 when null), no-mapping watch finding,
`contract.proxy === 'blended_cac_ltv'`, and the Phase 3 `do_not_cut` cross-cutting finding (fires
only when blended is healthy AND a per-channel on-site ROAS < 1; never appears in
`recommended_actions`).

## Gotchas

- **Revenue-ROAS, not margin-ROAS.** Every number is gross revenue ÷ spend until M1 COGS lands; stated
  in `assumptions`. Don't read it as profit.
- **Top-line is BLENDED, not per-line.** A consumer that reads `metrics_vs_target[0]` gets the
  Director's blended `blended_cac_ltv` number; the per-product AcqROAS rows are supporting detail.
- **`MetricVsTarget.status` is direction-agnostic.** For the payback row (lower is better) the
  `note` flags the inverted semantic; don't auto-interpret `status === "above"` as good.
- **Per-line "product line" = linked group with a Meta ad-account mapping.** Groups without a mapping
  are not measurable and are omitted (a `watch` finding fires when none exist).
- **On-site ROAS vs blended AcqROAS.** The guardrail compares on-site-only ROAS (`channelSplit.onsiteCents
  ÷ spendCents`) against the halo-blended `acqRoas`. The halo (`amazonCents`) only counts when the
  group's mapping sets `credit_amazon_to_meta` — see [[acquisition-roas]].
- **Validate before handing off.** Run `validateDirectorReportContract` ([[director-report-contract]])
  on the result before the synthesizer composes it.

---

[[../README]] · [[../../CLAUDE]] · [[acquisition-roas]] · [[blended-cac-ltv]] · [[director-report-contract]] · [[../goals/ceo-mode]] · [[../specs/growth-blended-cac-ltv-objective]]
