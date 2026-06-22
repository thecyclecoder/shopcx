# Build-all-phases chain + hang-based build timeout ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends the box build pipeline + [[auto-ship-pipeline]] (auto-merge is what advances the chain). Removes the "babysit phase-by-phase builds" toil for milestone/multi-phase specs.

Today every build builds the ONE phase its `instructions` name, so a multi-phase spec means the owner hand-queues "Build P1", waits, "Build P2", waits, … — hard to keep up with during milestone work. Two fixes, combined:

## Part A — "Build all phases" chains automatically (the main win)
- **A new "Build all" action** on the spec card (alongside per-phase Build): queues the **first ⏳ phase**, tagged `chain_phases: true` on the agent_job.
- **On that phase's PR merging** (which [[auto-ship-pipeline]] now does automatically when green), a post-merge chain step checks the spec on `main`: if a **next ⏳ phase** exists, queue *its* build (also `chain_phases: true`, based on fresh `main` so it builds on the prior phase's code). Repeat until **all phases ✅**.
- **Stop / pause conditions (never blindly barrel on):**
  - A phase build **fails** → stop the chain, surface it (don't queue the next on top of a broken phase).
  - A phase **needs_approval** (e.g. a migration) → pause for the owner; resuming that phase resumes the chain.
  - All phases ✅ → done (chain ends; the spec is fully shipped → eligible for auto-fold).
- Each phase stays a **bounded, isolated build** with its own PR + spec-test — incremental, reviewable, resumable. If P2 fails, P1 already shipped; retry P2 only.
- Why not one big build: a 1-hour atomic build loses phases 1–2 on a phase-3 failure, yields one unreviewable PR, and holds a lane for an hour. Chaining avoids all three.

## Part B — "fail only if hung", not a wall-clock guillotine
The hard `BUILD_TIMEOUT_MS = 30 min` kills a legit long phase mid-work. Replace it with **progress-based liveness**:
- Track the build subprocess's **last output time**; if it produces **no output for an idle threshold** (e.g. ~10 min) → it's hung → kill + fail.
- Keep a **generous hard cap** (e.g. 60 min) as a backstop against a process that emits noise forever.
- So a phase that's actively working for 40 min finishes; a truly-stuck one dies fast — what the owner asked for.

## Verification
- "Build all" on a 3-phase spec (P1–P3 all ⏳) → P1 builds → auto-merges → P2 auto-queues (on updated main) → auto-merges → P3 → spec ends all-✅, with **no owner clicks** between phases.
- Mid-chain a phase **fails** → the chain stops at that phase (next phase NOT queued), it surfaces; retrying the failed phase resumes the chain.
- A phase that needs_approval pauses; approving it continues the chain.
- A build actively emitting output at 35 min is **not** killed (past the old 30-min wall); a build silent for >10 min **is** killed as hung; nothing runs past the 60-min hard cap.
- Single-phase / non-chained builds are unaffected (no `chain_phases` → no auto-queue).

## Phase 1 — the phase chain ⏳
"Build all" action + `chain_phases` flag; post-merge step queues the next ⏳ phase (fail/needs_approval/all-done stops), composing with [[auto-ship-pipeline]] auto-merge. Brain: [[auto-ship-pipeline]] · [[../libraries/roadmap-actions]] · [[../libraries/brain-roadmap]].

## Phase 2 — hang-based build timeout ⏳
Replace the hard `BUILD_TIMEOUT_MS` wall with output-idle hang detection (~10 min idle kill) + a 60-min hard cap, in `scripts/builder-worker.ts`. Brain: [[../recipes/build-the-box]] (if present) · [[../operational-rules]].
