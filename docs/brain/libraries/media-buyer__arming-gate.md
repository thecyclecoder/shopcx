# libraries/media-buyer__arming-gate

Media Buyer **arming gate** — the deterministic authorization that a cohort's move from `mode='shadow'` (audit-only) to `mode='armed'` (executor may act) is warranted, for a given ISO week. Reads three preconditions ([[../tables/media_buyer_shadow_reviews]] AGREEMENT, [[../tables/media_buyer_sensor_trust]] GREEN STREAK, [[../libraries/blended-cac-ltv]] `cacLtvRatio` HEALTHY), evaluates the pure gate, upserts one [[../tables/media_buyer_arming_authorization]] row, and on deny escalates to the CEO via [[platform-director]] `escalateDiagnosisToCeo` + writes a Growth-owned [[../tables/director_activity]] row (`action_kind='media_buyer_arming_denied'`). Authored by [[../specs/media-buyer-arming-gate]] (Phase 1; M3 of [[../goals/autonomous-media-buyer-supervision]]).

**File:** `src/lib/media-buyer/arming-gate.ts`

**Callers:** a Growth-supervised box lane on cadence (dispatch surface pending — the Phase-1 artifact is the runner itself + the pure gate + the migration + tests). Once the executor arm-lane lands, the runner reads its own newest row and refuses to switch to `mode='armed'` on `allowed=false` or an expired row.

**Distinct from** [[media-buyer-publish-gate]] — that is an **at-publish** rail on a single ad-set's absolute daily budget (rejects a stray publish). This gate is a **weekly authorization** — rejects the whole cohort's move from shadow to armed. Different altitudes, different tables (`media_buyer_test_cohorts` vs `media_buyer_arming_authorization`), different rails.

**Distinct from** [[media-buyer__cold-scaler-arming-gate]] — that authorizes the COLD SCALER cohort's shadow→armed flip; this one authorizes the TEST cohort's flip. Same three preconditions, same denial-branch shape, disjoint samples (the scaler gate filters shadow reviews to `metadata.surface='cold_scaler'`). Two tables, two independent authorizations — the test rail's arm does NOT imply the scaler's, and vice versa. Introduced by [[../specs/bianca-cold-scaler-arming-gate-shadow-to-armed]] (Bianca M4).

## Exports

### `evaluateMediaBuyerArmingPure` — function (pure)

```ts
function evaluateMediaBuyerArmingPure(input: {
  shadowReviews: ShadowReviewInput[];
  trustSnapshots: TrustSnapshotInput[];
  blended: BlendedCacLtvResult;
}): EvaluateMediaBuyerArmingPureResult
```

Pure evaluation — no DB, no side effects. Returns `{ allowed, reasons: [{code, detail}], metrics }`. Each denial branch maps to one predicate; multiple failing preconditions surface every reason (the CEO card + audit row see the full list, not just the first). Unit tests pin each branch on fixture inputs.

### `runMediaBuyerArmingGate` — function (DB)

```ts
async function runMediaBuyerArmingGate(admin: Admin, input: {
  workspaceId: string;
  metaAdAccountId?: string | null;
  targetCacLtv?: number;
  now?: Date;
}): Promise<RunMediaBuyerArmingGateResult>
```

The DB-touching entry point. Loads the three preconditions in parallel, calls the pure gate, upserts one `media_buyer_arming_authorization` row keyed by `(workspace_id, meta_ad_account_id, iso_week)`, and on deny escalates + audits. Returns `{ status: 'allowed'|'denied', isoWeek, authorizationId, reasons, metrics, ceoEscalationEmitted }`.

### `isoWeekLabel` — function

```ts
function isoWeekLabel(d: Date): string
```

ISO 8601 week label (`YYYY-Www`, e.g. `2026-W28`) for the given `Date`. Used as the `iso_week` column value on the authorization row.

### Constants

- `ARMING_GATE_LOOKBACK_DAYS` (`14`) — sample window for all three preconditions.
- `MIN_REVIEWED_SHADOW_ACTIONS` (`20`) — reviewed shadow actions floor.
- `MIN_AGREEMENT_RATE` (`0.8`) — concur / reviewed floor.
- `MIN_CONSECUTIVE_GREEN_TRUST` (`7`) — consecutive `band='green'` snapshots floor (ending at the latest).

### Types

- `ShadowReviewInput` — `{ verdict: 'concur'|'dissent'|'undecided', reviewedAt: string }` — the subset the pure gate needs from a `media_buyer_shadow_reviews` row.
- `TrustSnapshotInput` — `{ snapshotDate: string, band: 'green'|'yellow'|'red' }` — the subset the pure gate needs from a `media_buyer_sensor_trust` row.
- `ArmingDenialReason` — the six branch codes: `insufficient_sample | low_agreement | trust_no_snapshots | trust_streak_short | blended_cac_ltv_below_target | blended_cac_ltv_unknown`.
- `ArmingGateReason` — `{ code: ArmingDenialReason, detail: string }` — one reason on the verdict.

## The three preconditions

| # | Precondition | Denial branches |
|---|---|---|
| 1 | AGREEMENT: ≥ `MIN_REVIEWED_SHADOW_ACTIONS` reviewed shadow actions in 14d AND concur rate ≥ `MIN_AGREEMENT_RATE` | `insufficient_sample`, `low_agreement` |
| 2 | SENSOR TRUST: ≥ `MIN_CONSECUTIVE_GREEN_TRUST` consecutive `band='green'` snapshots ending at the latest | `trust_no_snapshots`, `trust_streak_short` |
| 3 | BLENDED CAC:LTV: `cacLtvRatio ≥ targetCacLtv` (default `DEFAULT_BLENDED_CAC_LTV_TARGET` = 3) | `blended_cac_ltv_below_target`, `blended_cac_ltv_unknown` |

The gate is ALL-OR-NOTHING: every precondition must clear. A single failing predicate refuses the arm. That's the goal's "hitting a rail = escalate, not execute" north-star: the executor NEVER opts around a rail — it stays in shadow.

## The write / escalate contract on deny

1. **Upsert** one `media_buyer_arming_authorization` row (allowed OR denied — both paths write, so the row is the truth of the last evaluation).
2. **CEO escalation** via `escalateDiagnosisToCeo` (`escalationKind='media_buyer_arming_denied'`, `dedupeKey='media_buyer_arming_denied:{workspace}:{account|workspace}:{iso_week}'`). Dedupes to ONE OPEN card per `(workspace, account, iso_week)` — a re-run within the same week does NOT spam the CEO.
3. **Growth `director_activity`** row (`action_kind='media_buyer_arming_denied'`, `director_function='growth'`, `spec_slug='media-buyer-arming-gate'`) carrying `reasons`, `metrics`, `authorization_id`, `dedupe_key`, `iso_week`.

The write ORDER is UPSERT → ESCALATE → AUDIT. The escalation runs after the row is persisted so a partial deploy that has the runner but not the executor still leaves a durable authorization row (evidence) even if the escalation fails.

## Gotchas

- **Missing row = denied at the read site.** The executor treats "no row" the same as `allowed=false`. Do NOT introduce a lenient read that treats a missing row as "not yet evaluated" — that would silently arm on absence.
- **`meta_ad_account_id` is optional but load-bearing.** `null` returns / writes the workspace-wide row; a non-null account narrows both the shadow-review scope (joined to `director_activity.metadata.meta_ad_account_id`) and the sensor-trust scope. A per-account arming decision reads its OWN row, not the workspace fallback.
- **Consecutive green counts from the LATEST snapshot, not the historical max.** A yellow / red anywhere in the tail breaks the streak — the streak is anchored to today, not a lucky historical run.
- **Blended-CAC:LTV `null` is a distinct branch.** `blended_cac_ltv_unknown` fires when the ratio is `null` (no CAC / no LTV / no mapping). It is NOT the same as "below target" — the CEO card names WHICH failure so the fix (map an ad account vs. buy back margin) is unambiguous.
