# Spec-Drift Agent — keep phase emojis in sync with shipped code ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[roadmap-build-console]] + [[control-tower]]. Box-agent family. The flip side of [[spec-test-deep-verification]]: that proves a *shipped* spec works; this proves a spec's *status* is true.

Builds keep merging without their phase emoji flipping ⏳/🚧 → ✅, so **shipped work parks in the Planned/In-progress columns** (caught by hand: `iteration-scorecard-upsert-resilience` + `spec-test-maximize-machine-coverage` both sat mislabeled). The build pipeline is *supposed* to stamp ✅ on merge but doesn't reliably. Fix the root + add a reconciler — but **reason per-phase**, because a blunt "build merged ⇒ ship the spec" check over-flags multi-phase specs with genuinely-pending later phases (`pdp-refinement-pass` P3 fan-out, `winning-static-creative-finder` P6 video are *correctly* unshipped).

## Two parts
### A) Root fix — the build stamps the phase it built ✅ on merge
When a build's PR merges, the phase(s) that build implemented flip to ✅ **in the spec markdown**, verified against code-on-main. This is where the drift originates; close it so the reconciler rarely has work. (Hook the existing merge path — `reconcileMergedJobs` / the green-check writeback in [[spec-test-maximize-machine-coverage]] already commits ✅ to a spec file via the Contents API; reuse that writer.)

### B) Reconciler — catch + correct residual drift, per-phase
A check (Control-Tower self-audit style + event-on-merge) that, for each spec, compares its **phase emojis** against **merged-build evidence + code-on-main**:
- A phase whose build **merged AND** whose claimed code is verifiably on `main` (the files/exports/migrations it names exist) but whose emoji is still ⏳/🚧 → **flip that phase ✅** (commit to main).
- **Never flip a phase whose code isn't on main** (genuinely unbuilt: a fan-out phase, a deferred follow-on, an un-queued phase). It reconciles against *evidence*, never guesses "merged ⇒ done".
- The spec's column then follows from `deriveStatus` over the corrected phases — a spec is "shipped" only when **every** phase is ✅ (so `pdp-refinement-pass` stays in-progress while P3 is real, but its P1/P2 read ✅ accurately).
- A spec where code-is-shipped-but-phase-stale that the agent **can't** confidently auto-flip (ambiguous which phase the merge completed) → **surface on the Control Tower** ("spec drift: {slug} — P{n} code on main but ⏳") for a one-tap owner flip, rather than a wrong auto-flip.

## Guardrails
- **Evidence-gated:** flip a phase ✅ only with a merged build + verifiable code-on-main; otherwise leave it / surface it. Never marks a spec verified (that's the owner's Verify gate) — only reconciles planned↔shipped phase truth.
- **Per-phase, never whole-spec:** a genuinely-pending phase (fan-out, follow-on) is untouched.
- Only edits the leading phase emoji in `docs/brain/specs/{slug}.md` (never spec logic), committed to main — same blast-radius as the green-check writeback.

## Verification
- On `/dashboard/branches`, squash-merge a build PR for a single-phase spec whose code is on `main` while its phase + H1 still read ⏳ → expect the spec markdown on `main` to get a `spec-drift: flip P1 → ✅` commit (phase + H1 flip), and on `/dashboard/roadmap` the card moves to Shipped without a human.
- On a multi-phase spec where an early phase's code is on `main` but a later phase names files that don't exist yet (e.g. `pdp-refinement-pass`: P1 references real `scripts/…`/migration files, P3 fan-out names none), run the reconciler → expect only the built phase flips ✅; the later phase stays ⏳ and the spec stays in-progress on the board (a `git log docs/brain/specs/pdp-refinement-pass.md` shows P1 flipped, P3 untouched).
- Inject drift: pick a shipped-but-mislabeled spec (code on `main`, a merged `kind='build'` agent_job, phase still ⏳), wait one `spec-drift-reconcile` cron tick (~30 min, `20,50 * * * *`) → expect the phase auto-flips ✅ on `main`; confirm via the cron's heartbeat on `/dashboard/developer/control-tower` (Spec-drift reconciler tile → `produced: … flipped: N`).
- On `/dashboard/developer/control-tower`, the **Spec drift** section lists any phase whose code is on `main` with **no** merged build on record → tap **Mark P{n} ✅** → expect a `spec-drift: owner flip … → ✅` commit on `main`, the row disappears, and the board card updates; tap **Dismiss** on another → expect the row clears with no markdown change.
- Negative: a planned phase with no merged build **and** whose named files aren't on `main` (or that names no file paths) is **never** flipped and **never** surfaced — confirm `winning-static-creative-finder` P6 (video follow-on) stays ⏳ across a reconcile and produces no `spec_drift` row.
- Negative: the agent never sets a spec to **verified** / never writes to `archive.d/` — only ⏳/🚧 → ✅ phase-emoji edits appear in `git log` for the touched specs.

## Phase 1 — merge-stamp + per-phase reconciler + drift surfacing ✅
Part A (stamp the built phase ✅ on merge, reusing the spec-file writeback) + Part B (the per-phase, evidence-gated reconciler — event-on-merge + a Control Tower self-audit backstop that surfaces ambiguous drift). Brain: [[../libraries/brain-roadmap]] · [[../libraries/agent-jobs]] (reconcileMergedJobs) · [[control-tower]] · [[../project-management]] (status truth).

**Shipped:** `src/lib/spec-drift.ts` (the per-phase, evidence-gated engine — `reconcileSpecDrift` / `runSpecDriftReconciler` / `flipPhaseToShipped` / `getOpenSpecDrift` / `resolveSpecDrift`) · Part A wired into `src/lib/agent-jobs.ts` `reconcileMergedJobs` (replaces the old `fetchSpecFromMain` shipped-check) · Part B in `src/lib/inngest/spec-drift-reconcile.ts` (cron `20,50 * * * *`, registered in `control-tower/registry.ts` + `api/inngest/route.ts`) · the one-tap owner flip/dismiss `src/app/api/roadmap/spec-drift/route.ts` · the Control Tower "Spec drift" section (`dashboard/developer/control-tower/page.tsx`, fed by `getOpenSpecDrift` on the snapshot route) · the `spec_drift` table (`supabase/migrations/20260622170000_spec_drift.sql`). Brain pages: [[../libraries/spec-drift]] · [[../tables/spec_drift]] · [[../inngest/spec-drift-reconcile]].
