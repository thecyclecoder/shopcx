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
- **`healBuiltUnstampedPhases(workspaceId)`** → `{ slug, phases[], pr }[]` *(repurpose-spec-drift-reconciler Phase 1)* — self-heal "built-unstamped" phases. After [[../specs/db-driven-specs|db-driven-specs]] made status DERIVE from `spec_phases`, a backfill seeded some phases `planned` whose work had already merged. When the box re-builds such a phase, [[../../scripts/builder-worker]] `findMergedSiblingBuild` no-ops it "already merged via #N" (work on main, NO file changes) and the phase **stays planned** — so the board re-invites a phantom rebuild forever. This is Bo's supervisor: it reads that no-op outcome and stamps the phase shipped. **Conservative detection (strong signal only):** a spec qualifies iff (a) it has ≥1 `spec_phases` row NOT IN (`shipped`,`rejected`) AND (b) a recent `agent_jobs` row (`kind ∈ build,fold`, `status ∈ merged,completed`) whose `error`/`log_tail` matches `/already merged via #(\d+)/` — never the looser "no changes" signal (that matched a genuinely-empty-phase spec). For each match it stamps EVERY non-shipped/non-rejected phase via [[specs-table]] `stampPhaseShipped(ws, slug, position, { pr, merge_sha })` (the leaf write that advances the derived status — the rollup trigger is gone), best-effort-resolving `merge_sha` from the PR's `merge_commit_sha`, and logs ONE [[../tables/director_activity]] row (`healed_built_unstamped`, `actor:'reconciler:spec-drift'`). **Idempotent** + **single-workspace by contract** (the caller passes the canonical PM workspace; it never iterates). Driven by [[../inngest/spec-drift-reconcile]].
- **`getOpenSpecDrift(workspaceId)`** → `SpecDriftRow[]` — open rows, newest-bumped first, for the [[../dashboard/control-tower]] surface.
- **`resolveSpecDrift(workspaceId, slug, phaseIndex?)`** — resolve open rows after an owner flip/dismiss (one phase, or all for the slug).
- **`extractCodePaths(body)`** — extract `src|supabase|scripts|remotion|shopify-extension|public|docs/.../*.{ext}` paths + bare migration filenames from a phase body. Used by both `reconcileSpecDrift` and `runSpecDriftReconciler` to decide "are this phase's named artifacts on `main`?"

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

## Related

[[../specs/spec-drift-agent]] · [[../tables/spec_drift]] · [[../inngest/spec-drift-reconcile]] · [[agent-jobs]] · [[brain-roadmap]] · [[../dashboard/control-tower]] · [[../project-management]] · [[../specs/spec-readers-from-db-retire-parser]] · [[../specs/spec-test-agent]]

---

[[../README]] · [[../../CLAUDE]]
