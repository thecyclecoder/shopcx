# libraries/media-buyer__cold-scaler-arming-gate

Cold-scaler **arming gate** — the deterministic authorization that a scaler cohort's move from `mode='shadow'` (audit-only) to `mode='armed'` (executor may move budget) is warranted, for a given ISO week. Reads three preconditions ([[../tables/media_buyer_action_grades]] SCALE-vocabulary PASS RATE, [[../tables/media_buyer_sensor_trust]] GREEN STREAK, [[../libraries/blended-cac-ltv]] `cacLtvRatio` HEALTHY), evaluates the pure gate, upserts one [[../tables/media_buyer_cold_scaler_arming_authorization]] row, and on deny escalates to the CEO via [[platform-director]] `escalateDiagnosisToCeo` + writes a Growth-owned [[../tables/director_activity]] row (`action_kind='cold_scaler_arming_denied'`). Authored by [[../specs/bianca-cold-scaler-arming-gate-shadow-to-armed]] (Phase 2; M4 of [[../goals/bianca-temperature-aware-campaign-structure]]); Precondition #1 rewritten by [[../specs/cold-scaler-arming-decides-on-evidence-not-absence]] Phase 3 to judge Bianca on graded outcomes instead of shadow reviews she can no longer produce.

**File:** `src/lib/media-buyer/cold-scaler-arming-gate.ts`

**Callers:** a Growth-supervised box lane on cadence (dispatch surface pending — the Phase-2 artifact is the runner itself + the pure gate + tests + brain pages). The graduate-crowned-winners spec (Bianca M4 follow-on) reads `readLatestColdScalerArmingAuthorization` at the budget-move site and refuses to graduate a winner when the row is missing, `allowed=false`, or expired.

**Distinct from** [[media-buyer__arming-gate]] — that authorizes the TEST cohort's shadow→armed flip; this one authorizes the COLD SCALER cohort's flip. Both gates share sensor-trust + CAC:LTV; **Precondition #1 differs on purpose**. The TEST gate reads shadow-vs-review agreement (a test cohort still runs in shadow, so the sample is producible). The SCALER gate reads Bianca's live SCALE-vocabulary grade pass rate (Bianca stopped running in shadow weeks ago, so the shadow-review sample is unproducible and the graded-outcomes sample is what actually exists — 288 rows on Dylan's account today). Two tables, two independent authorizations. The test rail's arm does NOT imply the scaler's, and vice versa.

## Exports

### `evaluateColdScalerArmingPure` — function (pure)

```ts
function evaluateColdScalerArmingPure(input: {
  gradedScaleActions: GradedScaleActionInput[];
  trustSnapshots: TrustSnapshotInput[];
  cacLtv: CacLtvInput;
}): EvaluateColdScalerArmingPureResult
```

Pure evaluation — no DB, no side effects. Returns `{ allowed, reasons: [{code, detail}], metrics }`. Each denial branch maps to one predicate; multiple failing preconditions surface every reason (the CEO card + audit row see the full list, not just the first). The pure gate re-filters `gradedScaleActions` to `SCALE_ACTION_KINDS` so a KILL grade (`media_buyer_paused_loser`) leaked in by a bad caller cannot lift the verdict. Unit tests pin each branch on fixture inputs.

### `runColdScalerArmingGate` — function (DB)

```ts
async function runColdScalerArmingGate(admin: Admin, input: {
  workspaceId: string;
  metaAdAccountId?: string | null;
  coldScalerCohortId: string;
  targetCacLtv?: number;
  now?: Date;
}): Promise<RunColdScalerArmingGateResult>
```

The DB-touching entry point. Loads the three preconditions in parallel, calls the pure gate, upserts one `media_buyer_cold_scaler_arming_authorization` row keyed by `(workspace_id, meta_ad_account_id, cold_scaler_cohort_id, iso_week)`, and on deny escalates + audits. Returns `{ status: 'allowed'|'denied', isoWeek, authorizationId, reasons, metrics, ceoEscalationEmitted }`.

### `readLatestColdScalerArmingAuthorization` — function (DB, read)

```ts
async function readLatestColdScalerArmingAuthorization(admin: Admin, input: {
  workspaceId: string;
  metaAdAccountId?: string | null;
  coldScalerCohortId: string;
}): Promise<ColdScalerAuthorizationRow | null>
```

The graduate-crowned-winners chokepoint. Returns the newest row for the trio, or `null`. Callers treat a null row / an `allowed=false` row / a row past `expires_at` as DENIED — the Bianca M4 "arming rail must be human-vetoable" contract encoded at the read site. Do NOT introduce a lenient read that treats a missing row as "not yet evaluated" — that would silently arm on absence.

### `isoWeekLabel` — function

```ts
function isoWeekLabel(d: Date): string
```

ISO 8601 week label (`YYYY-Www`, e.g. `2026-W28`) for the given `Date`. Used as the `iso_week` column value on the authorization row.

### Constants

- `ARMING_GATE_LOOKBACK_DAYS` (`14`) — sample window for all three preconditions.
- `MIN_GRADED_SCALE_ACTIONS` (`20`) — minimum SCALE-vocabulary graded actions in the window before the pass rate is trustworthy. Kept at 20 (the same floor the retired shadow-review branch used) so the evidence threshold does not shift with the input source.
- `MIN_SCALE_PASS_RATE` (`0.8`) — minimum `passing / graded` ratio, where "passing" means `overall_grade >= SCALE_GRADE_PASS_THRESHOLD`.
- `SCALE_GRADE_PASS_THRESHOLD` (`7`) — the `overall_grade` floor a SCALE-vocabulary grade must clear to count as a pass. Matches the Growth-Director-brief's 7/10 "sound decision" band.
- `SCALE_ACTION_KINDS` — the tuple `['media_buyer_promoted_winner', 'media_buyer_replenished_test_cohort']`. The two [[../tables/director_activity]] verbs that MOVE budget into or up on a scaler cohort — the judgement the gate authorises. `media_buyer_paused_loser` is deliberately excluded so Bianca's kill skill cannot vouch for her promote skill.
- `MIN_CONSECUTIVE_GREEN_TRUST` (`7`) — consecutive `band='green'` snapshots floor (ending at the latest).
- `DEFAULT_COLD_SCALER_CAC_LTV_TARGET` (`3`, sourced from `DEFAULT_BLENDED_CAC_LTV_TARGET`) — CAC:LTV target the gate compares against; overridable per-call.

### Types

- `GradedScaleActionInput` — `{ actionKind: ScaleActionKind, overallGrade: number, gradedAt: string }` — the subset the pure gate needs from a [[../tables/media_buyer_action_grades]] row. `actionKind` MUST be one of `SCALE_ACTION_KINDS` — the pure gate re-filters as a defense against a bad caller.
- `ScaleActionKind` — `'media_buyer_promoted_winner' | 'media_buyer_replenished_test_cohort'` — the element type of `SCALE_ACTION_KINDS`.
- `TrustSnapshotInput` — `{ snapshotDate: string, band: 'green'|'yellow'|'red' }` — the subset the pure gate needs from a `media_buyer_sensor_trust` row.
- `CacLtvInput` — `{ cacLtvRatio: number | null, target: number, unknownFlags?: string[] }` — decoupled from `BlendedCacLtvResult` so the future Phase-8 `media_buyer_cold_scaler_cac_ltv_snapshot` row can feed the same shape.
- `ColdScalerArmingDenialReason` — the six branch codes: `insufficient_graded_scale_actions | scale_grade_below_bar | trust_no_snapshots | trust_streak_short | cac_ltv_below_target | cac_ltv_unknown`.
- `ColdScalerArmingReason` — `{ code: ColdScalerArmingDenialReason, detail: string }` — one reason on the verdict.

## The three preconditions

| # | Precondition | Denial branches |
|---|---|---|
| 1 | SCALE-VOCABULARY PASS RATE: ≥ `MIN_GRADED_SCALE_ACTIONS` graded rows for `SCALE_ACTION_KINDS` in 14d AND the fraction with `overall_grade >= SCALE_GRADE_PASS_THRESHOLD` ≥ `MIN_SCALE_PASS_RATE` | `insufficient_graded_scale_actions`, `scale_grade_below_bar` |
| 2 | SENSOR TRUST: ≥ `MIN_CONSECUTIVE_GREEN_TRUST` consecutive `band='green'` snapshots ending at the latest | `trust_no_snapshots`, `trust_streak_short` |
| 3 | CAC:LTV: `cacLtvRatio ≥ target` (default `DEFAULT_COLD_SCALER_CAC_LTV_TARGET` = 3) | `cac_ltv_below_target`, `cac_ltv_unknown` |

The gate is ALL-OR-NOTHING: every precondition must clear. A single failing predicate refuses the arm. That's the Bianca M4 "human-vetoable arming rail" north-star: the scaler NEVER opts around a rail — it stays in shadow.

## The write / escalate contract on deny

1. **Upsert** one `media_buyer_cold_scaler_arming_authorization` row (allowed OR denied — both paths write, so the row is the truth of the last evaluation).
2. **CEO escalation** via `escalateDiagnosisToCeo` (`escalationKind='cold_scaler_arming_denied'`, `dedupeKey='cold_scaler_arming_denied:{workspace}:{account|workspace}:{cohort}:{iso_week}'`). Dedupes to ONE OPEN card per `(workspace, account, cohort, iso_week)` — a re-run within the same week does NOT spam the CEO.
3. **Growth `director_activity`** row (`action_kind='cold_scaler_arming_denied'`, `director_function='growth'`, `spec_slug='bianca-cold-scaler-arming-gate-shadow-to-armed'`) carrying `reasons`, `metrics`, `authorization_id`, `dedupe_key`, `iso_week`, `cold_scaler_cohort_id`.

The write ORDER is UPSERT → ESCALATE → AUDIT. The escalation runs after the row is persisted so a partial deploy that has the runner but not the executor still leaves a durable authorization row (evidence) even if the escalation fails.

## CAC:LTV input — sensor row vs. blended fallback

The pure gate reads a decoupled `CacLtvInput` (`{ cacLtvRatio, target, unknownFlags? }`) so the runner can feed it from either source:

- **Preferred (once shipped):** the newest [[../tables/media_buyer_cold_scaler_cac_ltv_snapshot]] row for the cohort (M4 spec #8) — a cohort-specific CAC:LTV computed at the SCALER campaign's granularity.
- **Fallback (today):** [[blended-cac-ltv]] `computeBlendedCacLtv` over the same 14d window — the workspace-level composite. Used until the Phase-8 sensor spec ships so the arming gate is NEVER blocked on the sensor's ship order.

Swapping in the sensor row later is a one-line change in `runColdScalerArmingGate` — the pure gate's contract is unchanged.

## Gotchas

- **Missing row = denied at the read site.** `readLatestColdScalerArmingAuthorization` returning `null` is treated as denied by every consumer. Don't add a lenient "not yet evaluated" branch — that silently arms on absence.
- **`meta_ad_account_id` is optional but load-bearing.** `null` returns / writes the workspace-wide row; a non-null account narrows both the graded-actions scope (joined to `director_activity.metadata.meta_ad_account_id` — mirrors the [[./self-correcting]] loader) and the sensor-trust scope.
- **`cold_scaler_cohort_id` scopes every write and read.** A workspace with multiple active scaler cohorts (per-product in a shared account) carries independent authorizations — do not read across cohorts.
- **Consecutive green counts from the LATEST snapshot, not the historical max.** A yellow / red anywhere in the tail breaks the streak.
- **CAC:LTV `null` is a distinct branch.** `cac_ltv_unknown` fires when the ratio is `null` (no CAC / no LTV / no mapping). It is NOT the same as "below target" — the CEO card names WHICH failure so the fix (map an ad account vs. buy back margin) is unambiguous.
- **KILL grades never lift the verdict.** The DB loader filters `action_kind` at the query with `.in(action_kind, SCALE_ACTION_KINDS)`, and the pure gate re-filters as a defense. A caller that leaks `media_buyer_paused_loser` grades into `gradedScaleActions` sees them silently dropped — Bianca's ~97%-sound kill skill cannot vouch for her ~36%-sound promote skill, which is the whole point of the SCALE-only scope.
