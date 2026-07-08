# libraries/spec-drift

**MARKDOWN PARSER RETIRED, FUNCTION KEPT** ([[../specs/spec-readers-from-db-retire-parser]] Phase 3, 2026-06-26). Phase 3 retired this module's **markdown-emoji drift WRITE path** — `fetchSpecRawFromMain`, `phaseStatesFromRaw`, `parsePhasesWithLines`, `flipPhaseToShipped`, `setEmojiOnLine`, `setH1` are all GONE (no `docs/brain/specs/*.md` fetch, no emoji rewrite). It did NOT delete `reconcileSpecDrift` itself: the function was **migrated to read `public.spec_phases` directly** (via [[specs-table]] `getSpec`) by [[retire-md-reads-from-pm-flow]] Phase 2 and **repurposed** as the live self-heal engine — it auto-stamps confident built-but-unstamped phases on the canonical `spec_phases` row (`stampPhaseShipped`) and surfaces ambiguous ones for owner review.

`reconcileSpecDrift` stays wired into [[../inngest/spec-drift-reconcile]] (the hourly reconciler) and the box worker ([[../lifecycles/roadmap-build-console]]); `runSpecDriftReconciler` / `healBuiltUnstampedPhases` are the sweep entrypoints, with **drift detection** (`detectSpecPhaseAnomalies` + the [[../dashboard/control-tower]] surface) the operator-review backstop. The `spec_drift` table itself is retained until [[migration-drift-track-table-renames]] folds its dependency.

**File:** `src/lib/spec-drift.ts` (DB-sourced; markdown parser retired)

## The evidence model

For each phase that isn't already ✅ (or an explicit ❌ cut), it weighs two independent signals:

1. **Merged build** — a `kind='build'` [[../tables/agent_jobs]] row at `status='merged'` for the spec (the work actually shipped).
2. **Code on main** — every file path / migration the phase *names* exists on `main` (verified live via the GitHub Contents API).

…and acts:

| Merged build | Code on main | Action |
|---|---|---|
| ✅ | ✅ (all named paths) | **auto-flip the phase ✅** (commit to `main`) |
| ✗ | ✅ (all named paths) | **surface** a [[../tables/spec_drift]] row — one-tap owner flip (can't be confident it was this phase's deliberate ship) |
| — | ✗ / phase names no paths | **leave it** — genuinely unbuilt (fan-out / follow-on / mid-build) |

The spec's column then follows from `deriveStatus` over the corrected phases — shipped only when **every** phase is ✅ (so `pdp-refinement-pass` stays in-progress while P3 is real, but P1/P2 read ✅). It only ever rewrites the leading phase emoji (+ a now-consistent H1 ✅); never spec logic, never the **verified** state.

## Exports

- **`reconcileSpecDrift(workspaceId, slug, opts?)`** → `ReconcileResult` (`{ flipped[], surfaced[], status, reason? }`). The single-spec engine both triggers share — fully DB-driven ([[../specs/retire-md-reads-from-pm-flow]] Phase 2): reads the spec via [[specs-table]] `getSpec(workspaceId, slug)` (`spec_phases[i].body` for code-path extraction, `.status` for the per-phase decision; **no** `docs/brain/specs/*.md` HTTP fetch + parse), decides per-phase, and auto-stamps the confident ones via `stampPhaseShipped(workspaceId, slug, position, { pr, merge_sha })` — the merge SHA is best-effort-resolved from the merged build's `pr_number`. Upserts/clears `spec_drift` rows for the ambiguous "code on main, no merged build" cases. `opts.mergedBuildBySlug` (a pre-fetched `Map<slug, { pr }>`) lets a sweep skip per-spec queries. Best-effort — never throws.
- **`runSpecDriftReconciler(workspaceId)`** → `{ specsScanned, flipped, surfaced }`. The Control-Tower self-audit sweep (Part B): reads every **shipped** `spec_phases` row for the workspace including the typed `body` ([[../specs/retire-md-reads-from-pm-flow]] Phase 2 — no markdown re-fetch), verifies its named code paths are on `main`, and surfaces missing-code phases as `spec_drift` rows. Also runs `detectSpecPhaseAnomalies` for orphan / duplicate / provenance-gap surfacing. `flipped` is always 0 (the reconciler never writes status here — surface-don't-auto-correct). Driven by [[../inngest/spec-drift-reconcile]].
- **`detectSpecPhaseAnomalies(workspaceId)`** → `{ orphans, duplicates, provenanceGaps }` *(repurpose-spec-drift-reconciler Phase 2)* — read-only sweep for `spec_phases` anomalies; emits one `director_activity` row per anomaly cluster. See **Anomaly sweep** below.
- **`healBuiltUnstampedPhases(workspaceId)`** → `{ slug, phases[], pr }[]` *(repurpose-spec-drift-reconciler Phase 1)* — self-heal "built-unstamped" phases. After [[../specs/db-driven-specs|db-driven-specs]] made status DERIVE from `spec_phases`, a backfill seeded some phases `planned` whose work had already merged. When the box re-builds such a phase, [[../../scripts/builder-worker]] `findMergedSiblingBuild` no-ops it "already merged via #N" (work on main, NO file changes) and the phase **stays planned** — so the board re-invites a phantom rebuild forever. This is Bo's supervisor: it reads that no-op outcome and stamps the phase shipped. **Two independent signals, both strong:**
  1. **Box auto-merge signal** — a recent `agent_jobs` row (`kind ∈ build,fold`, `status ∈ merged,completed`) whose `error`/`log_tail` matches `/already merged via #(\d+)/` — the pattern the box's own auto-merge hook emits when it no-ops a rebuild.
  2. **GitHub PR MERGED signal** ([[../specs/stamp-phases-on-github-pr-merged]] Phase 1) — for each candidate spec with a `claude/build-{slug}` branch, query GitHub for that branch's PR (via the GitHub REST API); if a PR exists and is EXACTLY `merged_state === "MERGED"` (SHA-agnostic, catches squash-merges), stamp every non-shipped/non-rejected phase shipped. **Fail-closed:** OPEN PRs, CLOSED-without-merge PRs, and ANY GitHub read error (no token, rate limit, API blip, branch/PR not found) result in NO stamp for that spec that pass — skip and let a later pass retry. A branch with BOTH merged and closed-unmerged PRs resolves to the MERGED one.

  For each match from either signal, stamps EVERY non-shipped/non-rejected phase via [[specs-table]] `stampPhaseShipped(ws, slug, position, { pr, merge_sha })` (the leaf write that advances the derived status — the rollup trigger is gone), best-effort-resolving `merge_sha` from the PR's `merge_commit_sha`, and logs ONE [[../tables/director_activity]] row (`healed_built_unstamped`, `actor:'reconciler:spec-drift'`). **Idempotent** + **single-workspace by contract** (the caller passes the canonical PM workspace; it never iterates). Driven by [[../inngest/spec-drift-reconcile]].
- **`reconcileArchivedNotFolded(workspaceId)`** → `{ slug, previous }[]` *(folded-spec-must-stay-folded)* — the **symmetric** backstop to `healBuiltUnstampedPhases`: where that stamps a SHIPPED phase the DB missed, this **folds a DB row the ARCHIVE says is done**. The fold worker moves a spec's markdown to `docs/brain/archive.d/{slug}.md` AND flips `specs.status='folded'`, but the two are **not atomic** (markdown lands on `main` at PR-MERGE, status flips at PR-OPEN) and `folded` is an OVERRIDE-ONLY column a later re-author/reconcile can clobber to NULL — so a slug can end up in archive.d/ (authoritative: shipped + folded) while the DB row reads NULL/`planned`/`in_progress` → the rollup DERIVES an active status → the archived spec re-appears in the board's Planned column AND `cancelJobsForArchivedSpecs` auto-cancels its builds as "spec archived" (**the db-reduce-calls incident**). For every slug in `listArchivedSlugs()` whose `getSpec` row exists with `status != 'folded'`, it re-persists the override via [[specs-table]] `setSpecStatus(ws, slug, 'folded', …)` — **no code-on-main check** (archive.d/ presence IS the proof) — and logs ONE [[../tables/director_activity]] row (`reconciled_archived_not_folded`, `actor:'reconciler:spec-drift'`). **Cannot false-fire** (acts ONLY when the slug is genuinely in archive.d/ AND the DB row is non-folded; never folds an unarchived spec, never authors a missing row). **Idempotent** + **single-workspace by contract** (canonical PM workspace; never iterates). Driven by [[../inngest/spec-drift-reconcile]] + the box standing pass ([[../lifecycles/roadmap-build-console]]).
- **`getOpenSpecDrift(workspaceId)`** → `SpecDriftRow[]` — open rows, newest-bumped first, for the [[../dashboard/control-tower]] surface.
- **`resolveSpecDrift(workspaceId, slug, phaseIndex?)`** — resolve open rows after an owner flip/dismiss (one phase, or all for the slug).
- **`extractCodePaths(body)`** — extract `src|supabase|scripts|remotion|shopify-extension|public|docs/.../*.{ext}` paths + bare migration filenames from a phase body. Used by both `reconcileSpecDrift` and `runSpecDriftReconciler` to decide "are this phase's named artifacts on `main`?"
- **`extractSymbols(body)`** *(ada-standing-pass-reasoning-gate Phase 1)* — extract backtick-quoted identifiers (`` `runFoo` ``, `` `stampPhaseShipped` ``, `` `spec_drift` ``) plus each declared path's basename + stem (module name) from a phase body. Feeds the drift pre-filter's grep leg — a symbol hit anywhere on main distinguishes a moved/renamed artifact from a genuine revert. Length-4 minimum + a small stop-list filter out English filler.
- **`driftPreFilterPhase(workspaceId, slug, phaseIndex)`** → `DriftPreFilterVerdict | null` *(ada-standing-pass-reasoning-gate Phase 1)* — the DETERMINISTIC pre-filter Ada's `runSpecDriftSupervision` runs BEFORE a Max session. Reads the surfaced phase's `body` from `spec_phases`, checks (a) every declared path via `pathExistsOnMain` — all present ⇒ `code-present` (stale surface, auto-resolve); (b) every declared symbol via GitHub code search — any hit ⇒ `code-present` (moved/renamed — the false-positive class the Max prompt itself names, auto-resolve); (c) paths 404 + zero symbols found anywhere ⇒ `code-missing` (high-confidence revert, escalate no-session). Only the residual partial case (paths gone + no symbols to grep) returns `ambiguous`, which the caller sends to the session. Returns `null` on missing token / spec / phase / declared paths. Best-effort — a read failure falls through to `ambiguous` (safer default: still session-verified). Also short-circuits with `code-present` + goal-pending reasoning when the spec is a goal-member whose goal has not yet promoted to main (see **Goal-branch exemption** below).
- **`isGoalPendingPromotion(milestoneId, goals)`** → `{ pending, goalSlug, goalTitle }` *([[../specs/reese-goal-aware-drift-and-confirmed-reverse-drift-reaches-the-ceo-inbox]] Phase 1)* — pure helper. `pending:true` iff the spec's `milestone_id` links to a milestone in a goal whose `goals.main_merge_sha` is null. Standalone specs (no milestone_id) and unknown milestones return `pending:false` — fail-safe (never suppresses a real drift). Feeds both `runSpecDriftReconciler` (skips such specs from the suspect set) and `driftPreFilterPhase` (short-circuits with a goal-pending reasoning).
- **`reverseDriftDedupeKey({ workspaceId, specSlug, phaseIndex })`** → string *([[../specs/reese-goal-aware-drift-and-confirmed-reverse-drift-reaches-the-ceo-inbox]] Phase 2)* — stable per-(workspace, spec, phase) key (`spec-drift-reverse:{ws}:{slug}:{index}`). A re-surfaced same drift row yields the same key, so the CEO-inbox emitter refreshes the OPEN card instead of minting a duplicate. Pure — testable without DB.
- **`buildReverseDriftInboxRow({ workspaceId, specSlug, phaseIndex, phaseTitle, detail, driftRowId })`** → `ReverseDriftInboxRow` *([[../specs/reese-goal-aware-drift-and-confirmed-reverse-drift-reaches-the-ceo-inbox]] Phase 2)* — pure builder for the `dashboard_notifications` row shape used to route a confirmed reverse-drift to the CEO inbox. Title names the spec + phase + code-missing failure mode; body names the CEO's next-action choices (rebuild / confirm revert / downgrade); metadata carries the escalate_founder contract (`routed_to_function:'ceo'`, `escalation_kind:'spec_drift_reverse'`, `raised_by_function:'platform'`, `dedupe_key`, `spec_slug`, `phase_index`, `phase_title`, `drift_row_id`). Title/body/reason are length-capped so a pathological detail can't overflow the notification column.
- **`emitReverseDriftInboxItem(admin, input)`** → `{ emitted, reSurfaced, error? }` *([[../specs/reese-goal-aware-drift-and-confirmed-reverse-drift-reaches-the-ceo-inbox]] Phase 2)* — the CEO-inbox emitter. De-dupe read narrowed by `(workspace_id, type='agent_approval_request', metadata->>dedupe_key, dismissed=false)`; when an OPEN card matches, the update re-asserts the same four predicates (compare-and-set so a concurrent dismiss can't be clobbered by a late re-surface); otherwise inserts a new row. A dismissed card is NOT counted as open — the founder dismissing the card + Reese re-confirming the same drift is a legitimate re-surface that mints a new card.

## Two triggers

- **Root fix (Part A)** — [[agent-jobs]] `reconcileMergedJobs` calls `reconcileSpecDrift` the moment a build PR merges (replaces the old `fetchSpecFromMain` shipped-check), then enqueues a spec-test + auto-queues unblocked dependents if the corrected phases now read shipped. This is where drift originates; closing it here means the cron rarely has work.
- **Backstop (Part B)** — the [[../inngest/spec-drift-reconcile]] cron (~every 30 min) sweeps for residual drift the event missed (box down, PR merged on GitHub directly, spec shipped pre-agent).

## Anomaly sweep ([[../specs/repurpose-spec-drift-reconciler]] Phase 2)

Status is now DERIVED from `spec_phases`, so the reconciler **no longer writes** `spec_card_state.status` (and no longer appends `spec_status_history` rows for that derived field). The director-flip auto-revert (`markSpecCardStatus(..., { actor:"drift-reconciler" })`) is gone with it — every "DB says shipped, code missing on main" suspect goes straight to the surface path (`spec_drift` row, owner confirms via the [[../dashboard/control-tower]]).

`runSpecDriftReconciler` now also runs **`detectSpecPhaseAnomalies(workspaceId)`** — a read-only sweep for genuine `spec_phases` anomalies the auto-healer can't fix. One [[../tables/director_activity]] row per spec/kind (`action_kind="spec_phases_anomaly"`, `director_function="platform"`, `actor:"reconciler:spec-drift"`):

| Kind | Detection | Why it's an anomaly |
|---|---|---|
| `orphan` | A `spec_phases` row whose `spec_id` has no parent `specs` row | The FK `ON DELETE CASCADE` should have killed it on parent delete — a survivor is a data-integrity bug |
| `duplicate_position` | Two `spec_phases` rows share `(spec_id, position)` | The unique index `spec_phases_spec_position` should prevent this — a survivor means the index is missing/dropped |
| `provenance_gap` | A `status='shipped'` row with both `pr` IS NULL and `merge_sha` IS NULL | A stamp landed without recording the merge — the per-phase PR chip can't render, audit trail loses the shipping commit |

**Surface-don't-auto-correct (North star).** The reconciler never auto-deduplicates a `duplicate_position` cluster (which row carries the truth?) and never backfills a `provenance_gap` (the merge it should reference may not exist). It surfaces; the director triages.

## Gotchas

- **Auto-flip needs BOTH signals.** Code-on-main alone only **surfaces** (the owner confirms); a merged build alone never flips a phase whose code isn't there.
- **File-existence is the proxy for "code on main."** A genuinely-pending phase that names only pre-existing files *could* false-stamp — bounded by also requiring a merged build, and by fan-out phases typically naming new (absent) artifacts. The surface path + the owner gate are the safety valve.
- **GitHub Contents API per path**, cached per run. The sweep filters to non-shipped candidates to keep the call count bounded.
- **`stampPhaseShipped` is the only writeback.** No more markdown emoji rewrite + commit ([[../specs/retire-md-reads-from-pm-flow]] Phase 2 retired the `flipPhaseToShipped` markdown writer). The leaf write advances the now-derived `specs.status` via the rollup readers.

## Goal-branch exemption ([[../specs/reese-goal-aware-drift-and-confirmed-reverse-drift-reaches-the-ceo-inbox]] Phase 1)

**A shipped goal-member phase whose goal has not yet promoted to main is `goal-pending`, not drift.**

A goal-member spec's `claude/build-{slug}` branch merges onto `goal/{goal-slug}` (M4 — stamps `specs.goal_branch_sha`), **not** onto `main`. The goal's own `claude/goal-{slug}` branch only lands on `main` atomically at M5 (stamps `goals.main_merge_sha`). Between M4 and M5 the phase's code is on the goal branch, not main — a shipped phase in that window looks "code missing from main" to a naive path check, and the reconciler used to open a reverse-drift row against a phase that was accumulating normally (the three currently-open Sol false-positives, 2026-07).

The `isGoalPendingPromotion(spec.milestone_id, goals)` guard fixes this at both entry points:

- **`runSpecDriftReconciler`** loads the goal list once, then skips any spec whose `milestone_id` links to a milestone in a goal with `main_merge_sha === null`. Those specs never enter the suspect set → `syncReverseDriftRows` auto-resolves any existing OPEN drift row for them (the workspace-wide "resolve any open row not in the current suspect set" cleanup handles the three Sol rows automatically on the next :20/:50 cron).
- **`driftPreFilterPhase`** short-circuits with `verdict:'code-present'` + a goal-pending reasoning, so a stale drift row against a goal-pending spec resolves without a Max session and without escalation.

Once the goal promotes (`main_merge_sha` set), the guard returns `pending:false` and the normal on-main check applies — a genuine post-merge revert still opens a drift row. **Fail-open:** a `listGoals` read failure falls back to the non-goal-aware scan (never suppress a real drift on a hiccup).

## Confirmed reverse-drift → CEO inbox ([[../specs/reese-goal-aware-drift-and-confirmed-reverse-drift-reaches-the-ceo-inbox]] Phase 2)

**A confirmed reverse-drift creates a CEO inbox item in addition to the director-board post.**

Before this phase a confirmed reverse-drift only reached the CEO as a `postDirectorMessage` on the #directors board — easy to miss when the board scrolls or the founder isn't looking at it. The board post STAYS (the CS/DevOps rooms still need the visibility), but each confirmed reverse-drift ALSO surfaces as an actionable CEO inbox item on the same `dashboard_notifications` `agent_approval_request` surface every other `escalate_founder` card uses (see [[../dashboard/agents]] + the approvals feed) — so it appears alongside the founder's other approvals with the spec + phase + missing-code detail and a Roadmap deep-link where the CEO acts (rebuild the phase / confirm an intentional revert / downgrade the status).

**Emission points** — the confirmed[] branch of `runSpecDriftSupervision`, both:
1. **Pre-filter `code-missing`** verdicts (high-confidence revert, no Max session), and
2. **Batched session `code-missing`** verdicts (the residual ambiguous case Ada judged).

Both push a struct to `confirmed[]` carrying `{specSlug, phaseIndex, phaseTitle, detail, driftRowId, reason}`, and the post-loop calls `emitReverseDriftInboxItem` per entry (best-effort — a Supabase error on one item never blocks the rest, the board post above already ran).

**De-dupe** — `metadata.dedupe_key` = `spec-drift-reverse:{ws}:{slug}:{phaseIndex}`. The emitter reads for an OPEN card with the same key (workspace + type + dedupe + `dismissed=false`); when found, it updates the card's title/body/metadata as a compare-and-set on the same four predicates (so a concurrent dismiss between the read and the write is not clobbered). This is the "does not create a duplicate inbox item" contract — a persistent drift row refreshes the existing card every ~30-min pass, and only a founder dismiss + re-confirmation mints a new one.

## Ada's supervision lane pre-filter ([[../specs/ada-standing-pass-reasoning-gate]] Phase 1)

`runSpecDriftSupervision` (`scripts/builder-worker.ts`) reviews the open `spec_drift` rows this reconciler surfaces. It used to spawn a FRESH Max session per open row (cap 5) to answer "does this shipped phase's code still exist on main?" — Phase 1 gates that on a deterministic PRE-FILTER + a ROW-ID DEDUP so a session fires ONLY on the residual judgment case:

1. **Pre-filter** — `driftPreFilterPhase` combines the reconciler's own path check (via `pathExistsOnMain`) with a repo-wide `extractSymbols` grep on main (GitHub code search). Symbol hit anywhere ⇒ auto-resolve `code-present` via `resolveDriftRow`; declared-path 404 + zero symbol hits ⇒ escalate `code-missing` (surface to the CEO + keep the row open) — both WITHOUT a session. Only a partial/ambiguous match (paths gone + no symbols to grep) falls through to the Max session.
2. **Row-id dedup** — every terminal verdict (pre-filter OR session) stamps a `director_activity` row (`action_kind='drift_supervised'`, `metadata.drift_row_id=<row.id>`). The `alreadyDriftSupervised` reader skips a row the ledger already covers, so `code-missing` / `unsure` verdicts (which keep the row open) don't re-fire a session every pass. When the reconciler re-detects the same drift, it CREATES A NEW row with a NEW id → the ledger cleanly re-investigates it (content-change trigger).

The Max session prompt now includes the pre-filter's reasoning + the specific symbols/paths it found or missed, so Ada judges the residual case with the full deterministic context — no re-derivation.

**Batched residual reasoning ([[../specs/ada-standing-pass-reasoning-gate]] Phase 3):** the ambiguous rows that survive Phase 1's pre-filter are collected into ONE batched Max session per pass (via `runBatchedDirectorSession` in the worker), NOT one cold session per ambiguous row. Each ambiguous row is a keyed section in the batched prompt carrying its own detail + pre-filter output; the model returns a JSON `verdicts` array; the worker applies each verdict to its row (`resolveDriftRow` on `code-present`, escalate on `code-missing`, leave-open on `unsure`) and stamps the row-id ledger. Hydration is paid ONCE per pass regardless of how many rows are ambiguous.

## Related

[[../specs/spec-drift-agent]] · [[../tables/spec_drift]] · [[../inngest/spec-drift-reconcile]] · [[agent-jobs]] · [[brain-roadmap]] · [[../dashboard/control-tower]] · [[../project-management]] · [[../specs/spec-readers-from-db-retire-parser]] · [[../specs/spec-test-agent]] · [[../specs/ada-standing-pass-reasoning-gate]]

---

[[../README]] · [[../../CLAUDE]]
