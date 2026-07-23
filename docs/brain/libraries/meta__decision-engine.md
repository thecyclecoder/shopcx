# libraries/meta/decision-engine

Decision engine — Storefront Iteration Engine **Phase 4**. Turns the Phase 3
scorecards ([[../tables/iteration_scorecards_daily]]) + the active policy into
**two distinct outputs**, with zero external (Meta) side effects:

- **4a — autonomous policy actions** (deterministic, bounded by the active policy):
  `pause` · `unpause` · `scale_up` (≤ step cap) · `scale_down` · `replenish_creative`
  at the adset/campaign grain. This layer only **decides** — Phase 6a executes.
- **4b — approval-gated recommendations** (new live spend lines): an Opus layer
  reasoning as three personas over the scorecards + product intelligence, persisted
  to [[../tables/iteration_recommendations]] as `status='pending'` for Dylan to flip live.

**File:** `src/lib/meta/decision-engine.ts`

## Governance / safety

- **No active policy ⇒ zero autonomous actions.** `loadActivePolicy` returns null
  when no [[../tables/iteration_policies]] version is `active` **or the table doesn't
  exist yet** (Phase 4c) — the engine then produces only 4b recommendations.
- **Supervisable, not silent.** Every action/recommendation carries its `rationale`
  (the trigger + the policy rule invoked). Hitting a guardrail — budget floor,
  per-account daily budget-delta ceiling, or the never-pause list — **escalates**
  (returned in `escalations`, flagged for the Growth Director / human) instead of
  executing.
- **Graduated failure.** A recently-scaled object dropping below floor scales **down**
  first (reverts the step); pause only after a **second consecutive bad window** (both
  current and prior window below floor) with enough spend.
- Reads **metrics** only from [[../tables/iteration_scorecards_daily]]. Reads policy +
  ledger from the Phase 4c tables read-only (defensive). Reads adset/campaign
  `daily_budget_cents` from [[../tables/meta_adsets]] / [[../tables/meta_campaigns]]
  (config, not metrics) to express deltas in cents.

## Exports

### `runDecisionEngine` — function

```ts
async function runDecisionEngine(p: DecisionEngineParams, opts?: { snapshotDate?: string; minSpendCents?: number; minSessions?: number }): Promise<DecisionEngineResult>
```
Orchestrator: resolve snapshot date (latest scorecard day if absent) → read scorecards
→ load active policy → 4a `computeAutonomousActions` → 4b `generateRecommendations` +
`persistRecommendations`. `DecisionEngineParams = { workspaceId, adAccountId (our uuid) }`.
`minSpendCents`/`minSessions` are the **Phase 5 noise floors** — when set, objects below
the threshold are skipped for BOTH 4a actions and 4b recommendations (spend gates
ad/adset/campaign rows, sessions gates variant rows); undefined ⇒ no filter.
Returns `{ snapshotDate, policy_active, policy_version_id, autonomous: { actions, escalations, counts }, recommendations: { generated, persisted, byType, byPersona } }`.

### `computeAutonomousActions` — function (pure)

```ts
function computeAutonomousActions(input: AutonomousInputs): { actions: ComputedAction[]; escalations: ComputedAction[] }
```
The deterministic 4a core — no DB, no Meta. `AutonomousInputs = { rows, policy, budgets, recentActions, nowMs, excludedObjectIds }`.
Each `ComputedAction` stamps `policy_version_id` + `triggering_scorecard_id` and a
before/after `{ budget_cents, status }`; escalations additionally carry `guardrail`.

`excludedObjectIds: Set<string>` — the media-buyer test rail. Every scorecard row
whose `object_id` is in the set is skipped at the TOP of the row loop, so the engine
emits NO `pause` / `unpause` / `scale_up` / `scale_down` / `replenish_creative` on
those objects. `runDecisionEngine` builds it from ACTIVE
[[../tables/media_buyer_test_cohorts]] rows (`test_meta_campaign_id` +
legacy `test_meta_adset_id`) UNION every [[../tables/meta_adsets]] row under those
test campaigns. This enforces the North-star rail boundary
([[../operational-rules]] § North star): budget scaling only touches
scaling/storefront objects; the media-buyer test rail is owned by Bianca (which
crowns winners by DUPLICATING them into the cold-scaler
[[../tables/media_buyer_cold_scaler_cohorts]] — the cold-scaler campaigns stay in
the universe and remain the ALLOWED scaling targets). Raising a test adset's
budget in place would corrupt the equal-funded ABO test read AND double-govern the
object (two autonomous actors fighting).

### `generateRecommendations` / `persistRecommendations` — functions

```ts
async function generateRecommendations(p: DecisionEngineParams, rows: ScorecardRow[]): Promise<ComputedRecommendation[]>
async function persistRecommendations(p: DecisionEngineParams, snapshotDate: string, recs: ComputedRecommendation[]): Promise<number>
```
4b. One Opus call ([[ai-models]] `OPUS_MODEL`) role-playing the three personas over a
slim scorecard context + product intelligence (lead benefits + active angles), parsed
defensively (returns `[]` on any failure). Persist upserts on
`(workspace_id, meta_ad_account_id, snapshot_date, action_type, dedup_key)` → idempotent.

### `loadActivePolicy` / `loadRecentActions` — functions

Read-only loaders for the Phase 4c [[../tables/iteration_policies]] /
[[../tables/iteration_actions]] tables; both degrade to `null` / `[]` when the
table is absent. `loadActivePolicy` → null ⇒ zero autonomous actions.

### `persistActions` — function (Phase 4c ledger append/update)

```ts
async function persistActions(p: DecisionEngineParams, snapshotDate: string, actions: ComputedAction[], escalations?: ComputedAction[]): Promise<number>
```
Idempotent upsert of the 4a decisions into [[../tables/iteration_actions]] —
`actions` land `status='decided'`, `escalations` land `status='escalated'` with the
`guardrail` that fired. Upsert key
`(workspace_id, meta_ad_account_id, object_id, action_type, snapshot_date)`. **NOT**
called by `runDecisionEngine` (Phase 4 keeps zero side effects) — the Phase 5 cron
persists after the engine returns. The engine appends/updates this ledger only;
it never writes [[../tables/iteration_policies]].

### Types

`IterationPolicy` (the typed policy contract the Growth Director authors),
`ComputedAction`, `ComputedRecommendation`, `AutonomousActionType`
(`pause|unpause|scale_up|scale_down|replenish_creative`), `RecommendationType`
(`new_static_adset|new_video_adset|new_campaign|test_benefit_angle|new_lander_variant|offer_test`),
`Persona` (`direct_response_marketer|offer_designer|media_buyer`), `ScorecardRow`.

## Callers

- `src/lib/inngest/meta-performance.ts` (`meta-decision-engine`, fired after each
  `meta-scorecards-refresh`; and `meta-iteration-run` — the Phase 5 daily run — which
  calls `runDecisionEngine` with the noise floors then `persistActions` after it returns).
- [[meta__iteration-run]] (Phase 5 reconcile/reversal links onto the same ledger).
- Review surface: `src/app/api/ads/iteration-recommendations/route.ts` (GET list) +
  `[id]/route.ts` (POST approve/reject).

## Gotchas

- **4a does NOT persist or execute in Phase 4.** Actions are returned + logged; the
  `iteration_actions` ledger (persistence/cooldown/reversal) is Phase 4c and Meta
  execution is Phase 6a. Until those land, autonomous actions are surfaced but not
  acted on, and (with no `iteration_policies` table/active row) there are none.
- **Budget may be null under CBO/ABO crossover** — scale actions then carry `before/after`
  budget `null`; the Phase 6a adapter resolves the real budget object.
- **Idempotent** — re-running a snapshot re-upserts the same recommendation dedup keys;
  no duplicate rows.

See [[../specs/storefront-iteration-engine]] (Phase 4) · [[../research/iteration-engine-grounding]].
