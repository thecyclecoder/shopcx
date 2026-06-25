# libraries/author-spec

The dual-write chokepoint every spec-AUTHOR surface (planner, director-coach, triage, regression, spec-chat, db-health, coverage-register, repair, security, migration-fix, storefront-optimizer, developer-message-center, director split/bounce-back) routes through to write the spec BODY to [[../tables/specs]] + [[../tables/spec_phases]] in addition to committing `docs/brain/specs/{slug}.md` to `main`. Authored by [[../specs/spec-authoring-writes-db-and-worker-materialize]] Phase 1.

**File:** `src/lib/author-spec.ts`

## Why this exists

[[../specs/spec-body-table-and-backfill]] M1 stood up [[../tables/specs]] + [[../tables/spec_phases]] and the [[specs-table]] writer + the [[../recipes/backfill-specs-from-markdown]] one-time backfill. Every author surface in `scripts/builder-worker.ts` was still landing new specs as a `.md` commit only — the rows went stale the moment Vale, Sage, Ada, Reese, Vault, the planner, or any of the auto-fix lanes wrote a new spec. This module makes those surfaces dual-write: the existing `.md` commit STILL lands (the markdown-first readers — [[brain-roadmap]] `parseSpec`, the board, `getRoadmap` — haven't cut over yet; [[../specs/spec-readers-from-db-retire-parser]] M3 is what retires the parser), AND the DB row now lands too so the future DB-resident surfaces (Phase 2 build materializer, M4 fold, db-driven readers) line up.

The mirror flip — making the DB write the SOLE source of truth and demoting the `.md` commit to a separate worker `mirror-spec-md` lane — is owned by Phase 4 of the same spec.

## Exports

- **`authorSpecRowFromMarkdown(workspaceId, slug, markdown, intendedStatus, opts?)`** → `Promise<boolean>` — parses the markdown body via [[brain-roadmap]] `parseSpec` + the local `extractPhaseBodies`, extracts the typed regression headers + repair signature, and calls [[specs-table]] `upsertSpec` to UPSERT [[../tables/specs]] + REPLACE [[../tables/spec_phases]] by `(spec_id, position)`. Best-effort: a failure logs a warning + returns `false` so the upstream `.md` commit stays the canonical source until M3 flips.
- **`extractPhaseBodies(raw)`** — per-phase body extractor (sibling to `parseSpec` which only captures title + status). Position is 1-indexed and lines up with `parseSpec().phases[i]`. Shared with [[../recipes/backfill-specs-from-markdown]] to keep one impl.
- **`extractRepairSignature(raw)`** — the SIGNATURE TEXT (not just presence) for a Repair-Agent-authored spec — `**Repair-signature:** ``<sig>```. Pulls into `specs.repair_signature`.
- **`extractRegressionHeaders(raw)`** → `{ ofSlug, signature }` — the regression-agent header lines `**Regression-of:** [[<slug>]]` + `**Regression-signature:** ``<sig>```. Pull into `specs.regression_of_slug` / `specs.regression_signature` (typed columns added in the [[../specs/spec-authoring-writes-db-and-worker-materialize]] Phase 1 additive migration).
- **`toDbStatus(s)`** — map a [[brain-roadmap]] `SpecStatus` to a [[specs-table]] `SpecStatus` DB enum. `'rejected'` (a phase-only state) is rewritten to `'planned'`.

## Caller pattern

```ts
// After putFileMain(`docs/brain/specs/${slug}.md`, body, msg):
await markNewSpecInReview(workspaceId, slug, "planned", actor, reason, body);
//                                                                       ^^^^ — the markdown body the
//                                                                              surface just committed.
//                                                                              markNewSpecInReview dual-writes
//                                                                              spec_card_state + the
//                                                                              specs / spec_phases rows via
//                                                                              author-spec.
```

`markNewSpecInReview` in `scripts/builder-worker.ts` is the single chokepoint that wraps both writers; an author surface just hands it the just-committed markdown body. Omitting the body falls back to the legacy spec_card_state-only path (so a caller that doesn't have the body in hand doesn't break — the daily reconciler picks it up).

## Idempotency

Re-running `authorSpecRowFromMarkdown` with the same body is a no-op against the rolled-up `specs.status` and the phase set: `upsertSpec` UPSERTs by `(workspace_id, slug)` and REPLACES phases by `(spec_id, position)` preserving each phase's stable `id + pr + merge_sha + created_at`. A same-slug convergence (e.g. a recurring repair-agent signature) keeps the original card row's provenance intact.

## Gotchas

- **`intendedStatus` is the author's SUGGESTION.** Vale's disposition lane reads the field; it's not binding. Default to `'planned'` (a bug fix you don't want built is a contradiction) unless the surface knows the author meant `'deferred'`.
- **Best-effort.** A DB write failure logs + returns `false` but never throws. The `.md` commit remains canonical until M3.
- **No reader cuts over here.** This module ONLY writes the DB row alongside the existing `.md` commit. `getRoadmap` / `getSpec` / the board / the build pipeline still parse markdown via [[brain-roadmap]] — the cutover is owned by [[../specs/spec-readers-from-db-retire-parser]].
- **Phase 3 editing surfaces are not yet wired.** A director `spec-edit` (Slack action that re-puts a spec body) is a Phase 3 concern, not Phase 1. Until that lands, an in-place edit may drift the DB row off the markdown for an existing spec — [[brain-roadmap]] is still the authoritative read path so the drift doesn't surface to users.

## Related

[[specs-table]] · [[brain-roadmap]] · [[spec-card-state]] · [[../tables/specs]] · [[../tables/spec_phases]] · [[../recipes/backfill-specs-from-markdown]] · [[../specs/spec-authoring-writes-db-and-worker-materialize]] · [[../specs/spec-body-table-and-backfill]] · [[../specs/spec-readers-from-db-retire-parser]] · [[../specs/spec-review-agent]]
