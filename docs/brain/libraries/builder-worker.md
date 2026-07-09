# `scripts/builder-worker.ts` — the box worker

The deterministic Node process that runs every box-hosted agent lane. Polls [[../tables/agent_jobs]] on the build box, claims jobs of the kinds it knows, dispatches to a per-kind `run*Job` function, and (for kinds that need reasoning) spawns a `claude -p` Max session under a specific skill. The **worker is the only component with prod-write credentials** — every Max session it spawns runs read-only against DB + repo, proposes JSON, and the worker applies the proposal via a narrow SDK chokepoint. This is the mechanism the north-star "supervisable autonomy" rule ([[../operational-rules]] § North star) enforces: the tool proposes; the worker applies.

**Not a call graph — a manifest.** Each lane's real logic lives in its owning library / recipe page (linked below); this page is the box-worker map so a new lane knows the shape.

## Shape of a lane

Every kind's lane looks the same:

1. A **claim** poll — `db.rpc("claim_agent_job", { p_kinds: ["<kind>"] })` under a concurrency cap `MAX_<KIND>`.
2. A **dispatch** entry — `if (job.kind === "<kind>") return run<Kind>Job(job)`.
3. A **runner** — `run<Kind>Job(job)`: reads input off `job.instructions`, does deterministic prep (DB queries, subprocess launches), spawns a Max session via `runBoxLane(...)` + `runBoxSession(prompt, ..., { kind, sandbox: "max", timeout })`, parses the session's final JSON via `extractJson`, and applies through the owning SDK.
4. A **skill** at `.claude/skills/<kind>/SKILL.md` — the persona + output contract the Max session runs under.

CI static check `scripts/_check-worker-lanes.ts` enforces that every kind in the `Job.kind` union has (1) a claim lane, (2) a dispatcher entry (or a `DISPATCH_BY_FALLTHROUGH` exemption), and no dangling literals. Ownership routing lives in [[approval-inbox]] `ownerFunctionForKind`.

## Lanes (per-kind lookup)

| Lane / kind | Owner | Docs |
|---|---|---|
| `build` / `plan` (default fall-through) | [[../functions/platform]] | build lifecycle: [[../lifecycles/spec-goal-branch]] |
| `fold` / `goal-fold` | [[../functions/platform]] | [[../recipes/fold-to-brain]] |
| `spec-review` | [[../functions/platform]] | [[agents-spec-review]] |
| `spec-test` | [[../functions/platform]] | [[spec-test-agent]] |
| `agent-grade` / `agent-coach` | (per grader owner) | [[agent-grader]] · [[agent-coaching]] |
| `director-grade` | [[../functions/platform]] | [[director-grader]] |
| `campaign-grade` | [[../functions/growth]] | [[storefront-campaign-grader]] |
| `gap-grade` | [[../functions/growth]] | [[acquisition-gap-grader]] |
| `research` | [[../functions/growth]] | Rhea's URL sensor — see below |
| `dr-content` | [[../functions/growth]] | Carrie's DR-content lane — see below |
| `media-buyer` | [[../functions/growth]] | Media Buyer's Test→Measure→Promote→Kill loop — see below |
| `media-buyer-grade` | [[../functions/growth]] | Grades Media Buyer actions vs realized ROAS — see below |
| `security-review` | [[../functions/platform]] | [[security-agent]] |
| `ticket-improve` | (CS) | [[ticket-improve-chats]] |
| `triage-escalations` | (CS) | [[../lifecycles/agent-todo-system]] |
| `storefront-optimizer` | [[../functions/growth]] | [[storefront-optimizer-agent]] |
| `platform-director` / `director-bounce-back` / `growth-director` | (directors) | [[platform-director]] · [[growth-director]] |
| … | | See `Job.kind` union in `scripts/builder-worker.ts` for the complete set. |

## The `research` lane (Rhea's URL sensor, [[../specs/rhea-url-sensor]] Phase 2 + [[../specs/rhea-teardown-recipe]] Phase 2)

The Growth-owned lane that classifies unreviewed [[../tables/research_urls]] rows into `advertorial | quiz | generic_pdp | homepage | spam` + `worthy | not_worthy` verdicts with a rationale — and, in the SAME session, reverse-engineers every worthy URL into a structured [[../recipes/lander-teardown]] recipe (`TeardownRecipe`) persisted via `setTeardown`. Cleo (slice 3) reads those recipes to diff against our storefront and emit a build blueprint.

- **Enqueue** — [[../inngest/research-sensor]]'s HOURLY paced claim (rhea-research-automation Phase 1): syncs [[../tables/research_urls]] then picks the top `ad_count` unreviewed URL (`classification IS NULL AND teardown_verdict='unreviewed'`, tiebroken by earliest `first_seen`), dedups on any in-flight `research` job for the workspace, and inserts ONE `kind='research'` `agent_jobs` row carrying `{research_url_id}` in `instructions`. Supersedes the prior daily stub in [[../inngest/acquisition-research-cadence]].
- **Cap** — `MAX_RESEARCH=1` concurrency lane, `RESEARCH_TIMEOUT_MS=30 min`, `RESEARCH_BATCH_CAP=8` URLs per pass. Bumping the batch size is a knob (env-tunable), not a code change.
- **`runResearchJob(job)`** (the runner, in `scripts/builder-worker.ts`):
  1. Read the top-N unreviewed `research_urls` for the workspace, biggest `ad_count` first.
  2. Deterministic capture — dynamically import [[../../scripts/research-capture.ts]] and `captureBatch(...)`: mobile Playwright renders + geometric overlay-kill + DOM-first `<section>` chaptering with a vision-tile fallback ([[../recipes/lander-capture]]). Shots go to the private `research-shots` Storage bucket. Runs EXACTLY ONCE per URL (one-session invariant — no second render).
  3. Any URL whose capture returned `unviewable` after retries is marked `classification='unviewable'` deterministically via [[research-urls]] `setUrlClassification` (Rhea never guesses worthiness of a page she couldn't see — `unviewable ≠ not_worthy`).
  4. Hand the captured manifest to a Max session running the `research` skill (Rhea reads the chapter shots and returns one JSON verdict per URL — for a worthy verdict she ALSO returns a full `teardown` recipe derived from the SAME chapters, no re-render).
  5. Parse Rhea's JSON via `extractJson`, validate against the CHECK-constraint vocab, and apply each decision via [[research-urls]] `setUrlClassification` / `setTeardownVerdict` / `setCaptureRef` — plus, for worthy decisions carrying a `teardown`, `setTeardown` (validator-gated; a half-formed recipe is rejected without leaving the row inconsistent — the classification + verdict already landed). `log_tail` includes `teardowns=<landed>/rejected=<n>` so the Phase-2 verification can observe recipe throughput.
- **Skill** — `.claude/skills/research/SKILL.md` (Rhea's persona + output contract + the erthlabs 8-reasons worked teardown example).
- **Write chokepoint** — every `research_urls` mutation flows through [[research-urls]]. The worker never touches the table directly (CI grep enforces).

## The `storefront-optimizer` lane's Cleo blueprint preamble ([[../specs/cleo-lander-blueprint]] Phase 2)

Every `runStorefrontOptimizerJob` invocation runs a **workspace-scoped preamble** before the per-surface diagnose/propose work: [[cleo-blueprint]] `runCleoBlueprintSweep(workspaceId, {createdBy})`. The preamble reads [[research-urls]] `listNewTeardowns` and per row decides **modify-vs-build-new** via [[cleo-blueprint]] `decideBlueprintForTeardown`:

- **Chain:** [[../tables/research_urls]] (teardown recipe) → **[[../tables/lander_blueprints|blueprint]]** → Carrie's `dr-content` job (fills `content`) → Ada build (`build_submitted`).
- **Blueprint path** (whole missing funnel type): [[lander-blueprints]] `createBlueprint` with the teardown's `transferable_pattern` adapted into `skeleton` + a rationale, then enqueue a deduped `dr-content` [[../tables/agent_jobs]] row (spec_slug = blueprint id, kind = `dr-content`) + [[research-urls]] `markTeardownReviewed`.
- **Bandit path** (single reversible lever — we already have a matching-funnel-type lander): NO blueprint. Cleo's existing storefront-optimizer campaign path handles it unchanged; the sweep just marks the teardown reviewed.
- **North-star + idempotence:** deterministic + within Max's leash; every row surfaces its rationale. The `dr-content` dedup gate + `growth_reviewed_at` watermark hold under retries.
- **Non-fatal:** try/caught — a preamble failure never poisons the per-surface optimizer work.

The `dr-content` kind is registered in `Job.kind` and served by `runDrContentJob` — see below.

## The `dr-content` lane (Carrie's DR-content fill, [[../specs/carrie-dr-content]] Phase 2)

The Growth-owned lane that fills a queued [[../tables/lander_blueprints]] row's `content` bucket — DR copy per skeleton block + a per-image-slot verdict per asset slot (generate → Nano Banana Pro compose + a categorized [[../tables/product_media]] row · flag_gap → a [[../tables/lander_content_gaps]] row for Max). Enforces the never-fake-a-customer-result rail: a real-evidence category (`before_after` / `ugc` / `testimonial_photo` / `press_logo`) is HARD-refused for `generate` in the worker and routed to a gap instead — defense-in-depth even if Carrie's session hallucinates a verdict.

- **Enqueue** — [[cleo-blueprint]] `enqueueDrContentJob` (called by `runCleoBlueprintSweep` — [[../specs/cleo-lander-blueprint]] Phase 2). One `kind='dr-content'` row per newly-landed blueprint, blueprint id in `spec_slug` (dedup-gated on any in-flight `dr-content` job for the same blueprint).
- **Cap** — `MAX_DR_CONTENT=1` concurrency lane, `DR_CONTENT_TIMEOUT_MS=30 min`. Env-tunable (`AGENT_TODO_MAX_DR_CONTENT`).
- **`runDrContentJob(job)`** (the runner, in `scripts/builder-worker.ts`):
  1. Load the blueprint via [[lander-blueprints]] `getBlueprint` (workspace-scoped). Fail if missing; idempotent no-op if the blueprint is already past `content_in_progress` / `awaiting_upload` (never clobber a submitted build).
  2. Load the product's intelligence bundle read-only: `products` (title / target_customer / certifications), `product_ingredients` (with dosages), `product_benefit_selections` (lead + supporting benefits with `customer_phrases`), `product_review_analysis` (phrases the customer used), and the existing categorized [[../tables/product_media]] via [[lander-blueprints]] `listCategorizedProductMedia`.
  3. Pick a **hero reference** (the product's `slot='hero'` image, or a `category='hero'` DR row) — Nano Banana Pro composes from it. No hero → the worker degrades to opening an `other` gap for every generatable slot on the block (a founder resolving with a hero unlocks the next Carrie pass).
  4. Hand the compact bundle to a Max session running the `dr-content` skill. Carrie returns per-block copy + per-image-slot verdicts (JSON).
  5. Parse Carrie's JSON via `extractJson`. Zip her `blocks[]` against the skeleton by role (skeleton is source of truth — a block whose role isn't in the skeleton is DROPPED). Per image slot:
     - **Real-evidence** (`before_after` / `ugc` / `testimonial_photo` / `press_logo`) — reuse-before-flag via [[lander-blueprints]] `findExistingRealAsset(workspaceId, productId, assetRole)` (source<>'generated' hard-filter; category=assetRole match wins, then a legacy slot/alt semantic match — `before_after`←slot `before` / `after`, `press_logo`←slot `press_*`, `testimonial_photo`←slot `endorsement_*_avatar`, `ugc`←slot / alt containing `ugc` / `selfie` / `customer` — so a product that already owns the imagery from the seeding pass is reused even when `category` is null). On a hit, the media URL is written into the blueprint `content` bucket for that block as `{kind:'image_ref', ref:<url>}` and no gap opens (`reused++`). On a miss, [[lander-blueprints]] `openContentGap` (`asset_role`, `block_ref`, plain-language `description`). A `generate` verdict on this category is HARD-refused + logged. An AI-generated row is NEVER eligible to satisfy a real-evidence slot even if its `category` matches — the never-fake-a-customer-result compliance rail, defended at the SDK.
     - **Generatable** (`hero` / `ingredient` / `mechanism` / `lifestyle`) with `generate` — call [[gemini]] `generateNanoBananaProCombine` (identity-locked to the product hero), upload to the `product-media` Storage bucket (`product_id/dr-content/<slug>.<ext>`), and write via [[lander-blueprints]] `writeCategorizedProductMedia` (source='generated', category=`<slot>`, tied to the product). A missing hero degrades to opening an `other` gap.
     - **Fallback** `flag_gap` — open an `other` gap (never-fake extends: the worker never generates an ambiguous asset).
  6. Write the content bucket via [[lander-blueprints]] `setBlueprintContent` (per-block copy + generated media refs + optional CTA).
  7. Advance status via [[lander-blueprints]] `setBlueprintStatus`: zero open gaps → `content_complete`; else `awaiting_upload`. Driven by `listContentGaps(workspaceId, { blueprint_id, status: 'open' })`.
- **Skill** — `.claude/skills/dr-content/SKILL.md` (Carrie's persona + real-vs-AI discipline + output contract).
- **Write chokepoint** — every [[../tables/lander_blueprints]] / [[../tables/lander_content_gaps]] mutation + every DR column on [[../tables/product_media]] (`category` / `source` / `caption`) flows through [[lander-blueprints]]. The worker never touches those tables directly.
- **Approval routing** — a [[../tables/lander_content_gaps]] row is surfaced to Max via [[approval-inbox]] (`ownerFunctionForKind('dr-content') = 'growth'` — Control Tower registry entry `agent:dr-content`).

## The `media-buyer` lane (Media Buyer's Test→Measure→Promote→Kill loop, [[../specs/media-buyer-test-winner-loop]] Phase 2)

The Growth-owned lane that runs the Media Buyer agent's cadence pass. DETERMINISTIC-NODE lane (no Max session) that reads winners + losers + ready-to-test, computes the typed plan via [[media-buyer-agent]] `computeMediaBuyerPlan`, and PERSISTS it through sanctioned chokepoints — the agent never writes Meta objects directly.

- **Enqueue** — external cron (weekly cadence per workspace) inserts a `kind='media-buyer'` [[../tables/agent_jobs]] row, `instructions` (optional JSON) `{ meta_ad_account_id?, cohort_target_count? }`.
- **`runMediaBuyerJob(job)`** (the runner, in `scripts/builder-worker.ts`):
  1. Resolve the target `meta_ad_accounts` — explicit id in `instructions` OR every connected account for the workspace.
  2. Per account: `runMediaBuyerLoop(admin, { workspaceId, metaAdAccountId, cohortTargetCount? })` — [[media-buyer-agent]]'s orchestrator.
  3. Aggregate per-account results into `log_tail` (JSON). Mark completed if any account succeeded; failed if all threw.
- **Writes** (through sanctioned chokepoints only):
  - **Promote / kill** → [[../tables/iteration_actions]] upsert at `status='decided'` (level, object_id, action_type, before/after budget or status, policy_version_id, rationale). [[../meta/execution]] `executeAutonomousActions` picks these up on its next Storefront Iteration Engine Phase 6a pass and calls the Meta Graph via [[meta-ads]] `updateObjectStatus` / `updateObjectBudget`.
  - **Replenish** → [[../tables/ad_publish_jobs]] insert with `origin='media-buyer-test'` + `publish_active=true` + fire `ad-tool/publish-to-meta`. [[media-buyer-publish-gate]] re-checks the cohort before flipping the ad ACTIVE.
  - **Every plan action** → one [[../tables/director_activity]] row (`director_function='growth'`, `action_kind` in `media_buyer_promoted_winner` / `media_buyer_paused_loser` / `media_buyer_replenished_test_cohort` / `media_buyer_replenish_missing_config` / `media_buyer_no_active_policy`) citing source `meta_ad_id` + realized ROAS + policy version. A `media_buyer_pass_completed` heartbeat is ALWAYS emitted so the audit trail proves the pass ran.
- **Policy contract** — no active [[../tables/iteration_policies]] row → the loop is DORMANT; only the `media_buyer_no_active_policy` audit row lands. Seed a conservative policy via `scripts/seed-media-buyer-iteration-policy.ts`.
- **Test-cohort defaults** — the replenish path reads `default_meta_account_id` / `default_meta_page_id` from [[../tables/media_buyer_test_cohorts]]; missing → replenish deferred with `media_buyer_replenish_missing_config`.
- **North-star discipline** — the AGENT never writes Meta objects directly. Every mutating call routes through `iteration_actions` (executor picks up) OR `ad_publish_jobs` (publisher + Phase-1 gate). See [[../operational-rules]] § North star and [[media-buyer-agent]] Gotchas.

## The `media-buyer-grade` lane (Media Buyer action grader, [[../specs/media-buyer-test-winner-loop]] Phase 3)

The Growth-owned lane that scores each concluded Media Buyer action against realized ROAS. DETERMINISTIC-Node lane — no Max session — that reads [[../tables/director_activity]] rows emitted by the [[media-buyer-agent]] cadence pass and UPSERTs one grade row per action to [[../tables/media_buyer_action_grades]].

- **Enqueue** — external cron (weekly cadence per workspace, ideally offset from the media-buyer pass) inserts a `kind='media-buyer-grade'` [[../tables/agent_jobs]] row. Optional `instructions` JSON: `{ limit?: number }` (default 50).
- **`runMediaBuyerGradeJob(job)`** (the runner, in `scripts/builder-worker.ts`):
  1. Call [[media-buyer-grader]] `gradeMediaBuyerActions(admin, { workspaceId, limit })`.
  2. The grader reads UNGRADED [[../tables/director_activity]] rows of kind in `GRADEABLE_ACTION_KINDS` older than `REALIZED_WINDOW_MIN_DAYS` (3d), rolls up realized attribution from [[../tables/meta_attribution_daily]] over `[action + 3d, action + 10d]` per source `meta_ad_id`, calls the pure scorer `scoreMediaBuyerAction`, and UPSERTs `media_buyer_action_grades` keyed on `director_activity_id`.
  3. Log tail carries `{ graded, skipped, errors, first overall grade }` + a compact per-grade summary.
- **The rubric's discipline** — `decision_quality` scores the CALL against decision-time ROAS + the active policy's thresholds; `outcome_quality` scores the REALIZED ROAS at grading time. A sound call that regressed still grades well on decision_quality. See [[media-buyer-grader]] for the per-kind bands.
- **Idempotency guards** — the `.upsert(onConflict='director_activity_id')` + `.select('id')` write pattern collapses re-runs and compare-and-sets so a concurrent grader can't silently no-op. No active policy → grader is a no-op (grading a null-policy action is a category error).
- **Write chokepoint** — [[media-buyer-grader]] `gradeMediaBuyerActions` is the ONLY writer to [[../tables/media_buyer_action_grades]]. The lane never touches the table directly.

## The build-claim gate — five-leg `evaluateClaimTimeBuildGate`

A `kind='build'` job's **claim** (the moment Bo attempts to dispatch it from the queue) is guarded by a **five-leg gate** that runs LAST before dispatch. Goal-member serialization (Phase 1) + goal-mate blocker clearance fit here (post-blocked_by resolution, pre-Vale):

1. **Goal-bound validation** — one-off specs (no goal) pass; a goal-bound spec must have a valid `milestone_id` FK.
2. **Blocked-by clearance** — all `blocked_by` specs must be cleared (shipped for external specs / on goal-branch for goal-mates via `resolveGoalSlugForSpec` / `areSpecsGoalMates`).
3. **Vale review pass** — the spec must carry `vale_pass=true`.
4. **Goal-member serialization** ([[agent-jobs]] `evaluateGoalMemberBuildDispatch`) — goal-bound specs **serialize** (one at a time per goal, in `blocked_by` topological order). A non-claimable goal-member is **requeued** (never parked) so the standing pass re-releases it as the prior sibling merges.
5. **One-off fallback** — if the above passed, claim the job.

Any gate leg failure returns a bounded reason (`blocked-by-unshipped`, `vale-not-passed`, `goal-member-waiting-for-prior-sibling`, etc.) and returns `queued` status (a re-claim on the next standing pass). The guard keeps a `kind='build'` job from dispatching until it's actually ready — preventing "work locked up waiting for approval" scenarios.

## Self-update: force override on an unknown-kind queued job

`maybeSelfUpdate` normally defers under the busy/behind<25 rule so an in-flight sacrosanct lane finishes on its own SHA. That defer is a coarse proxy for "safe to wait" and misses one specific failure: a NEW `agent_jobs.kind` shipped after this worker booted (e.g. `agent:ticket-analyze` from PR #1305). A continuously-busy older worker can't claim the new kind and can't self-update while it's under 25 commits behind, so the new lane sits queued indefinitely.

The `KNOWN_JOB_KINDS` constant next to the `Job.kind` union enumerates every kind the dispatch table serves at boot. Each poll tick, the worker runs a cheap `select kind from agent_jobs where status in ('queued','queued_resume')` probe and passes the first kind NOT in `KNOWN_JOB_KINDS` as `maybeSelfUpdate(sacrosanctActive, forceForUnknownKind)`. When set, that flag skips the busy/behind<25 defer branch and proceeds straight to reset + `process.exit(0)` — the systemd restart onto the shipped code is the ONLY way the box can serve the new lane. Zero effect on the steady state (every shipped kind is in the mirror); the override only fires when the queue proves the running SHA is missing a lane. When adding a new `Job.kind`, add it to `KNOWN_JOB_KINDS` in the same edit — missing an entry there only means the coarse busy-defer holds for that kind, never a wrong claim.

## Phase 2 goal-member PR integration

When a goal-bound spec's PR becomes DIRTY (its `baseRef` goal-branch advanced past the spec's branch — a rebase/rebuild is needed), the standing-pass reconciler ([[agent-jobs]] `reconcileDirtyGoalMemberPrs`) detects it and enqueues a `pr-resolve` job to rebase-or-rebuild. The `runPrResolveJob` handler now reads `pr.base.ref` dynamically ([[github-pr-resolve]] `getPr` extended) and merges into `origin/{baseRef}` (validated as `main` or `goal/*`; falls back to main) instead of hardcoded `origin/main`. This allows a single `pr-resolve` lane to handle both one-off (merge-to-main) and goal-bound (merge-to-goal-branch) PRs seamlessly.

## Ephemeral worktree recovery — `removeWorktreeForBranch` third arm (builder-worktree-self-heal-reclaims-ephemeral-branch-pinned-worktrees)

The **branch-side** cleanup helper `removeWorktreeForBranch(branch)` is called before every `git worktree add -B <branch>` to free any stale worktree that's still pinning `<branch>`. It has three arms:

1. **Primary-held branch** — if the primary repo holds `<branch>`, switch it to main via `ensurePrimaryOnMain` instead of force-removing (the 2026-06-24 safety guard against deleting the live repo — see [[../recipes/build-box-setup]] § "The worker once deleted its own live repo").
2. **Ephemeral worktree** (NEW) — if a non-primary worktree holds `<branch>` from OUTSIDE `BUILDS_DIR` (e.g. `/tmp/sol-reads-moved-wt` created by spec-test or branch-review), free it non-destructively via `git worktree remove --force <path>` + `git worktree prune`. This recovers the branch without routing through the guarded `rm -rf`, so the BUILDS_DIR safety guard stays intact and the removal can never target `REPO_DIR` (the primary is already filtered by the branch===null check + the explicit primary===path comparison above). Observed failure: a build resume re-failed with `fatal: '<branch>' is already used by worktree at /tmp/…` because the stale `/tmp/` tree (registered in git but the dir no longer existed) was not being cleared.
3. **Build worktree** — if a worktree under `BUILDS_DIR` holds `<branch>`, force-remove it via `removeWorktreeDir` (existing arm, unchanged).

After all three arms, a final `git worktree prune` reconciles any stale admin entries.

## Idempotent worktree add — `ensureWorktreeSlotFree` (builder-worktree-prune-before-add)

Every build lane's `git worktree add -B <branch> <wt> <base>` (the fresh path AND the resume path in `runBuildJob`) is preceded by `ensureWorktreeSlotFree(wt)`. It's the PATH-side complement to `removeWorktreeForBranch` (the branch-side helper): the branch-side clears any admin entry holding `<branch>`, the path-side clears any admin entry OR orphan dir at `<wt>` — because `git worktree add` fails with `'<wt>' already exists` whenever the target directory pre-exists, regardless of whether it's a tracked worktree.

The wedge this exists to prevent (2026-07-08 media-buyer-sensor-trust-probe): the target dir `builds/build-<slug>/` pre-existed as an ORPHAN — a lingering `tsconfig.tsbuildinfo` file inside, NOT a registered worktree — from a prior attempt that crashed after the file was written but before the worktree was registered. The bare `git worktree remove --force <wt>` call was a no-op (nothing to remove; the dir was never registered), and the follow-up `git worktree add` failed with `'<wt>' already exists`. `removeWorktreeForBranch` did not help because the branch was never held — only the DIR was orphaned on disk.

`ensureWorktreeSlotFree(wt)` performs the recovery a human would do:

1. `git worktree prune` — reconcile admin state with disk state (a registered worktree whose dir was manually deleted still lists; prune clears that).
2. If `<wt>` IS a registered worktree, `removeWorktreeDir(<wt>)` — force-remove admin entry + best-effort dir remove.
3. Else if `<wt>` exists on disk (the orphan case), `rm -rf <wt>` — guarded to `BUILDS_DIR` via the same resolve check `removeWorktreeDir` uses.
4. Final `git worktree prune` — a registered-remove may have left an admin entry if the dir was already gone.

SAFETY. The helper hard-refuses any path that isn't `BUILDS_DIR` or a child of it (matches `removeWorktreeDir`'s guard, which once destroyed the primary repo — see the 2026-06-24 incident recorded on `removeWorktreeDir`). A caller that passes `REPO_DIR` or any non-`builds/` path gets a `[worktree] ensureWorktreeSlotFree REFUSING …` log and a no-op — the guarded rm-rf can never touch the primary checkout.

## Phase-push recovery — fetch-tip + rebase-retry + single-owner-per-branch ([[../specs/build-worker-rebase-before-push-no-lost-phase-on-branch-race]])

Every phase build accumulates a commit(-set) onto the persistent per-spec branch `claude/build-{slug}` (see [[../lifecycles/spec-goal-branch-pm-flow]] § 2). Three invariants keep a phase build from being lost on a branch race:

1. **Base each phase on the current remote branch tip.** Before `git worktree add -B <branch> <wt> origin/<branch>`, `runBuildJob` does an EXPLICIT `git fetch origin <branch>` (both the fresh AND the resume paths) once `remoteHasBranch` is confirmed. The blanket `git fetch origin` at dispatch entry is too coarse — a concurrent push between it and the worktree add would leave `origin/<branch>` stale (or entirely absent for a branch born after the fetch), so the phase would build on a base older than the true remote tip and its follow-up push would non-fast-forward. The extending-tip log line prints the resolved base SHA so operators can confirm `base == remote branch HEAD` at build start.

2. **Rebase-and-retry ONCE on a non-fast-forward push.** The phase push at end of `runBuildJob` is wrapped: on `git push` failure with stderr matching `non-fast-forward | (fetch first) | rejected.*fetch first | Updates were rejected`, the worker runs `git fetch origin <branch>` + `git rebase origin/<branch>` and retries the push once. `log_tail` records `rebase-retry SUCCESS on <branch> — phase landed on top of the sibling push (no phase work lost)`. A **non-recoverable** push error (auth / network / policy — anything not matching the non-ff regex) still marks the job `failed` with the ORIGINAL push stderr. A **rebase CONFLICT** aborts the rebase (`git rebase --abort`, leaving the worktree clean for the reaper) and marks the job `needs_attention` with BOTH the push and rebase output captured — the phase commit is real work; a silent drop strands the spec mid-build and needs a human to re-kick (real: spec `cx-box-agents-sol-cora-june-...-no-raw-sql`, jobs `a30ad1e5` pushed phase 1 → `a2520180` failed on non-ff and threw its phase away).

3. **Single-owner-per-branch — proactive slug-scoped orphan reap.** At most one build ever holds `claude/build-{slug}` at a time. `reapStaleSiblingBuildsForSlug(slug, { excludeJobId })` finds any active build row (`status ∈ REAP_STALE_STATUSES` — `building`/`claimed`/`queued_resume`) for the slug whose heartbeat is stale (`>= REAP_STALE_MS`, the same cutoff `reapStaleSessions` uses) and transitions it to `failed` via a **compare-and-set** update (`.in("status", REAP_STALE_STATUSES)` on the write closes the read→write race + any concurrent reaper). It's wired into two seams:
    - **`hasActiveBuildForSlug(slug)`** (the auto-build dedup guard) — reap runs FIRST so a dead `building` row can't masquerade as active and either (a) falsely block a legitimate re-enqueue OR (b) end up co-live with a new build the stale-session sweep re-queues seconds later.
    - **`dispatchJob` build path** (called with `excludeJobId = job.id`) — right after claim, before the worktree add, so a freshly-claimed build can never co-exist with a sibling orphan pointing at the same branch. The stale-heartbeat filter alone is safe (a live session in another process bumps its heartbeat every M minutes via `runBoxSession`, so a live process's row is never eligible); the `excludeJobId` ensures we never reap ourselves.

    The orphan lands terminal (`failed`) — the spec's sanctioned "terminal state OR `queued_resume`". Terminal + the sibling-reap running before both the re-enqueue check AND the fresh claim's worktree add together enforce the invariant: the two verification bullets (orphaning + re-enqueue yields exactly one active build; the reaped orphan never sits in a live `building` state racing the new job) hold.

Phases 1 + 2 defend the git-level branch race; Phase 3 defends the row-level queue race. All three run BEFORE any side effect (worktree side effects for phase 1; the push itself for phase 2; the claim gate + worktree add for phase 3), so a wedged state doesn't need a Control-Tower-level backstop for the common case.

## The shared `update(id, patch)` — the `agent_jobs` write chokepoint

Every job kind funnels its status/error/log_tail transitions through `update(id, patch)`. The function is the single seam where a queue-state PATCH becomes real, so both invariants below sit here — no per-lane plumbing.

1. **needs-input-must-carry-a-question** — reject an empty `needs_input` park (no `questions[]` AND no `pending_actions[]`) and repair to `needs_attention` on the fly. Preserved by [[../specs/agent-jobs-update-retry-and-error-surface]] Phase 1.

2. **Bounded retry + typed failure surface on a transient Supabase 5xx** ([[../specs/agent-jobs-update-retry-and-error-surface]] Phase 1). The write goes through `writeAgentJobsUpdateWithRetry` ([[agent-jobs-update-retry]]): it inspects Supabase's `{ error, status }` response instead of firing-and-forgetting, retries the transient class (Cloudflare 521 / edge 5xx / thrown `fetch failed` / `ECONNRESET` / `ETIMEDOUT`) with bounded exponential backoff (default 4 attempts, 250 ms base), and on exhaustion throws `AgentJobsUpdateError` carrying the `jobId` + `attemptedStatus` + last Supabase error. A PostgREST `PGRST*` code or a bug-shaped throw (e.g. `TypeError`) fails fast — retrying a bug just delays the surface. Motivated by the Control Tower's Management-Logs signature `supabase-logs:68fda858b6ae7a63` (repeated `521 PATCH /rest/v1/agent_jobs`), which used to silently drop the transition so the build system's queue lied about what happened.

After a successful write the `needs_attention` classifier fan-out (`stampNeedsAttentionClass`) still runs unchanged — the retry sits INSIDE the guard and BEFORE the classifier, so both existing behaviors are preserved.

## Related

[[../lifecycles/agent-todo-system]] · [[../lifecycles/spec-goal-branch-pm-flow]] · [[agent-jobs]] · [[github-pr-resolve]] · [[approval-inbox]] · [[agent-grader]] · [[claude-health]] · [[../inngest/acquisition-research-cadence]] · [[../inngest/research-sensor]] · [[../recipes/lander-capture]] · [[../recipes/lander-teardown]] · [[research-urls]] · [[cleo-blueprint]] · [[lander-blueprints]] · [[../tables/lander_blueprints]] · [[../tables/lander_content_gaps]] · [[../tables/product_media]] · [[../specs/carrie-dr-content]] · [[../specs/serialize-goal-member-spec-builds]] · [[gemini]] · [[storefront-optimizer-agent]] · [[acquisition-gap-grader]] · [[../operational-rules]]
