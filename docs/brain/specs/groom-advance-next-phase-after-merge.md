# Groom-continue: a merged phase advances the next phase, not a cooldown ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[board-grooming]] — fixes the partially-shipped-spec advance path under [[../goals/devops-director]]
**Found in use 2026-06-24:** the CEO asked why partially-shipped specs aren't being advanced. Specs are deliberately chunked into ~30-min, box-sized phases; the FEATURE only works once every phase lands, so a spec sitting at P1✅ P2✅ P3⏳ with no active build should have P3 queued NOW. Concrete case: [[agent-outage-resilience]] — P2 merged 2026-06-23 19:05, P3 (the residual no-swallow audit) was never queued, and my board-groom pass skipped it.

## The bug

[[../libraries/platform-director]] `findGroomCandidates` excludes any spec where `specBuildState(...).inFlight` is true. `specBuildState` classifies EVERY non-failed build status — including `completed` / `merged` — as `inFlight=true` over a 7-day window. So a spec whose prior phase just **merged** looks in-flight for up to 7 days, and grooming refuses to advance its next ⏳ phase during exactly the window when it should. This is the code embodiment of a wrong "let the spec settle" instinct: a landed phase should TRIGGER the next phase, not start a cooldown.

The builder chain (`queueNextChainedPhase` / auto-ship) is supposed to queue the next phase on merge, and grooming is the backstop for specs the chain didn't carry — but the backstop is suppressed by the same merged-build-as-in-flight reading, so a phase the chain misses sits indefinitely.

## Phase 1 — split 'active build' from 'a prior phase landed' ⏳
- Add a distinct signal to `specBuildState` (e.g. `activeBuild`) that is true ONLY for a build in an ACTIVE state for the spec — `queued` / `building` / `needs_input` / `needs_approval` / `queued_resume` — and treat `completed` / `merged` as NOT a reason to skip grooming. Keep the existing `inFlight` for back-compat callers (the escort's duplicate-guard), but have `findGroomCandidates` gate on `activeBuild` instead, so a spec with only landed (merged/completed) builds and a remaining ⏳ phase becomes a groom candidate.
- A spec with an active build for its NEXT phase is still skipped (no duplicate queue). The loop-guard is unchanged: ≥ `PLATFORM_DIRECTOR_LOOP_GUARD_MAX` failed attempts with nothing active still escalates instead of resubmitting.
- The groom investigation's continue/split/escalate judgment is unchanged — this only fixes WHICH specs reach it. A continue still queues the next phase build via the existing chain; a future-work leftover still splits; an ambiguous one still escalates.
- Brain: [[../libraries/platform-director]] (`findGroomCandidates`, `specBuildState`, `SpecBuildState`) · [[board-grooming]].

### Verification — Phase 1
- With Platform live+autonomous, a partially-shipped platform-owned spec (≥1 ✅, ≥1 ⏳, no ACTIVE build) whose prior phase merged within 7 days now appears as a `findGroomCandidates` candidate (previously excluded). agent-outage-resilience P3 is queued on the next standing pass with a `groomed_continue` [[../tables/director_activity]] row.
- A spec with an active (queued/building/needs_approval) build for its next phase is still NOT re-queued (no duplicate).
- A spec whose next-phase build failed ≥ loop-guard cap still escalates, not resubmits.

## Open decision (for the CEO) — grooming scope while only Platform is live
`findGroomCandidates` is owner-agnostic, so fixing the filter will also make me advance **Growth/CMO-owned** half-built specs (experiment-session-stamped-attribution P3.5, growth-acquisition-roas-spine P4, pdp-experiment-wiring P2) before those directors are live+autonomous. Decide before/when building: (a) keep grooming owner-agnostic — finish anything half-built regardless of owner; or (b) scope groom-continue to platform-owned specs until the owning director is live (add an owner gate mirroring the escorts). Default in this spec is (a) — the existing board-grooming design — but it is a one-line gate to switch to (b).