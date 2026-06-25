# Recipe: backfill specs from markdown (`backfill-specs-from-markdown`)

One-time backfill that populates the DB-resident spec body — [[../tables/specs]] + [[../tables/spec_phases]] — from `docs/brain/specs/*.md`. The foundation of [[../specs/spec-body-table-and-backfill]] (db-driven-specs M1, Phase 3): run the existing [[../libraries/brain-roadmap]] `parseSpec` ONE LAST TIME, prefer the live [[../tables/spec_card_state]] mirror for status / per-phase / critical / deferred / intended_status, and upsert via [[../libraries/specs-table]] `upsertSpec`.

**Tool:** `scripts/backfill-specs-from-markdown.ts`. Dry-run by default; `--apply` writes. Idempotent + resumable (UPSERT by `(workspace_id, slug)`; phase REPLACE by `(spec_id, position)` preserving stable ids + PR/SHA).

## Commands

```bash
# Dry run — prints what WOULD insert per spec, per workspace
npx tsx scripts/backfill-specs-from-markdown.ts

# Apply — writes rows; after the loop, flags any specs whose rolled-up status mismatches the source
npx tsx scripts/backfill-specs-from-markdown.ts --apply
```

## What it does, per workspace × spec

1. Read every `docs/brain/specs/{slug}.md` from disk (skipping `README.md`).
2. Run [[../libraries/brain-roadmap]] `parseSpec` for title / summary / owner / parent / blocked_by / phases. Pull the `**Repair-signature:** \`…\`` text out separately (the parser only flags presence). Extract per-phase body text by slicing between phase headings.
3. Look up the matching [[../tables/spec_card_state]] row:
   - prefer the mirror's `status` / `flags.critical` / `flags.deferred` / `flags.intended_status` over the markdown-parsed values ([[../specs/spec-status-db-driven]] made the DB authoritative)
   - per-phase: prefer the mirror's `phase_states[i].{status, pr, merge_sha}` BUT carry the **forward-merge guard** — when the markdown shows a MORE-advanced status for a phase (a fresh disk edit the mirror hasn't caught), the markdown wins and any stale DB provenance is dropped. Same rule [[../libraries/brain-roadmap]] `overlayDbStateOnSpec` enforces today.
4. UPSERT via [[../libraries/specs-table]] `upsertSpec`. The DB trigger rolls `specs.status` up from the resulting phase set (terminal-ish `in_review` / `folded` are left alone — see [[../tables/specs]] § Rollup).
5. After `--apply` only: re-read the persisted `specs.status` and compare to the expected source value. Flag any mismatch for human review; do NOT silently overwrite. (A mismatch typically means the trigger rolled to a value that disagrees with the markdown parse or the mirror — the trigger's answer is read from authoritative phases, so the source is the side to fix.)

## Output

Per-spec log line, e.g.:

```
  spec-status-phase-pr-provenance: 3 phase(s) status=shipped
  agent-mandate-hardening-ticket-improve: 0 phase(s) status=planned
  regression-agent: 5 phase(s) status=in_progress deferred critical
```

On `--apply`, ends with `✓ N spec(s) upserted across W workspace(s)` and either `✓ rolled-up specs.status matches the source value for every spec.` or a mismatch list to review.

## Idempotency

- `specs` UPSERT by `(workspace_id, slug)` — re-run leaves the row in place, only bumps `updated_at`.
- `spec_phases` REPLACE by `(spec_id, position)` — matching positions UPDATE in place (preserving `id`, and `pr` / `merge_sha` when the input doesn't override). New positions INSERT; vanished positions DELETE. Stable across re-runs.
- A re-run after `--apply` is a no-op for the row content (the trigger may bump `updated_at` once, then stabilizes).

## Out of scope (this recipe)

- **Deleting `docs/brain/specs/*.md`.** The markdown files STAY in the repo until [[../specs/spec-readers-from-db-retire-parser]] (M3) retires the parser — rollback path if any row is wrong. No `git rm` here.
- **Rewiring readers / writers.** `getRoadmap` / `getSpec` / the board / Slack still read markdown via [[../libraries/brain-roadmap]] in this milestone (M3 / M2 own the cutovers).

## Gotchas

- **The trigger trumps the loaded `status`.** Pass any plausible status — the trigger rolls `specs.status` from phases on each phase write. The script's post-apply verification surfaces the trigger's answer vs the expected source.
- **Forward-merge guard at the PHASE level.** A markdown shows ⏳ but the mirror shows ✅? Mirror wins (it's been authoritative since [[../specs/spec-status-db-driven]]). A markdown shows ✅ but the mirror shows ⏳? Markdown wins (fresh disk edit) — and any stale `pr` / `merge_sha` is dropped with it.
- **Workspace-scoped.** The script iterates every row in `public.workspaces` and writes the spec set into each. Status/flags lookups are per-workspace via [[../tables/spec_card_state]].
- **`repair_signature` is the SIGNATURE text, not a boolean.** Markdown carries it in backticks: `**Repair-signature:** \`abc123\``. We extract that string. Absence ⇒ NULL.

## Related

[[../specs/spec-body-table-and-backfill]] · [[../tables/specs]] · [[../tables/spec_phases]] · [[../libraries/specs-table]] · [[../libraries/brain-roadmap]] · [[../tables/spec_card_state]] · [[../libraries/spec-card-state]] · [[../specs/spec-status-db-driven]] · [[../specs/spec-status-phase-pr-provenance]] · [[write-a-migration-apply-script]]
