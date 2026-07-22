# factor_rollup_policies

The workspace-tunable significance thresholds behind the factor-rollup SDK. The SDK
rolls up per-{theme, angle, pattern, combination} CPA/CTR/ROAS/spend across a
lookback window and stamps every row with a significance verdict — this table
persists the per-workspace knobs the verdict is computed against, so a
heavier-traffic workspace can raise the bar without a code sweep. Modeled on the
shipped [[iteration_policies]] + [[../libraries/testing-results-sdk]]
`resolveTestThresholds` pattern: ONE row per workspace, every threshold nullable
(unset ⇒ fall through to code-owned defaults). Migration
`20261125120000_factor_rollup_policies.sql`. RLS: workspace-member SELECT,
service-role full. See [[../specs/factor-rollup-sdk-with-significance-gate]]
Phase 1 + [[../goals/v3-ad-creative-engine]] M5 (the attribution / learning loop).

**Primary key:** `id`

## Grain

One row per `workspace_id` (`UNIQUE` constraint). No versioning — this is a
tuning knob, not a policy-authoring surface: the owner edits in place and the
resolver reads the current row every call.

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · `UNIQUE` (one row per workspace) · `on delete cascade` |
| `min_spend_cents` | `bigint` | ✓ | window spend a factor bucket must hit before it can pass the gate. Null ⇒ resolver default `$200` (`DEFAULT_FACTOR_ROLLUP_THRESHOLDS.minSpendCents` in [[../libraries/factor-rollup-policies]]) |
| `min_purchases` | `int` | ✓ | window purchases a factor bucket must hit before it can pass the gate. Null ⇒ resolver default `5`. Guards against two-purchase win-rates crowning an angle. |
| `confidence` | `numeric` | ✓ | reserved 0..1 knob for the follow-on statistical-gate work (the goal names three axes: spend / purchases / confidence). Null ⇒ resolver default `0.8`. Returned verbatim by the resolver; unused by the shipped verdict (spend + purchases only). |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | auto-bumped on any UPDATE via the `factor_rollup_policies_touch_updated_at` trigger |

## Consumers

- [[../libraries/factor-rollup-policies]] `resolveFactorRollupThresholds` is the
  sole reader. Returns `{ minSpendCents, minPurchases, confidence }` — an unset
  row (or a row with a null axis) falls through to
  `DEFAULT_FACTOR_ROLLUP_THRESHOLDS` per-axis.
- The Phase-2 [[../libraries/factor-rollup-sdk]] `getFactorRollup` calls the
  resolver once per rollup and stamps every {theme, angle, pattern, combination}
  row's `significance.passesGate` from the returned thresholds.

## Gotchas

- **Never read this table raw** — go through
  [[../libraries/factor-rollup-policies]] `resolveFactorRollupThresholds`. The
  Phase-3 `scripts/_check-factor-rollup-sdk-compliance.ts` predeploy check
  forbids raw `.from("factor_rollup_policies")` outside the resolver.
- Every threshold is **nullable on purpose** — the resolver's code defaults are
  the SSOT for the shipped floor, and a workspace only overrides the axes it
  wants tuned. Don't insert a row with all nulls to "set defaults"; leave the
  row absent instead.
- Monetary field is **cents**. `confidence` is a fraction (0..1), not a
  percentage.
