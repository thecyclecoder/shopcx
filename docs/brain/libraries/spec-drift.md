# libraries/spec-drift

The **Spec-Drift Agent** ([[../specs/spec-drift-agent]]) — keeps a spec's per-phase status in [[../tables/spec_card_state]] in sync with shipped code, so shipped work stops parking in the Planned/In-progress columns. The flip side of [[../specs/spec-test-agent|spec-test]]: that proves a *shipped* spec works; this proves a spec's *status* is true. **Per-phase + evidence-gated** — it never guesses "merged ⇒ done".

**spec-status-db-driven Phase 2** (2026-06-24): the reconciler no longer commits the spec markdown to `main` on a flip. It writes the DB mirror (`spec_card_state`) directly — instant, zero deploys. The markdown is still parsed off `main` (for the phase body + named code paths), but the flip lands in the DB.

**File:** `src/lib/spec-drift.ts`

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
- **`getOpenSpecDrift(workspaceId)`** → `SpecDriftRow[]` — open rows, newest-bumped first, for the [[../dashboard/control-tower]] surface.
- **`resolveSpecDrift(workspaceId, slug, phaseIndex?)`** — resolve open rows after an owner flip/dismiss (one phase, or all for the slug).
- **`flipPhaseToShipped(raw, phaseIndex)`** → new markdown — the shared, surgical phase-emoji writer (leading emoji only; flips the H1 ✅ too once every phase is ✅). Used by the auto-flip **and** the one-tap `POST /api/roadmap/spec-drift`, so manual + auto flip identically.
- **`parsePhasesWithLines(raw)`** / **`extractCodePaths(body)`** — line-tracked phase parse (mirrors [[brain-roadmap]] `parseSpec` ordering — heading `## Phase` shape primary, `## Phases` bullet shape fallback) + the path/migration extractor. **Boundary rule (skip-verification-subsections):** H3 `### Phase N` headings are counted ONLY when the nearest preceding H2 is `## Phases` (the PR #557 wrapper case). H3 headings under `## Verification`, `## Completion criteria`, `## Safety / invariants`, `## Background`, or any other H2 section are skipped (the canonical spec shape includes verification subheaders that mirror real phases — without this boundary, they were double-counted, stranding shipped specs with phantom ⏳ phases). H2 `## Phase N — …` headings remain unconditionally counted.
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
