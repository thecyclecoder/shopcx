# Spec-Drift Agent — keep phase emojis in sync with shipped code ⏳

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
- A build merges implementing a spec's only phase → its phase + H1 flip ✅ automatically (Part A); the card moves to Shipped without a human.
- A multi-phase spec where one phase's build merged but a later phase is genuinely unbuilt → only the merged phase flips ✅; the spec stays in-progress (e.g. `pdp-refinement-pass`: P1/P2 ✅, P3 ⏳ — not shipped).
- Inject drift (merge a build, leave the phase ⏳) → the reconciler flips it within a cycle (or surfaces it if ambiguous). A Control Tower "spec drift" tile shows any unresolved cases.
- Negative: a planned phase with no merged build / no code on main is **never** flipped; the agent never marks a spec verified.

## Phase 1 — merge-stamp + per-phase reconciler + drift surfacing ⏳
Part A (stamp the built phase ✅ on merge, reusing the spec-file writeback) + Part B (the per-phase, evidence-gated reconciler — event-on-merge + a Control Tower self-audit backstop that surfaces ambiguous drift). Brain: [[../libraries/brain-roadmap]] · [[../libraries/agent-jobs]] (reconcileMergedJobs) · [[control-tower]] · [[../project-management]] (status truth).
