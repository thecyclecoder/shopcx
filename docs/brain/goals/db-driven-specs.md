# Specs are data — the brain is the folded record

**Owner:** [[../functions/platform]]
**Status:** greenlit

**Outcome:** In-flight specs live 100% in the database (content + phases + status as one row), not as static `docs/brain/specs/*.md` files. The board, agents, and build pipeline read that row directly. When a spec ships, the **fold** process writes it into the brain markdown — the permanent, human-readable record — and preserves the DB row. The mirror between a static `.md` and DB status disappears, and with it an entire class of drift bugs.

**Why now:** every painful thing about specs is mirroring machinery — keeping a static markdown file in sync with DB status across many surfaces. It produces recurring drift: status stuck at `shipped` while only 1 of 4 phases is done (observed on `spec-review-agent`, 2026-06-25); the H2/H3/emoji-less parser fights; mangled-phase specs; the merge-hook phase-tagging gymnastics; `reconcileSpecDrift` / `overlayDbStateOnSpec` / forward-merge guards; and Vercel `outputFileTracingIncludes` tracing the `.md` into every bundle. All of it exists to paper over "the file changed but the DB didn't (or vice-versa)." Make the DB the single source of truth and that whole layer is deleted, not patched.

**Model:** a spec is **operational state** (like a ticket / order / agent_job) → it lives in the DB while in-flight. The **brain stays the source of truth for finished, durable knowledge** — the FOLDED record of a shipped spec. This sharpens the brain-is-source-of-truth principle (today the brain awkwardly holds half-built in-flight scratchpads).

**Success metric:** zero markdown-vs-DB drift (status always rolls up from the row's phases — impossible to stick); the markdown parser + `reconcileSpecDrift` + the overlay + the spec-status mirror + the specs `outputFileTracingIncludes` are deleted; a new spec is a DB row (no `.md`, no commit) that the board renders directly; fold writes the brain page + flips the row to `folded` (preserved). `spec-review-agent`'s class of "shipped with 1 phase" cannot recur.

**Target:** decompose + sequence via the [[../specs/goal-decomposition-engine|goal decomposition engine]] (human-gated) into the milestone specs below. This doc is the seed + the design contract. Reports to [[ceo-mode]]. Continues the lineage of [[../specs/spec-status-db-driven]] (status → DB) and [[../specs/spec-status-phase-pr-provenance]] (phases → DB) — this finishes the job by moving the spec BODY to the DB too.

## Milestone seeds for Pia

- **M1 — The spec body in the DB.** Extend the spec store (today `spec_card_state` holds status/phases/flags only) to hold the full spec BODY as structured data: title, summary, the phases (title + body + verification), owner, parent, blocked-by, priority/critical, deferred, intended_status. One-time backfill: import every existing `docs/brain/specs/*.md` (via the existing parser, used ONE LAST TIME) into the DB. After M1 the DB row is complete; the `.md` is still authoritative until M2 cuts over.
- **M2 — The board + all reads come from the DB.** `getRoadmap` / `getSpec` / the board / the slug page / Slack / the spec-test + blocker gates read the spec row directly — no markdown parse, no overlay, no `reconcileSpecDrift`. Status rolls up from the row's phases (can't stick). Delete the specs `outputFileTracingIncludes` entry (no `.md` to trace). Retire the parser + the mirror reconcilers.
- **M3 — Authoring + building write/read the DB.** Every spec-creation surface (planner/Pia, triage, the fix-spec builders, the director split/author, Ada, Vale) INSERTS a spec row instead of committing a `.md`. Editing a spec = updating the row. Bo reads the spec FROM the DB — the worker materializes it to a temp file for the build-spec skill (Bo never needs the `.md` on disk). The build hard-stop, the in_review flow, and phase-PR tagging all operate on the row.
- **M4 — Fold writes the brain + preserves the row.** Fold reads the shipped spec row → writes its permanent record into the brain (lifecycle/library/table/dashboard pages, as today) → flips the DB row to `folded` (PRESERVED, not deleted, for audit + the board's archive view). This is the ONLY path that writes spec markdown, and only for shipped work. Retire the last of the spec-status mirror.

## Decomposition

### M1 — The spec body in the DB
- *(to be authored by Pia)* — schema for the spec body + a one-time backfill of `specs/*.md` → DB.

### M2 — The board + all reads come from the DB
- *(to be authored by Pia)* — cut every reader over to the DB; delete the parser/overlay/reconcile + the specs file-tracing.

### M3 — Authoring + building write/read the DB
- *(to be authored by Pia)* — creation surfaces insert rows; the worker materializes the spec for Bo's build.

### M4 — Fold writes the brain + preserves the row
- *(to be authored by Pia)* — fold writes the brain page + flips the row to `folded`; retire the last mirror.
