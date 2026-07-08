# libraries/media-buyer-policy-calibrator

The pure per-cohort [[../tables/iteration_policies]] calibrator + its box-lane runner. Replaces the hardcoded 1.5×/3.0× media-buyer seed with a data-derived proposal drawn from each cohort's realized ROAS + spend distribution — directly serving the parent goal ([[../goals/autonomous-media-buyer-supervision]]) M1 "Sensor trust" milestone's "trustable thresholds" missing piece.

**Files:**
- `src/lib/media-buyer/policy-calibrator.ts` — Phase 1 pure calibrator (DB-free; unit-testable).
- `src/lib/media-buyer/calibrate-policy-runner.ts` — Phase 2 wrapper that reads samples + writes.

**Runner:** [[builder-worker]] `runCalibrateMediaBuyerPolicyJob` (`kind='calibrate-media-buyer-policy'`).

## What it does (mandate)

Every calibration takes three sample sets from the last 30d + 7d:

- **ROAS distribution** — `meta_attribution_daily` rows where `roas > 0` and `variant != '(unresolved)'` in the last 30d (per-account when scoped, workspace-wide when null).
- **Spend distribution** — `iteration_scorecards_daily.spend_cents` over the same 30d window.
- **Recent account spend** — `sum(daily_meta_ad_spend.spend_cents)` over the last 7d.

And emits four data-derived knobs; the other operational knobs carry through from the current policy (or the seed if there is none). The **`scale_up_step_pct`** + **`scale_up_cap_pct`** are NEVER re-proposed by this calibrator on the first pass — the conservative posture matches the seed we're replacing.

| Knob | Formula |
|---|---|
| `roas_floor` | `clamp(median(roasSamples), 0.8, 2.0)` |
| `scale_up_roas_trigger` | `clamp(p75(roasSamples), roas_floor × 1.5, 5.0)` |
| `pause_min_spend_cents` | `max($50, p60(spendSamplesCents))` |
| `per_account_daily_budget_delta_ceiling_cents` | `max($10, round(recent7dAccountSpend × 0.10))` |

Outputs are rounded to 2dp on the ROAS fields so downstream equality holds through IEEE-754 noise. The rationale text cites every quantile in one line — the runner writes it verbatim to `iteration_policies.rationale`.

## Exports (Phase 1 — pure)

### `calibrateMediaBuyerPolicy(input) → { draft, rationale, quantiles }` — function

Pure. `input = { roasSamples: number[], spendSamplesCents: number[], recentAccountSpendCents: number, currentPolicy?: Partial<IterationPolicyDraft> }`. Returns:

- `draft` — a full `IterationPolicyDraft` (matches [[iteration-policy-authoring]] 1:1) ready for `authorIterationPolicy`.
- `rationale` — human-legible one-line trace citing every quantile the calibrator computed.
- `quantiles` — `{ roasMedian, roasP75, spendP60Cents, sampleSize, spendSampleSize }` for the runner's audit / test assertions.

**Zero-data behavior.** An empty `roasSamples` throws `EmptyCalibrationSampleError`. Calibration on zero data is a **category error, not a silent zero-policy** — the runner catches this and defers with a `director_activity` `media_buyer_calibration_deferred` row rather than authoring a garbage policy.

### `EmptyCalibrationSampleError` — class

Typed error for the zero-data category. Caught by the runner; propagates out of the calibrator so any caller sees the same discriminator.

### `CalibrateMediaBuyerPolicyInput | Result` — types

The typed input/output contracts. `currentPolicy?` is `Partial<IterationPolicyDraft>` so callers can pass the persisted `iteration_policies` row shape verbatim.

## Exports (Phase 2 — DB-touching runner)

### `runMediaBuyerPolicyCalibration(admin, { workspaceId, metaAdAccountId? }) → RunMediaBuyerPolicyCalibrationResult` — function

The box lane's entry point. Returns a discriminated result:

- **`{ status: 'proposed', policyId, version, draft, rationale, quantiles, sensorTrust }`** — one `iteration_policies` row landed `pending` at `version = prior_max+1`, `created_by='agent'`, `rationale=<cited>`; one `director_activity` row landed `action_kind='media_buyer_calibration_proposed'` (director_function='growth') linking policy_id + version + sensor-trust snapshot.
- **`{ status: 'deferred', reason, reasonDetails, sensorTrust }`** — ZERO policy writes, ONE `director_activity` row landed `action_kind='media_buyer_calibration_deferred'` citing the failing reasons. Three deferral reasons today: `sensor_trust_missing`, `sensor_trust_not_green`, `empty_calibration_sample`.

Never activates — activation stays with the Growth Director (or a human) via [[iteration-policy-authoring]] `activateIterationPolicy`. That's the same governance chokepoint the Director's `propose_policy_activation` leash already gates.

### `CALIBRATION_ROAS_WINDOW_DAYS` — const `30`

The lookback for ROAS + spend samples.

### `CALIBRATION_SPEND_ANCHOR_WINDOW_DAYS` — const `7`

The lookback for the `per_account_daily_budget_delta_ceiling_cents` anchor (`sum(daily_meta_ad_spend.spend_cents)` over the last 7d).

### `CALIBRATION_PROPOSED_KIND | CALIBRATION_DEFERRED_KIND` — const strings

The `director_activity.action_kind` labels this runner emits. Open vocabulary (no CHECK on that column) so no migration is required to add these.

## The sensor-trust gate

Before running the calibration, the runner reads the newest [[../tables/media_buyer_sensor_trust]] snapshot for `(workspace_id, meta_ad_account_id)` and only proceeds on **`band='green'`**. A `yellow` band is a warning, not a green light — a calibration proposal on `yellow`/`red` would encode noise into the pending policy; the north-star principle is "hitting a rail ≡ escalate, not execute". A missing snapshot is treated as untrusted (same posture as the runtime Media Buyer's sensor-trust contract — see [[media-buyer-agent]] § Sensor-trust contract).

This mirrors the runtime dormant-without-clean-probe gate on the Media Buyer's pass — the calibration lane authors thresholds the sensor justifies, the pass grades shadow calls against those thresholds, and both stay dormant until the sensor is clean.

## The box lane

`kind='calibrate-media-buyer-policy'`; concurrency-1 (bumpable via `AGENT_TODO_MAX_CALIBRATE_MEDIA_BUYER_POLICY`). Instructions JSON `{ meta_ad_account_id? }`:

- **Omitted** ⇒ fan out over every connected `meta_ad_accounts` row for the workspace + also run one workspace-wide calibration (`metaAdAccountId=null`). Same shape as [[media-buyer__sensor-trust-probe]].
- **Explicit** ⇒ single-scope run.

Per-scope: one calibration call → either one `iteration_policies` `pending` row + one `media_buyer_calibration_proposed` audit row, OR one `media_buyer_calibration_deferred` audit row citing the failing reasons. The job's `log_tail` carries the per-scope JSON so a failed scope is diagnosable.

## How it feeds the Growth Director

[[growth-director]] `buildGrowthDirectorBrief` already reads pending `iteration_policies` versions (bounded by `POLICY_VERSIONS_CAP`, newest first) — the newly-proposed pending version flows into `brief.iterationPolicies` with **zero additional wiring**. The Director's investigation classes any activation on that pending version as `iteration_policy_activation`; the `propose_policy_activation` leash then does the actual flip.

## Column contract

The `IterationPolicyDraft` returned by the calibrator matches the non-id/non-status columns of [[../tables/iteration_policies]] 1:1 (via the [[iteration-policy-authoring]] `IterationPolicyDraft` interface). The runner passes it straight to `authorIterationPolicy` with no field-name mapping — a schema drift on either side becomes a tsc error.

## Gotchas

- **The calibrator never activates.** `runMediaBuyerPolicyCalibration` authors a `pending` row and stops. The Director's `propose_policy_activation` leash + `activateIterationPolicy` is the ONLY path to `status='active'`. Same "supervisable-autonomy" principle as the Media Buyer itself — a tool proposes; a role agent activates; the CEO owns the objective.
- **Empty ROAS sample ≡ category error, not a silent zero-policy.** Calibrating on zero data would author a garbage policy version. The runner defers instead — one `media_buyer_calibration_deferred` audit row, ZERO `iteration_policies` writes.
- **Yellow band defers.** Only `green` authorizes a proposal. The band gate mirrors the runtime pass — a `yellow`/`red`/missing snapshot dorm the calibration lane the same way it dorms the Media Buyer's loop.
- **`bigint` arrives as a string from PostgREST.** The runner normalizes `spend_cents` / `daily_meta_ad_spend.spend_cents` to `number` before summing.
- **`scale_up_step_pct` + `scale_up_cap_pct` are NEVER re-proposed on the first calibration.** The calibrator carries them through from `currentPolicy` (or the seed if there is none). This is the conservative posture the spec calls out explicitly — the calibrator tunes what the data supports, and leaves the pace knobs where the operator already had them.

## Related

[[../tables/iteration_policies]] · [[../tables/media_buyer_sensor_trust]] · [[../tables/meta_attribution_daily]] · [[../tables/iteration_scorecards_daily]] · [[../tables/daily_meta_ad_spend]] · [[../tables/director_activity]] · [[iteration-policy-authoring]] · [[media-buyer-agent]] · [[media-buyer__sensor-trust-probe]] · [[growth-director]] · [[builder-worker]] · [[../specs/media-buyer-per-cohort-iteration-policy-calibration]] · [[../goals/autonomous-media-buyer-supervision]] · [[../functions/growth]] · [[../operational-rules]] (§ North star — supervisable autonomy)
