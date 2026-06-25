# libraries/spec-drift

**DEPRECATED** (2026-06-24 — [[../specs/spec-readers-from-db-retire-parser]] Phase 3). The spec-drift reconciliation function `reconcileSpecDrift` is **scheduled for deletion** — its core purpose (keeping per-phase status in sync with shipped code) is now handled by [[../specs/spec-readers-from-db-retire-parser]] Phase 1 readers which read `public.spec_phases.status` directly from the DB (no markdown parse needed). 

The remaining live use case is **drift detection** (`runSpecDriftReconciler`) — the hourly backstop that surfaces mismatches between "code on main" and "DB says shipped," for manual operator review via the [[../dashboard/control-tower]]. This function is retained until [[migration-drift-track-table-renames]] folds its table dependency; refer to that spec for the timeline.

**File:** `src/lib/spec-drift.ts` (candidate for retirement)

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

- **`reconcileSpecDrift(workspaceId, slug, opts?)`** → `ReconcileResult` (`{ flipped[], surfaced[], status, reason? }`). The single-spec engine both triggers share: fetch the spec from `main`, decide per-phase, auto-flip the confident ones in one commit, upsert/clear `spec_drift` rows for the rest. `opts.mergedBuildSlugs` (a pre-fetched `Set`) + `opts.rawFromMain` let a sweep skip per-spec queries. Best-effort — never throws.
- **`runSpecDriftReconciler(workspaceId)`** → `{ specsScanned, flipped, surfaced }`. The Control-Tower self-audit sweep (Part B): reconcile every **candidate** spec — live + not yet `shipped`, **plus** any spec with an open `spec_drift` row (so resolutions land). Fetches the merged-build set once and shares it. Driven by [[../inngest/spec-drift-reconcile]].
- **`healBuiltUnstampedPhases(workspaceId)`** → `{ slug, phases[], pr }[]` *(repurpose-spec-drift-reconciler Phase 1)* — self-heal "built-unstamped" phases. After [[../specs/db-driven-specs|db-driven-specs]] made status DERIVE from `spec_phases`, a backfill seeded some phases `planned` whose work had already merged. When the box re-builds such a phase, [[../../scripts/builder-worker]] `findMergedSiblingBuild` no-ops it "already merged via #N" (work on main, NO file changes) and the phase **stays planned** — so the board re-invites a phantom rebuild forever. This is Bo's supervisor: it reads that no-op outcome and stamps the phase shipped. **Conservative detection (strong signal only):** a spec qualifies iff (a) it has ≥1 `spec_phases` row NOT IN (`shipped`,`rejected`) AND (b) a recent `agent_jobs` row (`kind ∈ build,fold`, `status ∈ merged,completed`) whose `error`/`log_tail` matches `/already merged via #(\d+)/` — never the looser "no changes" signal (that matched a genuinely-empty-phase spec). For each match it stamps EVERY non-shipped/non-rejected phase via [[specs-table]] `stampPhaseShipped(ws, slug, position, { pr, merge_sha })` (the leaf write that advances the derived status — the rollup trigger is gone), best-effort-resolving `merge_sha` from the PR's `merge_commit_sha`, and logs ONE [[../tables/director_activity]] row (`healed_built_unstamped`, `actor:'reconciler:spec-drift'`). **Idempotent** + **single-workspace by contract** (the caller passes the canonical PM workspace; it never iterates). Driven by [[../inngest/spec-drift-reconcile]].
- **`getOpenSpecDrift(workspaceId)`** → `SpecDriftRow[]` — open rows, newest-bumped first, for the [[../dashboard/control-tower]] surface.
- **`resolveSpecDrift(workspaceId, slug, phaseIndex?)`** — resolve open rows after an owner flip/dismiss (one phase, or all for the slug).
- **`flipPhaseToShipped(raw, phaseIndex)`** → new markdown — the shared, surgical phase-emoji writer (leading emoji only; flips the H1 ✅ too once every phase is ✅). Used by the auto-flip **and** the one-tap `POST /api/roadmap/spec-drift`, so manual + auto flip identically.
- **`parsePhasesWithLines(raw)`** / **`extractCodePaths(body)`** — line-tracked phase parse (mirrors [[brain-roadmap]] `parseSpec` ordering — heading `## Phase` shape primary, `## Phases` bullet shape fallback) + the path/migration extractor. **Parsing invariants:** (1) **Skip-verification-subsections (PR #562):** H3 `### Phase N` headings are counted ONLY when the nearest preceding H2 is `## Phases` (the PR #557 wrapper case). H3 headings under `## Verification`, `## Completion criteria`, `## Safety / invariants`, `## Background`, or any other H2 section are skipped — the canonical spec shape includes verification subheaders that mirror real phases; without this boundary, they were double-counted, stranding shipped specs with phantom ⏳ phases. (2) **Skip-fenced-code-blocks (skip-fenced-code-blocks):** Both `## Phase` H2 and `### Phase` H3 lines INSIDE a fenced code block (``` or ~~~) are skipped — any spec embedding a canonical-shape EXAMPLE in documentation (Background, Anti-pattern, etc.) would otherwise inflate its phase count with phantom phases. The parser tracks an `inFence` boolean, toggling it whenever a line matches `/^\s*(```|~~~)/`, and skips both phase-heading detection and `## Phase` bullet counting when `inFence` is true. H2 `## Phase N — …` headings outside fences remain unconditionally counted.
- **`fetchSpecRawFromMain(slug)`** → `{ raw, sha } | null` — fetch a spec's markdown from `main` via the GitHub Contents API (the same fetch the reconciler uses; now exported for [[agent-jobs]] `retestOriginIfFixMerged`).
- **`parseFixesLink(raw)`** → `{ origin, checkKeys } | null` *(fix-ship-retests-origin)* — parse a fix spec's machine-readable `**Fixes:** {origin} (check {key}…)` metadata line (stamped by the propose-fix flow). **Strict**: requires the `(check …)` parenthetical so a stray prose "Fixes:" can't false-positive into an unwanted origin re-test; `checkKeys` are the 16-hex [[spec-test-runs]] `checkKey` hashes. First match wins; null when absent.

## Two triggers

- **Root fix (Part A)** — [[agent-jobs]] `reconcileMergedJobs` calls `reconcileSpecDrift` the moment a build PR merges (replaces the old `fetchSpecFromMain` shipped-check), then enqueues a spec-test + auto-queues unblocked dependents if the corrected phases now read shipped. This is where drift originates; closing it here means the cron rarely has work.
- **Backstop (Part B)** — the [[../inngest/spec-drift-reconcile]] cron (~every 30 min) sweeps for residual drift the event missed (box down, PR merged on GitHub directly, spec shipped pre-agent).

## Director-flip auto-revert ([[../specs/ada-director-spec-status-cards]] Phase 3)

The reverse-drift reconciler (`runSpecDriftReconciler`) already detects "DB says shipped, code missing on main." For these suspects, before surfacing as a [[../tables/spec_drift]] row, it now also asks: *was the most recent status flip a director auto-apply?* (`spec_status_history.actor LIKE 'director:%'`, `field='status'`, `to_value='shipped'`).

If yes, it **reverts** the row to the flip's `from_value` (or `in_progress` when null) via `markSpecCardStatus(..., { actor:"drift-reconciler", reason:"director:{fn} flip not backed by merged code" })`, writes one `director_activity` row (`action_kind="reverted_director_flip"`), and does **not** surface a drift row — the row is DB-corrected within ~24h. This is the reversibility backstop the leash relies on for [[../specs/ada-director-spec-status-cards|spec-status]] auto-apply: a recurring mis-flip pattern shows up on the daily watch via the activity rows.

Build-merge-stamped (`merge:<sha>`) and owner-stamped (`owner:<uuid>`) suspects keep the existing **surface-don't-auto-correct** behavior — those signals are trusted, and a missing-code drift there is a genuine "revert / bad merge" the operator must confirm. Tested by `src/lib/spec-drift.test.ts → decideDirectorRevertFromRows`.

## Gotchas

- **Auto-flip needs BOTH signals.** Code-on-main alone only **surfaces** (the owner confirms); a merged build alone never flips a phase whose code isn't there.
- **File-existence is the proxy for "code on main."** A genuinely-pending phase that names only pre-existing files *could* false-flip — bounded by also requiring a merged build, and by fan-out phases typically naming new (absent) artifacts. The surface path + the owner gate are the safety valve.
- **GitHub Contents API per path**, cached per run. The sweep filters to non-shipped candidates to keep the call count bounded.
- **Two phase shapes** — heading (`## Phase N — … ✅`) and bullet (`- ✅ **P1 …**` under `## Phases`). The writer + parser handle both; `phaseIndex` is consistent with the board + `/api/roadmap/status`.

## Related

[[../specs/spec-drift-agent]] · [[../tables/spec_drift]] · [[../inngest/spec-drift-reconcile]] · [[agent-jobs]] · [[brain-roadmap]] · [[../dashboard/control-tower]] · [[../project-management]] · [[../specs/spec-test-agent]]

---

[[../README]] · [[../../CLAUDE]]
