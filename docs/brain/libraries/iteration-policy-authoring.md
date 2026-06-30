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

### Types
`IterationPolicyDraft` (the typed thresholds, one-to-one with the non-id/non-status
columns), `PolicyActor` (`director | human`),
`AuthorIterationPolicyInput | Result`, `ActivateIterationPolicyInput | Result`.

## How it's wired

The Growth Director box session emits a `propose_policy_activation` pending
action carrying `{ draft, rationale }` in its payload. The
[[growth-director]] leash classes this as `iteration_policy_activation` (a Phase-2
leash category); on Director auto-approve the worker `runGrowthDirectorJob`
runs `authorIterationPolicy` then `activateIterationPolicy` and writes a
[[director-activity]] row (`action_kind='activated_iteration_policy'`,
metadata = `{ policy_id, version, rationale, superseded_policy_id }`). Failures
park the growth-director job `needs_attention` so the CEO sees the gap; the
already-recorded `approved_approval` row stays for audit.

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
