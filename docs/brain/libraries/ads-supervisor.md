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

- **LF8 keyword scan** — `hasAnyLf8(copyLower)` matches the joined headline + primary text against a lowercase Life-Force-8 keyword list (energy / sleep / focus / calm / protect / family / proven / unlock / boost / …). Zero matches → `live_ad_lf8_thin` finding.
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
