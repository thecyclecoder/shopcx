# Specs AND goals are data — the brain is the folded record

**Owner:** [[../functions/platform]]
**Status:** greenlit

**Outcome:** The whole project-management layer — in-flight **specs AND goals** — lives 100% in the database, not as static markdown files. A spec is one `specs` row + its `spec_phases` child rows; a goal is one `goals` row + its `goal_milestones` child rows. The board, agents, and pipeline read those rows directly. Status is DB state, never a markdown emoji or a hand-edited `**Status:**` line. When a spec (or goal) completes, the **fold** process writes its permanent record into the brain markdown and preserves the DB row. The mirror between static markdown and DB state disappears, and with it an entire class of drift bugs.

**Why now:** every painful thing about specs AND goals is the same mirroring machinery — keeping a static markdown file in sync with DB state. SPECS drift: status stuck at `shipped` while only 1 of 4 phases is done (`spec-review-agent`, 2026-06-25); the H2/H3/emoji-less parser fights; mangled-phase specs; the merge-hook phase-tagging gymnastics; `reconcileSpecDrift` / `overlayDbStateOnSpec` / forward-merge guards; Vercel `outputFileTracingIncludes`. GOALS have the IDENTICAL disease: `**Status:** proposed｜greenlit｜complete` and the milestone `⏳/✅` emojis live in the markdown — so **greenlighting a goal means editing a file and committing it** (no DB flag → no UI button → the CEO literally had no surface to approve the db-driven-specs goal; it had to be git-committed by hand, 2026-06-25). Make the DB the single source of truth for both and that whole layer is deleted, not patched — and a greenlight becomes a one-click DB flag.

**Model:** a spec is **operational state** (like a ticket / order / agent_job) → it lives in the DB while in-flight. The **brain stays the source of truth for finished, durable knowledge** — the FOLDED record of a shipped spec. This sharpens the brain-is-source-of-truth principle (today the brain awkwardly holds half-built in-flight scratchpads).

**Success metric:** zero markdown-vs-DB drift for specs OR goals (status always rolls up from child rows — impossible to stick); the markdown parser + `reconcileSpecDrift` + the overlay + the spec/goal-status mirror + the `outputFileTracingIncludes` are deleted; a new spec/goal is a DB row (no `.md`, no commit) the board renders directly; **a goal is greenlit with a one-click button (a DB flag), never a git commit**; fold writes the brain page + flips the row to `folded` (preserved). `spec-review-agent`'s "shipped with 1 phase" class cannot recur.

**Target:** decompose + sequence via the [[../specs/goal-decomposition-engine|goal decomposition engine]] (human-gated) into the milestone specs below. This doc is the seed + the design contract. Reports to [[ceo-mode]]. Continues the lineage of [[../specs/spec-status-db-driven]] (status → DB) and [[../specs/spec-status-phase-pr-provenance]] (phases → DB) — this finishes the job by moving the spec BODY to the DB too.

## Milestone seeds for Pia

- **M1 — The spec body in the DB (phases are a TABLE, not jsonb).** Two relations: **`specs`** holds the body (title, summary, owner, parent, blocked-by, priority/critical, deferred, intended_status, status) and **`spec_phases`** holds ONE ROW PER PHASE (`id`, `spec_id` FK, `position`, `title`, `body`, `status`, `pr`, `merge_sha`, verification). Phases are a child TABLE — NOT a jsonb array — specifically because a phase must be able to MOVE between specs (e.g. P1–P4 done, lift P5 into a new deferred spec): with a table that's a single `UPDATE spec_phases SET spec_id=…, position=…` that preserves the phase's stable id + PR/SHA provenance + history; jsonb would force index-surgery that destroys+recreates the phase and breaks the positional `phase_states[i].pr` provenance (an edge we've already hit). The spec's status ROLLS UP from its child phase rows (impossible to stick at shipped). One-time backfill: import every existing `docs/brain/specs/*.md` (the existing parser, used ONE LAST TIME) into `specs` + `spec_phases`. After M1 the rows are complete; the `.md` stays authoritative until M2 cuts over.
- **M2 — The board + all reads come from the DB.** `getRoadmap` / `getSpec` / the board / the slug page / Slack / the spec-test + blocker gates read the spec row directly — no markdown parse, no overlay, no `reconcileSpecDrift`. Status rolls up from the row's phases (can't stick). Delete the specs `outputFileTracingIncludes` entry (no `.md` to trace). Retire the parser + the mirror reconcilers.
- **M3 — Authoring + building write/read the DB.** Every spec-creation surface (planner/Pia, triage, the fix-spec builders, the director split/author, Ada, Vale) INSERTS a spec row instead of committing a `.md`. Editing a spec = updating the row. Bo reads the spec FROM the DB — the worker materializes it to a temp file for the build-spec skill (Bo never needs the `.md` on disk). The build hard-stop, the in_review flow, and phase-PR tagging all operate on the row.
- **M4 — Fold writes the brain + preserves the row.** Fold reads the shipped spec row → writes its permanent record into the brain (lifecycle/library/table/dashboard pages, as today) → flips the DB row to `folded` (PRESERVED, not deleted, for audit + the board's archive view). This is the ONLY path that writes spec markdown, and only for shipped work. Retire the last of the spec-status mirror.
- **M5 — Goals are data too (same model, smaller).** A `goals` row + `goal_milestones` child rows (id, goal_id FK, position, title, body, status, the specs it spawned). Goal status (`proposed｜greenlit｜complete`) + milestone status are DB columns — NOT the `**Status:**` line or `⏳/✅` emojis. **Greenlight becomes a one-click DB flag with a UI button** (the surface the CEO was missing). `parseGoal` / `setGoalStatusLine` / the goal-status markdown machinery retire; the goal-decomposition engine reads greenlit goals from the DB. Fold writes the goal's brain record on completion. Backfill `docs/brain/goals/*.md` into the rows.

## Decomposition

### M1 — The spec body in the DB
- *(to be authored by Pia)* — schema for the spec body + a one-time backfill of `specs/*.md` → DB.

### M2 — The board + all reads come from the DB
- *(to be authored by Pia)* — cut every reader over to the DB; delete the parser/overlay/reconcile + the specs file-tracing.

### M3 — Authoring + building write/read the DB
- *(to be authored by Pia)* — creation surfaces insert rows; the worker materializes the spec for Bo's build.

### M4 — Fold writes the brain + preserves the row
- *(to be authored by Pia)* — fold writes the brain page + flips the row to `folded`; retire the last mirror.

### M5 — Goals are data too
- *(to be authored by Pia)* — `goals` + `goal_milestones` tables; greenlight = a one-click DB flag + button; retire `parseGoal`/`setGoalStatusLine`; backfill `goals/*.md`.
