# Board grooming — the director moves the project-management board

**Owner:** [[../functions/platform]] · **Parent:** [[../goals/devops-director]] (a Platform/DevOps Director capability)
**Blocked-by:** [[platform-director-agent]]

The [[platform-director-agent|DevOps Director]] doesn't just build queued specs — it **actively grooms the project board** so nothing sits half-built. On its standing cadence it assesses every spec card and, for a **partially-shipped spec** (≥1 phase ✅, remaining ⏳ phases, no active build), it decides what to do with the leftover phases — and **moves the card** accordingly. This formalizes the need-now-vs-future judgment the operator has been making by hand (and replaces the escort's blind "re-queue every phase").

## The decision (per remaining ⏳ phase of a partially-shipped spec)
1. **Needed now?** — does the next phase deliver something the spec's *current promise* requires, or that a dependent/goal needs now? → **launch the build of the next phase** (continue the spec to completion).
2. **Future need?** — is it enhancement/polish/"someday" that the spec doesn't need to be useful today? → **split it into its own spec card**: author a new `docs/brain/specs/{slug}-{phase}.md` (⏳ planned) with a `**Deferred:**` note (*"split from [[parent]] — not needed now: <reason>"*), then **close out the parent** (remove the split-off phase from the parent so its remaining phases are all ✅ → the parent is **fully shipped** and folds).
3. **Genuinely unsure / high-stakes** (is this load-bearing?) → **escalate to CEO** rather than guess (north-star: hit a rail → escalate).

**Net effect:** every partially-shipped spec either **completes** (needed-now phases built) or **cleanly splits** (future phases become their own planned cards) — so cards flow *out* of "In progress," the future work is captured (not lost) in "Planning," and the board reflects reality. The director is *moving the board*, not letting specs rot half-done.

## Supervisable (north-star)
Splitting a card + queueing a next-phase build is low-risk/reversible → within the director's leash; every groom decision (continue / split / escalate) writes a [[../tables/director_activity]] row with the reasoning. **Abandoning** work, or a phase the director can't confidently classify, escalates to the CEO. The director never deletes a phase outright — future work is always *preserved as a planned card*, never dropped.

## Phase 1 — assess partially-shipped specs → continue or split
- ✅ shipped
- On the director's standing cadence: scan specs (via [[../libraries/brain-roadmap]]) for ✅-some/⏳-some with no active build; per spec the director's Max `claude -p` investigation classifies the leftover phases needed-now (→ queue build) vs future (→ author deferred split-card(s) + close the parent) vs unsure (→ escalate); record each in [[../tables/director_activity]]. Brain: [[../goals/devops-director]] · [[platform-director-agent]] · [[../specs/spec-lifecycle-and-archival]] · [[../libraries/brain-roadmap]] · [[director-loop-grading]].
- **Shipped:** [[../libraries/platform-director]] `findGroomCandidates` (partially-shipped + no active build + not opted-out + not already-groomed; dormant until live+autonomous, capped at `PLATFORM_DIRECTOR_GROOM_CAP`) · `groomInvestigationPrompt` (the read-only classify prompt) · `validateGroomSplit` (a malformed split never lands a broken board) · `groomKey`/`alreadyGroomed` (the ledger dedup that survives the box's stale `fs` after a split commits to `main`). The box lane (`scripts/builder-worker.ts` `groomBoard`, run in `runPlatformDirectorStandingPass`) drives the investigation per candidate and dispatches: **continue** → queue a `kind='build'` job (loop-guarded like the escort) + a `groomed_continue` row; **split** → `putFileMain` each new card then the closed-out (folding) parent + a `groomed_split` row; **unsure / malformed split / loop-guard** → `escalateDiagnosisToCeo` + an `escalated` row. Reuses the existing build chain + the Phase-3 escalation plumbing — no new tables, no migration.

## Verification
- A spec with P1 ✅ + a P2 ⏳ that's *needed now* (its verification/promise needs it) → the director queues the P2 build; the card stays "In progress" and completes.
- A spec with P1 ✅ + a P2 ⏳ that's a *future enhancement* → the director authors `docs/brain/specs/{slug}-p2.md` (⏳ planned, `**Deferred:** split from [[{slug}]] — not needed now: …`), removes P2 from the parent so the parent is all-✅ → the **parent folds/ships** and a new **Planning** card appears; a `director_activity` row records the split + reason.
- A spec whose leftover phase is genuinely ambiguous (could be load-bearing) → **escalates to CEO** (no silent guess); no card moved until the CEO rules.
- Future work is **never dropped** — every split preserves the phase as a planned card.
- Negative: a fully-shipped spec (all ✅) or one with an active build → left alone (not re-groomed).
