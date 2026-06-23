# DB Health — never author an empty fix spec (re-derive on empty body) ⏳

**Owner:** [[../functions/platform]] · **Parent:** hardens [[db-health-agent]] spec authoring. · **Found in use 2026-06-23:** `db-index-orders`'s spec committed **empty (0 bytes)** → the build had no diagnostic and stalled `needs_input`. Root cause: the agent authored the body fine (`enqueueDbHealthProposal` stores `spec_body: buildFixSpecMarkdown(finding)` on the job's `instructions` JSON; `materializeDbHealthSpec` writes `instr.spec_body` at owner-Build), **but a manual approval overwrote the `instructions` field with a plain string**, so `JSON.parse(instructions)` yielded `{}` → `instr.spec_body` empty → `putFileMain` wrote an empty file. Whatever the cause (clobbered instructions, a genuinely-empty `buildFixSpecMarkdown`, a JSON-parse miss), the agent must **never commit an empty spec**.

## Fix
- **`materializeDbHealthSpec` refuses to write an empty/whitespace body.** If `instr.spec_body` is empty: (a) **re-derive** — re-`buildFixSpecMarkdown` from the finding payload if it's still on the job (carry the structured `finding`, not just the rendered `spec_body`, so it can re-render), or re-query `pg_stat_statements` + re-run `EXPLAIN` for the signature on the box; (b) if it genuinely can't reconstruct → set `needs_input` with a clear reason, **never `putFileMain` an empty file**.
- **Make the body un-clobberable.** Persist the diagnostic on a structured field that the approval path doesn't overwrite — store the `finding` (and/or `spec_body`) in the job's `pending_actions` `db_health_build` action (which approve mutates by *status only*), not in the free-text `instructions` an approval might replace. The owner-Build resume reads from there.
- **Defensive guard in the build, too** — `build-spec` (and the auto-merge gate) should treat a 0-byte / no-`## Phase` spec as a build failure, not a silent merge (belt-and-suspenders against any empty spec, db-health or otherwise).

## Verification
- Approve a `db_health` proposal whose `instructions` were overwritten / whose `spec_body` is empty → the resume **re-derives** the spec body (from the carried `finding` or a fresh `pg_stat_statements`/EXPLAIN read) and commits a NON-empty spec; it never writes a 0-byte file.
- A genuinely unreconstructable proposal → `needs_input` with the reason, no empty commit.
- The diagnostic survives an approval that touches `instructions` (it lives on the `pending_actions` action) — approve via the API or a manual status flip, the body is intact.
- A 0-byte / phaseless spec reaching the builder → the build fails loudly (not a silent empty merge).
- Negative: a normal db_health proposal with a populated body authors + builds unchanged.

## Phase 1 — empty-body guard + re-derive + un-clobberable storage ⏳
`materializeDbHealthSpec` empty-guard + re-derive (carry `finding` on the `db_health_build` action; re-render or re-query/EXPLAIN); move the diagnostic off free-text `instructions`; builder rejects a 0-byte/phaseless spec. Brain: [[db-health-agent]] · [[../libraries/db-health]] · [[../recipes/build-the-box]].
