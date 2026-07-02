---
name: submit-spec
description: Use to author a spec and submit it to the build pipeline from a working session in ShopCX — the programmatic "hand DevOps a spec to build" path. Writes public.specs + public.spec_phases through the author-spec chokepoint (Verification gate + brain-refs + re-open), NOT raw upsertSpec. Triggered by "spec this and send it to devops", "submit a spec to build {X}", or drafting any new feature/fix as a spec for Ada/Platform to build. NOT the interactive founder chat (that's spec-chat) and NOT implementing a spec (that's build-spec).
---

# submit-spec

Turn a decided piece of work into a DB spec row that the build pipeline will pick up. **The database is the spec** — there is no `docs/brain/specs/{slug}.md` anymore (the per-spec markdown was retired). You write the row; Vale reviews it; Ada dispositions it to `planned`; the box worker builds it. See [[../../docs/brain/libraries/author-spec]] · [[../../docs/brain/libraries/specs-table]] · [[../../docs/brain/project-management]].

## 🔒 Core invariant — author through `authorSpecRowStructured`, never raw `upsertSpec`

`src/lib/specs-table.ts` `upsertSpec` is the low-level writer. Do **not** call it directly to author a spec. Author through the chokepoint `src/lib/author-spec.ts` `authorSpecRowStructured`, which every real author surface (goal planner, director-coach, triage, spec-chat, repair, security) routes through. It wraps `upsertSpec` with three things you lose if you skip it:

- **Verification gate** — `assertEveryPhaseHasVerification` THROWS `MissingVerificationError` if any phase has an empty `verification`. No untestable spec reaches the pipeline.
- **Intent gate** — `assertEveryNodeHasIntent` THROWS `MissingIntentError` if the spec OR any phase lacks a non-empty `why` **and** `what` (plain-language intent, read as the detail-page header). Every `StructuredSpecInput` + `StructuredPhaseInput` needs both.
- **`**Brain refs:**` auto-suggester** — scans the body and injects the right `docs/brain/` wikilinks so the builder reads the correct brain slice first.
- **re-author-reopens-dismissed** + correct `auto_build` default (`autoBuild !== false` = on).

(An older habit — the `scripts/_author-*.ts` one-offs — called `upsertSpec` directly and bypassed all three. Don't copy that; use `authorSpecRowStructured`.)

## Procedure

1. **Write to the checklist.** [[../../docs/brain/recipes/what-makes-a-buildable-spec]] is the single definition of a sound spec — the SAME bar Vale's [[spec-review]] gates on. Read it and author to it; don't restate its rules from memory. In short: a real function `owner` (who *operates* the tool, not who builds it — **Ada/Platform builds every spec**), a non-orphan `parent` (a mandate or goal milestone), and every phase carries an observable `verification`.

2. **Probe before you assume shapes.** If the spec touches a table/enum/column, use the [[probe-db]] skill first — the body should describe real column names and real enum values, not guessed ones. Ground the body in actual `src/` files (`file:line`) and brain pages. Grounding + the Verification gate are what make the spec accurate.

3. **Author it** with a disposable `scripts/_author-{slug}.ts` (`_` = throwaway/not a tracked tool), using the [[script-conventions]] `_bootstrap`:

   ```ts
   import { loadEnv } from "./_bootstrap";
   loadEnv();
   import { authorSpecRowStructured } from "../src/lib/author-spec";

   const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company

   async function main() {
     const ok = await authorSpecRowStructured(
       WORKSPACE_ID,
       "my-feature-slug",                       // kebab-case, unique per workspace
       {
         title: "Human-readable title",
         why: "Plain-language WHY this spec exists (REQUIRED — the intent header humans + agents read).",
         what: "Plain-language WHAT changes when it ships (REQUIRED).",
         summary: "1–3 sentences grounded in real file:line / table names.",
         owner: "growth",                        // a function, NOT a person
         parent: "[[../goals/acquisition-research-engine]] (M4) — the operating home.",
         blocked_by: [],                          // other spec slugs that must ship first
         phases: [
           {
             title: "Phase 1 — …",
             why: "Plain-language WHY this phase exists (REQUIRED).",
             what: "Plain-language WHAT this phase changes (REQUIRED).",
             body: "What to build. Cite src/ files, tables, brain pages. End with the CLAUDE.md brain-page rule when it adds a table/inngest/library/integration.",
             verification: "Observable acceptance checks a machine can run.",
             status: "planned",
           },
         ],
       },
       "planned",                                // intended_status: "planned" | "deferred"
       { intendedStatusSetBy: "ceo" },           // + milestoneId to bind a goal milestone
     );
     console.log(ok ? "authored" : "author write failed");
   }
   main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
   ```

   Run: `npx tsx scripts/_author-{slug}.ts`.

4. **`auto_build` — leave it off for review by default.** Omit `autoBuild` and the spec lands `in_review` (the correct landing column): Vale reviews → Ada dispositions to `planned` → the pipeline builds. Only pass `autoBuild: true` (or set `status` via `opts`) when the CEO is explicitly commissioning an immediate, review-skipping build — that is a deliberate override, not the default for "send it to devops".

5. **Confirm it landed.** Probe `public.specs` / `public.spec_phases` for the slug — expect `status='in_review'`, `owner` set, and the phases present:
   ```ts
   const s = await getSpec(WORKSPACE_ID, "my-feature-slug"); // from src/lib/specs-table
   ```

## Gotchas

- **Re-authoring the same slug re-opens it.** `authorSpecRowStructured` is idempotent on `(workspace_id, slug)` and REPLACES phases by position. If the content changed it resets review signals back to `in_review` (`reopenIfReauthoredAndChanged`) — good for refining a just-submitted spec (e.g. to pick up brain-refs), harmless for an identical re-run. A **folded** spec never un-folds via re-author.
- **Don't hand-write `docs/brain/specs/*.md`.** CI (`scripts/_check-pm-md-reads.ts` / `_check-pm-sdk-compliance.ts`) forbids the markdown path and raw `.from('specs'|'spec_phases').insert/update`. The DB row IS the spec.
- **`intended_status` only takes `planned` | `deferred`.** The `planned/in_progress/shipped` axis is DERIVED from the phase rollup at read time — never write it. `in_review`/`deferred`/`folded` are the only real stored overrides.
- **Verification is not optional.** A phase with an empty `verification` throws `MissingVerificationError` — that's the gate working, not a bug. Write the acceptance check.

## Related

[[../../docs/brain/libraries/author-spec]] · [[../../docs/brain/libraries/specs-table]] · [[../../docs/brain/project-management]] · [[script-conventions]] · [[probe-db]] · [[build-spec]] · [[spec-chat]] · [[spec-review]] · [[spec-test]]
