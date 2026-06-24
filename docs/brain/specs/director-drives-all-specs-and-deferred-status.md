# Every spec is the director's to drive + a first-class Deferred status ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] + [[board-grooming]] — generalizes the auto-build lanes to all owners under [[../goals/devops-director]]
**Found in use 2026-06-24:** the CEO established the operating principle — 'the existence of a spec means it's the director's to drive; CS/Growth won't queue their own builds.' Today the initiation lane ([[director-initialize-platform-specs-no-wait]] P2) and `escortFixSpecs` are gated to `owner === platform`, so other departments' Planned specs (e.g. [[portal-remediation-recognize-would-remove-last-item]] (CS), three Growth specs) never start — and those directors aren't live to start them. The exception is DEFERRED work, which has no first-class status today (only a `**Deferred:**` marker line) — the CEO wants a dedicated board column so Planned (start it) is cleanly separated from Deferred (leave it).

## North star — drive everything, but the rails hold

Widening WHICH specs the director drives does not loosen the leash. A spec is only auto-initiated after the read-only soundness investigation confirms it's sound (critical now that the director touches unfamiliar domains — storefront, portal); the loop-guard still stops a repeatedly-failing build; and the hard rails are unchanged — destructive/irreversible escalates, a NEW goal still needs the CEO's greenlight, anything unconfirmable escalates. 'Every spec is mine' = I own driving it to a terminal state (built / deferred / escalated), not blind-merging it.

## Phase 1 — the Deferred status + board column (the exclusion signal, lands FIRST) ⏳
- Add a first-class `deferred` spec status to [[../libraries/brain-roadmap]] `deriveSpecStatus`: a spec is `deferred` when it carries a `**Deferred:**` marker (already authored by [[board-grooming]] splits) or an explicit `**Status:** deferred`. Render it as its OWN board column on the [[../dashboard/roadmap|roadmap board]], distinct from Planned / In-progress / Shipped.
- ALL auto-build lanes (initiation, fix-escort, grooming, goal-escort) EXCLUDE `deferred` specs. Only the CEO un-defers (promotes back to Planned) to make one startable. This lands first so widening the drive (Phase 2) can never accidentally start deferred work.
- The existing board-grooming split cards (carrying `**Deferred:**`) become the natural population of the column — no migration, no conflict.
- Brain: [[../libraries/brain-roadmap]] · [[../dashboard/roadmap]] · [[board-grooming]].

### Verification — Phase 1
- A spec with a `**Deferred:**` marker renders in the Deferred column and is skipped by every auto-build lane. Promoting it to Planned (removing the marker) makes it a normal initiation candidate. Planned / In-progress / Shipped columns are unchanged.

## Phase 2 — owner-agnostic drive, routed 'first live boss else up' ⏳
- Remove the `owner === platform` gate from the initiation lane and `escortFixSpecs`, so ANY unblocked, non-deferred, unstarted (0 ✅) spec is a drive candidate regardless of owner. Grooming is already owner-agnostic (keep). Net: Planned → I initiate (after the soundness check), In-progress-with-⏳ → I progress its phases, Deferred → I leave it.
- Route the drive via the existing keystone ([[../libraries/approval-router]] `resolveApprover` / `resolveApproverLive`): a spec is driven by its OWNING function's director if that director is live+autonomous, ELSE it flows up to the platform director (me). Today only platform is live, so I drive everything non-deferred; as Growth/CS/CMO directors go live, their specs auto-rebalance to them — no re-spec needed.
- Keep the per-spec soundness investigation for non-fix FEATURE specs (especially cross-domain); repair/regression-signed FIXES build straight through (already-greenlit mandate). Loop-guard + escalation rails unchanged.
- Brain: [[../libraries/platform-director]] (`escortFixSpecs`, the initiation lane) · [[../libraries/approval-router]] · [[director-initialize-platform-specs-no-wait]].

### Verification — Phase 2
- With only platform live, the four cross-dept Planned specs (portal-remediation-recognize-would-remove-last-item, creative-finder-video, growth-acquisition-roas-spine-report-contract, iteration-ingest-async-reports) become initiation candidates and get queued (each after a passing soundness check) — none requiring a CEO Build click. A deferred spec is still skipped. A blocked spec still waits. A destructive/ambiguous one still escalates.
- (Routing) If a non-platform director were flipped live+autonomous, its owned specs route to IT, not me (the keystone fallback only catches specs whose owner-director isn't live).

## Phase 3 — the board + activity reflect cross-dept drive ⏳
- Activity rows + the daily board-watch note when the platform director drives another department's spec (owner shown, driver = me), so you can see the keystone covering for not-yet-live directors. Surfaces on the [[Platform Department Scorecard]].

### Verification — Phase 3
- Driving a CS/Growth spec writes an activity row naming the owning function + the driver; the daily watch reports specs driven across departments.

## Open decision (for the CEO)
Default keeps the soundness investigation before initiating a non-fix FEATURE in another department (I don't blind-build an unfamiliar-domain feature). Alternative: 'just build any non-deferred, unblocked spec, no investigation.' I recommend the former for cross-domain features and straight-through for fixes; say the word to make it straight-through for everything.