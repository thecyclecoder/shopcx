# libraries/ads-supervisor

The Phase-2 supervisory pass logic behind the every-3h [[../inngest/ads-supervisor-cadence]] cron ([[../specs/growth-ads-supervisor-3h-agent]] Phase 2). Audits Bianca (the [[media-buyer-agent]]) + Dahlia (the [[creative-agent]]) worker agents and REPAIRS drift by autonomously authoring fix-specs through the [[author-spec]] `authorSpecRowStructured` chokepoint. Same supervisable-autonomy north-star as the [[media-buyer-publish-gate|media-buyer arming gate]]: this supervisor **NEVER moves spend / pauses / crowns / places ads directly** — it PROPOSES fix-specs Bianca / Dahlia (or Bo the Build worker) consume, and posts ONE consolidated digest to the founder's `#director-growth-max` channel.

**File:** `src/lib/ads-supervisor.ts` · lane runner in `scripts/builder-worker.ts` `runAdsSupervisorJob` · cron in [[../inngest/ads-supervisor-cadence]]

## The pass — 4 checks, one write chokepoint

The exports live in one module so the pass is unit-testable end-to-end without touching the box lane:

- `runAdsSupervisorPass(admin, workspaceId, nowMs?)` → `AdsSupervisorResult` — the entry point the box lane calls. Read-only against every SDK **except** `authorSpecRowStructured` (the structured spec-authoring chokepoint) and `postAsGrowthDirector` (the founder's Slack digest).
- `composeAdsSupervisorDigest(result)` — pure composer; exported for unit tests that pin the "no-op suppressed" behaviour.
- `deliverAdsSupervisorDigest(admin, workspaceId, result)` — wraps `postAsGrowthDirector` + records a `director_activity` audit row.
- `hasAnyLf8(copyLower)` + `destinationMatchesProduct(destination, productTitle)` — the two pure predicates behind the live-ad QA check (exported so tests pin their exact semantics).

### 1. Crown/kill drift (Bianca)

Calls [[testing-results-sdk]] `getTestingResults(admin, workspaceId)` — which itself calls `resolveTestThresholds` against the workspace's live [[../tables/iteration_policies]] row (crown ≥ 8 purch + CAC ≤ $150 + spend ≥ $450; early-trim ≥ $300 with 0 sales; deadline $1,200 without hold band). Any `active` row in the returned `products[].rows[]` classified `crown` or `dud` becomes a candidate. For each candidate, `readIterationActionsForAdsets` reads `iteration_actions.action_type ∈ ('scale_up','pause')` scoped to the workspace + the adset ids — a crown with **no scale_up** row is a should-crown miss; a dud with **no pause** row is a should-kill miss. Each miss authors a `bianca_missed_crown` / `bianca_missed_kill` finding.

### 2. Dahlia bin depth + seeding

For each hero product (any product with an active [[../tables/media_buyer_test_cohorts]] row surfaced by testing-results), call [[ready-to-test]] `listReadyToTest({workspaceId, productId})` and compare depth against `DEFAULT_BIN_FLOOR` (4, exported from [[creative-agent]]). Below the floor → `dahlia_bin_below_floor` finding. Also call [[creative-sourcing]] `getProvenCompetitorAngles({productId, minDaysRunning: 30})` — zero rows means Dahlia has no proven angle shelf for the product → `dahlia_zero_seeded_angles` finding.

### 3. Live-ad LF8 + destination QA

For each live test creative (a `TestAdsetRow.creative` object carrying `headline / primaryText / description / link`), run two rule-based checks:

- **LF8 keyword scan** — `hasAnyLf8(copyLower)` from [[lf8]] matches the joined headline + primary text against the canonical Life-Force-8 keyword list (energy / sleep / focus / calm / protect / family / proven / unlock / boost / …). Zero matches trip the LF8 gate — but the disposition is now **split into two** (Phase 2 of `lf8-live-ad-gate-broaden-vocab-and-gate-deactivation-on-performance`):
  - `live_ad_lf8_thin_enrichment` — keyword-thin but NOT underperforming on the leading indicator. **NON-DESTRUCTIVE.** Authors a Dahlia copy-enrichment suggestion (bias the next `buildMetaCopy` toward an LF8-adjacent supporting benefit) and MUST NOT flip `product_ad_angles.is_active=false`. A keyword miss on a live, spending, converting angle is surfaced — never executed.
  - `live_ad_lf8_thin` — keyword-thin AND underperforming (lifetime cost-per-ATC strictly exceeds `iteration_policies.trim_max_cost_per_atc_cents`, fallback $80 = `LF8_TRIM_MAX_COST_PER_ATC_DEFAULT_CENTS` — the SAME SSOT Bianca's trim logic reads at [[media-buyer-agent]] line 933). Only THIS disposition authorizes the deactivation path; the authored fix-spec body requires any downstream fix-script to re-verify the gate before mutation.
  The split is enforced at the pass loop by `chooseLf8Disposition(gate, row)` (pure selector, exported for tests) which composes `resolveLf8UnderperformanceThreshold(admin, workspaceId)` with `isLiveAdLf8Underperforming(row, threshold)`. **FAIL-CLOSED (Fix 1, 2026-07-14 pre-merge spec-test security-review):** `resolveLf8UnderperformanceThreshold` returns a discriminated `Lf8GateThreshold = { ok: true; value } | { ok: false; reason }` — a Supabase read error OR a missing `iteration_policies` row returns `{ ok: false }` and forces the entire pass to `enrich_only` for every LF8-thin adset in that workspace; the destructive deactivation path can NEVER fire on unproven policy state. The default ($80) is applied ONLY when a row is successfully read AND its column value came back null. Same fail-closed guard now runs in the one-off `scripts/fix-live-ad-lf8-*.ts` `passesUnderperformanceGate` (aborts on read error / missing row, never silently uses the default). **Invariant (2026-07-14):** the same [[lf8]] module is shared with [[creative-brief]] `buildMetaCopy`, so a live drift re-flags only if Dahlia's brief genuinely lacks LF8-adjacent language — the generator satisfies the gate by construction (prefers LF8 supporting benefits + injects one if missing). Re-runs on the same drift class produce the SAME slug so repeat drifts are deduped. **Fix (2026-07-14):** when a live adset carries LF8-thin angles AND is underperforming, the fix-spec deactivates those `product_ad_angles` rows (scoped by workspace + product, joined via `ad_campaigns.angle_id`), so Dahlia's next generate for that cohort sources from fresh LF8-carrying angles (script path: `scripts/fix-live-ad-lf8-<ws8>-adset.ts` — each such script runs its own `passesUnderperformanceGate` re-check as step 0, aborting if the live cost-per-ATC no longer exceeds the trim threshold OR the policy read failed).
- **Destination scent-match** — `destinationMatchesProduct(destination, productTitle)` parses the ad link, splits the product title into ≥4-char kebab tokens, and asserts at least one appears in the URL path. Homepage-only (`/`) or a URL parse error is a mismatch → `live_ad_destination_mismatch` finding.

These are DELIBERATELY rule-based (no LLM QA) so the pass is deterministic + cheap; a follow-up spec can widen the check with a vision QA if the base needs it.

### 4. Deduped fix-spec authoring

Every finding maps to a stable slug — `ads-supervisor-fix-<ws8>-<finding.id>` — so a re-run of the pass on the SAME drift class produces the SAME slug. Before the write:

- `getSpec(workspaceId, slug)` — a non-null result skips the write (any status: a still-active fix-spec, or an in-progress build, or even a folded historical fix all cover the finding).
- `hasOpenRepairJob` — a not-yet-terminal `kind='repair'` box job with the matching `spec_slug` also skips the write (a parked repair job is already the "fix this" ledger).

Deduped slugs are surfaced in `AdsSupervisorResult.dedupedSlugs` for the digest. Authored slugs land in `authoredSlugs`.

Every authored fix-phase carries `defaultAdsSupervisorFixPhaseChecks()` — a single `exec_kind:'tsc'` machine check. **NEVER `needs_human`** (the spec forbids it explicitly: "machine checks only — NEVER needs_human"). The prose verification rides verbatim on the phase's `verification` column (human-facing); the tsc check is what the deterministic spec-check runner executes at merge gate.

The parent is `growth#static-ad-optimization` (typed mandate parent — `parentKind:'mandate'` + `parentRef:'growth#static-ad-optimization'`), matching the [[../functions/growth]] "Static-ad optimization" mandate.

### 5. #director-growth-max digest — no-op suppressed

`deliverAdsSupervisorDigest` composes the growth-director-voice digest (`Max (Growth) — ads-supervisor: N drift issues …`) and posts it via [[slack]] `postAsGrowthDirector`. Suppressed when:

- The pass has **zero findings AND zero authored slugs** (the true no-op — don't spam Slack every 3h with "nothing to report").
- No `workspaces.slack_growth_director_channel_id` configured OR Slack not connected.

A posted digest records a `director_activity` row (`action_kind:'ads_supervisor_digest_posted'`, `director_function:'growth'`, `spec_slug:'growth-ads-supervisor-3h-agent'`) for the audit trail.

## Gotchas / Known fixes

**dahlia_bin_below_floor finding** — when `listReadyToTest` depth is below `DEFAULT_BIN_FLOOR` (4), the fix depends on two diagnostics:

1. Check if [[../inngest/ad-creative-cadence]] is actively dispatching `kind='ad-creative'` jobs for this product by querying `agent_jobs` where `kind='ad-creative'` AND `instructions->>'product_id'` matches, scoped to the last 24h. A non-terminal status (`pending` / `running` / etc.) means the cadence is already self-healing — no dispatch needed. A terminal status (`failed` / `succeeded`) or zero matches means either the job failed or wasn't enqueued.
2. Check if [[../tables/product_ad_angles]] has any active rows for this product. An empty result means Dahlia's generate step will starve — this is an intelligence gap (missing benefits / hooks / angles) that must be seeded by the dr-content lane (or manually, if urgent). A non-empty result means the product has angles but Dahlia isn't being invoked.

Fix options:
- **If product_ad_angles is empty:** flag the intelligence gap to the dr-content lane for backfill (not auto-writable).
- **If product_ad_angles exists but no active ad-creative job:** enqueue a new `agent_jobs` row with `kind='ad-creative'`, `instructions={'product_id': <pid>, 'count': <deficit>}`, `spec_slug` from [[../inngest/ad-creative-cadence]] `adCreativeSpecSlug(<pid>)`. Idempotent: the cadence self-heals on its next tick anyway, or the enqueue can be done manually via `scripts/ads-supervisor-fix-{product-id}-dahlia-bin.ts --apply`.

## Node-completeness (CLAUDE.md hard rule)

- **Owner:** `growth` on the cron ([[../inngest/ads-supervisor-cadence]] MONITORED_LOOPS row) AND on the `ads-supervisor` agent-kind (`KIND_OWNER_FALLBACK` + `BUILDER_WORKER_KINDS` in [[control-tower-node-registry]]).
- **Kill-switch:** covered by the ancestor `growth` department row in [[../tables/kill_switches]] (the cascade in [[kill-switch-resolver]] resolves any child owned by growth — no per-cron / per-agent row required, per the "its own row OR an ancestor's" rule).
- **Heartbeat:** the cron emits `emitCronHeartbeat("ads-supervisor-cadence", ...)`; the box lane emits `emitAgentHeartbeat("ads-supervisor", ...)` in a try/finally (ok:false on throw).

## Tables read

- [[../tables/media_buyer_test_cohorts]] · [[../tables/iteration_policies]] · [[../tables/iteration_actions]] · [[../tables/meta_ad_accounts]] · [[../tables/meta_adsets]] · [[../tables/meta_insights_daily]] · [[../tables/products]] · [[../tables/ad_videos]] · [[../tables/ad_campaigns]] · [[../tables/ad_publish_jobs]] · [[../tables/creative_skeletons]] · [[../tables/specs]] · [[../tables/spec_phases]] · [[../tables/agent_jobs]] · [[../tables/workspaces]]

## Tables written (structured chokepoints only)

- [[../tables/specs]] + [[../tables/spec_phases]] (via [[author-spec]] `authorSpecRowStructured`)
- [[../tables/director_activity]] (one `ads_supervisor_digest_posted` row per posted digest)

Never `iteration_actions`, `ad_publish_jobs`, `ad_campaigns`, or any Meta surface — the spec's north-star invariant.

## Related

[[../inngest/ads-supervisor-cadence]] · [[testing-results-sdk]] · [[ready-to-test]] · [[creative-sourcing]] · [[creative-agent]] · [[media-buyer-agent]] · [[media-buyer-director-digest]] · [[author-spec]] · [[slack]] · [[../functions/growth]] · [[../specs/growth-ads-supervisor-3h-agent]]
