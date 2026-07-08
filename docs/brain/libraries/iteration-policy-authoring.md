# libraries/iteration-policy-authoring

The Growth Director's (and a human's) **authoring + activation surface** for
[[../tables/iteration_policies]] — the seam that ends Meta's dormant mode by
authoring + activating the first policy version, and every re-tune after. The
engine ([[meta__decision-engine]] `loadActivePolicy`) consumes the `active` row
read-only; with no active row the engine takes **zero autonomous actions**, so
this module is the single way that invariant ever flips. Implements Phase 1 of
[[../specs/growth-adopt-meta-iteration-engine]].

**File:** `src/lib/iteration-policy-authoring.ts` · Writes [[../tables/iteration_policies]] · Consumed by the [[growth-director]] worker on every `propose_policy_activation` auto-approve.

## Exports

### `authorIterationPolicy(admin, { workspaceId, draft, createdBy, rationale })` → `Promise<{ policyId, version }>`
Insert one **pending** `iteration_policies` row at `version = max + 1` for the
workspace's null-campaign (global) scope. Versioning is monotone per workspace —
collisions on the partial unique index `(workspace_id, version) where campaign_id
is null` bubble up so a concurrent author retries. The API actor (`director |
human`) collapses to the DB's `agent | human` CHECK (`director → agent` — the
director is an agent) so the column constraint stays satisfied; the actor label
is recorded by the matching [[director-activity]] row.

**Shadow-default (media-buyer-shadow-mode Phase 1).** `IterationPolicyDraft`
carries an optional `mode: 'shadow' | 'armed'`; omitting it lands the row
`mode='shadow'` (the DB's column default matches so a `null`/absent field is
safe). The flip to `armed` is a separate, audited surface — this authoring path
never mints an armed policy silently. A calibrated re-tune (see
[[../recipes/media-buyer-per-cohort-iteration-policy-calibration]]) re-enters
shadow by design, so a human/director confirms the new thresholds before budget
moves.

### `activateIterationPolicy(admin, { workspaceId, policyId, activatedBy })` → `Promise<{ activated, supersededPolicyId, version }>`
Flip `pending → active`, supersede the prior active row via `superseded_by` +
`superseded_at`. The partial unique index
`iteration_policies_one_active_idx (workspace_id) where status='active' and
campaign_id is null` enforces at most one active global row per workspace, so we
**always supersede the prior active first**, then activate ours — reversed
ordering would collide on the index. Idempotent on `already active`; throws on
`not pending` (only `pending` is activatable), `not found`, or `wrong workspace`.
`activated_by` is `uuid → auth.users(id)`; the Director (and the Phase-1 human
path) has no uid to write, so the column stays null and the actor lives on the
audit row.

### `validateActivationAgainstSpendRail(admin, { workspaceId, draft, metaAdAccountId?, policyId? })` → `Promise<SpendRailGuardDecision>`
**Phase 3 — Spend-rail guard at activation time.** Before `activateIterationPolicy`
writes `status='active'`, project the policy's expected daily budget motion
(`per_account_daily_budget_delta_ceiling_cents × ad_spend_budgets.window_days`)
on top of the current rolling actual and refuse if the result would breach the
workspace's effective [[../tables/ad_spend_budgets]] ceiling for the same
`(workspace_id, platform='meta', meta_ad_account_id)` — the more-specific
per-account row beats the platform-wide row.

Returns `{ allow:true, observation }` (allow) — `observation` is null when no
rail row exists (no ceiling to breach), populated otherwise — OR `{ allow:false,
reason:'ad_spend_ceiling_would_breach', observation, diagnosis, metadata }`
(refuse). The worker writes ONE `refused_iteration_policy`
[[director-activity]] row per refused action and routes the diagnosis to the CEO
via [[platform-director]] `escalateDiagnosisToCeo` (`escalationKind='ad_spend_ceiling'`,
deep-link `/dashboard/marketing/ads`). NEVER mutates — the worker owns the
escalation; the guard is a pure read.

The check is conservative (assumes the engine moves the max daily delta every
day across the window) but defensible — the leash boundary is the projected
worst case, not the historical average. Raising the ceiling stays the CEO's
call (operational-rules § supervisable autonomy; the loop never widens its own
envelope).

### Types
`IterationPolicyDraft` (the typed thresholds, one-to-one with the non-id/non-status
columns, including `mode?: IterationPolicyMode` — omit ⇒ `shadow`),
`IterationPolicyMode` (`shadow | armed`), `PolicyActor` (`director | human`),
`AuthorIterationPolicyInput | Result`, `ActivateIterationPolicyInput | Result`,
`SpendRailGuardDecision` (the `allow|refuse` discriminated union),
`SpendRailObservation`, `SpendRailRefusalMetadata`.

## How it's wired

The Growth Director box session emits a `propose_policy_activation` pending
action carrying `{ draft, rationale, meta_ad_account_id? }` in its payload. The
[[growth-director]] leash classes this as `iteration_policy_activation` (a Phase-2
leash category); on Director auto-approve the worker `runGrowthDirectorJob`
runs `validateActivationAgainstSpendRail` for each action — on **allow**, the
worker proceeds with `authorIterationPolicy` then `activateIterationPolicy` and
writes a [[director-activity]] row (`action_kind='activated_iteration_policy'`,
metadata = `{ policy_id, version, rationale, superseded_policy_id }`); on
**refuse**, the worker writes one `refused_iteration_policy` activity row per
refused action and calls `escalateDiagnosisToCeo`
(`escalationKind='ad_spend_ceiling'`) instead of authoring + activating.
Activation failures (post-guard) park the growth-director job `needs_attention`
so the CEO sees the gap; the already-recorded `approved_approval` row stays for
audit.

## Gotchas

- **Sequential supersede → activate, NOT a transaction.** Two sequential
  `.update` calls — the unique partial index would briefly reject the new active
  row if we activated ours first. There's a (tiny) window between the two
  updates where the workspace has no active row; that window is engine-safe
  (`loadActivePolicy` returning null falls through to zero autonomous actions).
- **`created_by` is constrained `agent | human` at the DB level.** The API takes
  `director | human` for legibility — `director` writes `agent`. Persist the
  actor label out-of-band on the [[director-activity]] row, not on the policy row.
- **`activated_by` is a `uuid`.** Director activations leave it null. A future
  per-user authoring path may pass a uuid; the API field is `activatedBy` (an
  actor label) today, not a uid.
- **Global scope only in v1.** Both `meta_ad_account_id` and `campaign_id` are
  written `null` — the per-campaign override columns are reserved on the table
  for later (the engine can already honor them with no migration).
- **The engine never writes this table — only this module does.** The Phase-5
  cron + Phase-6a executor consume `loadActivePolicy` read-only.
