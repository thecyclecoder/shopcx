# libraries/author-spec

The DB-only chokepoint every spec-AUTHOR surface (planner, director-coach, triage, regression, spec-chat, db-health, coverage-register, repair, security, migration-fix, storefront-optimizer, developer-message-center, director split/bounce-back) routes through to write the spec BODY to [[../tables/specs]] + [[../tables/spec_phases]]. There is NO `docs/brain/specs/{slug}.md` commit — the per-spec markdown was retired ([[../specs/spec-readers-from-db-retire-parser]] · spec-pm-markdown-purge); the readers read the DB rows.

**File:** `src/lib/author-spec.ts`

## Why this exists

[[../specs/spec-body-table-and-backfill]] M1 stood up [[../tables/specs]] + [[../tables/spec_phases]] and the [[specs-table]] writer. This module is the single authoring chokepoint that EVERY author surface routes through to write the spec row + its phases — so the Verification-enforcement gate (no untestable spec) and the `upsertSpec` write discipline live in ONE place. Post-cutover the DB row is the sole source of truth; nothing commits a `.md`.

## Exports

- **`authorSpecRowFromMarkdown(workspaceId, slug, markdown, intendedStatus, opts?)`** → `Promise<boolean>` — author from a MARKDOWN body: parses it via [[brain-roadmap]] `parseSpec` + the local `extractPhaseBodies`, extracts the typed regression headers + repair signature, and calls [[specs-table]] `upsertSpec` to UPSERT [[../tables/specs]] + REPLACE [[../tables/spec_phases]] by `(spec_id, position)`. The Verification gate (`assertEveryPhaseHasVerification`) runs FIRST and THROWS `MissingVerificationError` on an untestable phase; a genuine DB error is best-effort (`false`). `opts.milestoneId` binds `specs.milestone_id` at author time.
- **`authorSpecRowStructured(workspaceId, slug, spec, intendedStatus, opts?)`** → `Promise<boolean>` — author from ALREADY-TYPED fields + phases (NO markdown parse). Same Verification gate + same `upsertSpec` write path. This is the DB-driven entry point the **goal planner** uses: it holds the proposed spec as structured data (`StructuredSpecInput` — title/summary/owner/parent/blocked_by + `StructuredPhaseInput[]` each carrying a REQUIRED non-empty `verification`) and never needs a `.md` scratch buffer on disk. `opts.milestoneId` binds the goal→milestone→spec link. Removes the disk-`.md`-round-trip that authored 0 specs (planner-authors-specs-to-db).
- **`extractPhaseBodies(raw)`** — per-phase body extractor (sibling to `parseSpec` which only captures title + status). Position is 1-indexed and lines up with `parseSpec().phases[i]`. Shared with [[../recipes/backfill-specs-from-markdown]] to keep one impl.
- **`extractRepairSignature(raw)`** — the SIGNATURE TEXT (not just presence) for a Repair-Agent-authored spec — `**Repair-signature:** ``<sig>```. Pulls into `specs.repair_signature`.
- **`extractRegressionHeaders(raw)`** → `{ ofSlug, signature }` — the regression-agent header lines `**Regression-of:** [[<slug>]]` + `**Regression-signature:** ``<sig>```. Pull into `specs.regression_of_slug` / `specs.regression_signature` (typed columns added in the [[../specs/spec-authoring-writes-db-and-worker-materialize]] Phase 1 additive migration).
- **`toDbStatus(s)`** — map a [[brain-roadmap]] `SpecStatus` to a [[specs-table]] `SpecStatus` DB enum. `'rejected'` (a phase-only state) is rewritten to `'planned'`.

## Caller patterns

**Markdown-holding surfaces** (auto-fix lanes, spec-chat, director-coach) hand a markdown buffer to `markNewSpecInReview`:

```ts
await markNewSpecInReview(workspaceId, slug, "planned", actor, reason, markdown);
//                                                                       ^^^^^^^^ — the scratch markdown body.
//   markNewSpecInReview wraps spec-card-state + authorSpecRowFromMarkdown; the .md is a buffer, never committed.
```

**The goal planner** authors DB-only from STRUCTURED data — no markdown, no disk:

```ts
await markSpecCardForReview(workspaceId, slug, "planned", { actor: "planner", reason });
await authorSpecRowStructured(workspaceId, slug, { title, summary, owner, parent, blocked_by, phases }, "planned",
  { intendedStatusSetBy: "planner", milestoneId });
```

`runPlanJob`'s RESUME pass asks Pia for the spec bodies as STRUCTURED JSON (phases + a non-empty `verification` per phase), then authors each via `authorSpecRowStructured` BEFORE queuing any build — so a build is never queued for a spec that wasn't authored. There is no `docs/brain/specs/*.md` write and no `git status` glob anywhere on this path.

**spec-chat authors DB-only (no `.md` commit).** The `runSpecChatJob` finalize/verify lanes (Sage's authoring chat) DON'T commit `docs/brain/specs/{slug}.md` to `main` — under spec-pm-markdown-purge / retire-md-reads the spec lives ONLY in `public.specs` + `public.spec_phases`. Sage WRITES the spec markdown into the worktree as a **scratch buffer**; the worker reads it and authors the DB row via this chokepoint (`markNewSpecInReview` for a fresh spec, `authorSpecRowFromMarkdown` for a refine), then **validates by reading the row back** (`getSpec` → a spec row + ≥1 phase must exist) — the old "box did not write a spec file" markdown-existence gate is gone. The finalize slug is derived from the buffer filename / the model's JSON hint and **guarded to a kebab slug** (a new-feature chat is keyed by a UUID; a UUID is never allowed to become the spec slug). For a refine/verify the worker first MATERIALIZES the existing row back to `docs/brain/specs/{slug}.md` (via [[build-spec-materializer]] `renderSpecRow`) so Sage can Read it as grounding — read-then-author, never read-from-disk-canonical.

## Idempotency

Re-running `authorSpecRowFromMarkdown` with the same body is a no-op against the rolled-up `specs.status` and the phase set: `upsertSpec` UPSERTs by `(workspace_id, slug)` and REPLACES phases by `(spec_id, position)` preserving each phase's stable `id + pr + merge_sha + created_at`. A same-slug convergence (e.g. a recurring repair-agent signature) keeps the original card row's provenance intact.

## Gotchas

- **`intendedStatus` is the author's SUGGESTION.** Vale's disposition lane reads the field; it's not binding. Default to `'planned'` (a bug fix you don't want built is a contradiction) unless the surface knows the author meant `'deferred'`.
- **Verification is a HARD gate, the DB write is best-effort.** A phase with no non-empty `## Verification` THROWS `MissingVerificationError` (caught by the planner loop → fails the job loudly). A genuine DB/upsert failure logs + returns `false`. Both entry points run the SAME gate.
- **DB-only — no `.md`.** Nothing here commits `docs/brain/specs/{slug}.md`. The readers ([[brain-roadmap]] `getSpec`/`listSpecs`, the board, the build pipeline) read the DB rows.

## Related

[[specs-table]] · [[brain-roadmap]] · [[spec-card-state]] · [[../tables/specs]] · [[../tables/spec_phases]] · [[../recipes/backfill-specs-from-markdown]] · [[../specs/spec-authoring-writes-db-and-worker-materialize]] · [[../specs/spec-body-table-and-backfill]] · [[../specs/spec-readers-from-db-retire-parser]] · [[../specs/spec-review-agent]]
