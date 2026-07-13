---
name: submit-spec
description: Use to author a spec and submit it to the build pipeline from a working session in ShopCX — the programmatic "hand DevOps a spec to build" path. Writes public.specs + public.spec_phases through the author-spec chokepoint (typed machine-runnable verification + brain-refs + re-open), NOT raw upsertSpec. Every phase MUST carry >=1 typed machine-runnable check ({kind, params}); prose-only or needs_human-only verification is REJECTED at author time. Triggered by "spec this and send it to devops", "submit a spec to build {X}", or drafting any new feature/fix as a spec for Ada/Platform to build. NOT the interactive founder chat (that's spec-chat) and NOT implementing a spec (that's build-spec).
---

# submit-spec

Turn a decided piece of work into a DB spec row that the build pipeline will pick up. **The database is the spec** — there is no `docs/brain/specs/{slug}.md` anymore (the per-spec markdown was retired). You write the row; the deterministic spec-review gate accepts it; Ada dispositions it to `planned`; the box worker builds it; the deterministic spec-check runner executes your typed checks; the fold worker archives it. See [[../../docs/brain/libraries/author-spec]] · [[../../docs/brain/libraries/specs-table]] · [[../../docs/brain/libraries/spec-phase-checks-table]] · [[../../docs/brain/project-management]].

## 🔒 Core invariant — author through `authorSpecRowStructured` (aka `submitSpec`), never raw `upsertSpec`, never the retired markdown path

`src/lib/specs-table.ts` `upsertSpec` is the low-level writer. Do **not** call it directly to author a spec. Author through the chokepoint `src/lib/author-spec.ts` `authorSpecRowStructured` — **also exported as `submitSpec`, the canonical, ergonomic alias; prefer `submitSpec` in new code** — which every real author surface (goal planner, director-coach, triage, spec-chat, repair, security) routes through. It wraps `upsertSpec` with four things you lose if you skip it:

**Markdown authoring is retired for autonomous callers** (`retire-md-spec-writers-db-is-sole-spec` Phase 4). `authorSpecRowFromMarkdown` and its `scripts/builder-worker.ts` wrapper `markNewSpecInReview` parse prose `## Verification` blocks that get stamped `exec_kind='needs_human'` — the every-writer-authors-machine-runnable-verifications gate then rejects the spec with `MissingMachineCheckError`, parking the fix-spec at the CEO inbox. A CI guard `scripts/_check-no-markdown-spec-authoring.ts` (wired into `predeploy`) blocks a NEW autonomous caller of the retired path. Every deterministic lane authors STRUCTURED: coverage-register's `buildRegisterSpecBody` / `buildExemptSpecBody` (Phase 1), repair's `buildRepairSpecInput` (Phase 2), the director-followup's `buildStructuredSpecInputFromMarkdown` (Phase 3) — see [[../../docs/brain/libraries/author-spec]] § "Structured is the ONLY sanctioned author path" for the canonical pattern.

**This is now RUNTIME-ENFORCED, not just convention/CI.** As of the harden-spec-submission hotfix + every-spec-writer-authors-machine-runnable-verifications Phase 1, the chokepoint throws before any DB write when:

- **`MissingVerificationError`** — a phase has an empty `verification` blob (0-byte checklist).
- **`MissingIntentError`** — the spec OR a phase lacks a non-empty plain-language `why` / `what`.
- **`MissingMachineCheckError`** ← NEW in Phase 1. A phase's structured checks carry ONLY prose or ONLY `needs_human` rows — nothing the deterministic runner can execute. Every phase needs ≥1 check whose `exec_kind` is auto-testable AND passes `validateExecutableCheck`. Prose bullets and eyeball notes are still allowed as EXTRA — they just can't be the SOLE verification.
- **`UngatedSpecAuthorError`** (specs-table floor gate) — a raw `upsertSpec` bypass that skipped the gates above.

- **`**Brain refs:**` auto-suggester** — scans the body and injects the right `docs/brain/` wikilinks so the builder reads the correct brain slice first.
- **re-author-reopens-dismissed** + correct `auto_build` default (`autoBuild !== false` = on).

(An older habit — the `scripts/_author-*.ts` one-offs — called `upsertSpec` directly and bypassed all three. Don't copy that; use `authorSpecRowStructured`.)

## Typed verification checks — the ship gate

**CEO decision 2026-07-11: machine-runnable is mandatory; human tests are advisory / non-blocking.**

Every acceptance criterion is now authored as a typed `{position, description, kind, exec_kind, params}` check (a row in `public.spec_phase_checks`). The deterministic runner (`src/lib/spec-check-runner.ts`) executes them; the fold gate keys on the machine checks; there is no LLM interpretation of prose acceptance bullets anymore.

The typed shapes (see `src/lib/spec-phase-checks-table.ts` `validateExecutableCheck`):

| `exec_kind`          | `params`                                                              | When to use |
|---                   |---                                                                    |---|
| `tsc`                | `null`                                                                | The branch's `npx tsc --noEmit` must pass. |
| `grep`               | `{ pattern: string, path?: string, expect: "present" \| "absent" }` | A symbol / string must (not) appear in the changed source. |
| `ci_status`          | `null`                                                                | The branch's GitHub CI must be green. |
| `http_get`           | `{ url: "https://…", expect_status: number }`                       | A route/endpoint must respond with a given status. |
| `db_probe_readonly`  | `{ probe_id: <key of DB_PROBES>, args?, expect: null \| number \| boolean }` | A registered read-only DB probe returns an expected scalar. Unknown probe_id or a sensitive arg name rejects. |
| `unit_test`          | `{ script: "<a package.json script>" }`                             | A `package.json` script must exit 0. Unknown script names reject at author time. |
| `build`              | `null`                                                                | `next build` must pass. |
| `needs_human`        | `null`                                                                | Advisory / subjective / eyeball. NEVER auto-run. Allowed as EXTRA; NEVER the sole check per phase. |

A phase with only `needs_human` rows (or only prose bullets, which parse to `needs_human`) is rejected at author time with `MissingMachineCheckError`. A phase with a valid `tsc` / `grep` / … row PLUS an extra `needs_human` row is fine — the machine check gates fold, the human note surfaces to the founder.

## `human_review` — the OPTIONAL, non-blocking founder note (Phase 2)

Sometimes the founder wants to say "after ship, open /dashboard/x and confirm the layout reads right" without that eyeball step BLOCKING the ship. That's what the `human_review` column on `public.specs` is for — an OPTIONAL text advisory that renders on the spec card + post-ship founder surface but is NEVER read by the fold gate, the promote-to-main gate, or the deterministic spec-check runner. Its absence is the norm. A spec whose machine checks are green + carries a `human_review` note still auto-folds.

Pass it either as a field on the structured spec (`human_review: "…"`) OR as an `opts.humanReview` override on the author call. On the markdown path it's parsed from a `**Human-review:** …` header line.

## Procedure

1. **Write to the checklist.** [[../../docs/brain/recipes/what-makes-a-buildable-spec]] is the single definition of a sound spec — the SAME bar the deterministic spec-review gate accepts. Read it and author to it; don't restate its rules from memory. In short: a real function `owner` (who *operates* the tool, not who builds it — **Ada/Platform builds every spec**), a non-orphan `parent` (a mandate or goal milestone), and every phase carries ≥1 typed machine-runnable check.

   **⚠️ Parent — pick the RIGHT kind (the #1 review bounce).** The work hierarchy is `Function → (Mandate | Goal→Milestone) → Spec`. A spec's parent is EITHER a **function mandate** OR a **goal milestone** — **never a bare goal and never a bare function.**
   - **One-off / standalone spec** (a fix, a hardening, a correctness pass — most specs) → parent a **function mandate**: `parentKind: "mandate"`, `parentRef: "{owner}#{mandate-slug}"`, and write the prose to name that mandate, e.g. `parent: '[[../functions/platform]] — "Infra & DevOps / reliability" mandate: <why>.'`. **A one-off does NOT need a goal — do not force it onto one.**
   - **Goal-bound spec** (part of a finite, multi-spec goal) → parent a specific **milestone**: pass `milestoneId` (the `goal_milestones.id`) and/or anchor the wikilink `[[../goals/{slug}#{milestone}]]`. A `Parent:` that names ONLY the goal (no milestone) is a defect the review gate bounces every pass.
   - Find a function's mandates under `## Mandates (perpetual)` in `docs/brain/functions/{owner}.md` (e.g. growth: `ad-matched-landing-pages`, `static-ad-optimization`; platform: `autonomous-build-platform`, `infra-devops-reliability`). The authoring chokepoint THROWS `InvalidParentError` on a bare-goal parent, so a bad parent fails fast instead of looping in review.

2. **Probe before you assume shapes.** If the spec touches a table/enum/column, use the [[probe-db]] skill first — the body should describe real column names and real enum values, not guessed ones. Ground the body in actual `src/` files (`file:line`) and brain pages. Grounding + the typed-check gate are what make the spec accurate.

3. **Author it** with a disposable `scripts/_author-{slug}.ts` (`_` = throwaway/not a tracked tool), using the [[script-conventions]] `_bootstrap`. Every phase carries a `checks: [{position, description, kind, exec_kind, params}]` array — that's the payload the runner executes.

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
         // ONE-OFF spec → parent a function MANDATE (not a goal). Name the mandate in the prose AND
         // pass the typed parentKind/parentRef below. (Goal-bound spec instead? pass milestoneId + a
         // [[../goals/{slug}#{milestone}]] anchor.)
         parent: '[[../functions/growth]] — "Ad-matched landing pages" mandate: <why this spec lives here>.',
         blocked_by: [],                          // other spec slugs that must ship first
         // OPTIONAL, non-blocking founder eyeball note. Absent is fine. NEVER gates fold/ship/merge.
         human_review: "After ship, open /dashboard/ads/{spec} and confirm the funnel report reads right.",
         phases: [
           {
             title: "Phase 1 — …",
             why: "Plain-language WHY this phase exists (REQUIRED).",
             what: "Plain-language WHAT this phase changes (REQUIRED).",
             body: "What to build. Cite src/ files, tables, brain pages. End with the CLAUDE.md brain-page rule when it adds a table/inngest/library/integration.",
             // Free-text verification blob is still persisted for the card render; the TYPED checks below are
             // what the runner actually executes.
             verification: [
               "- On the branch, `npx tsc --noEmit` → expect clean.",
               "- On the changed source, grep for `foo` → expect present.",
             ].join("\n"),
             status: "planned",
             checks: [
               // >=1 machine-runnable check REQUIRED — prose-only / needs_human-only is rejected at author.
               { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
               {
                 position: 2,
                 description: "the new resolver is wired",
                 kind: "auto",
                 exec_kind: "grep",
                 params: { pattern: "resolveThing", path: "src/lib/thing.ts", expect: "present" },
               },
               // OPTIONAL extra — advisory / subjective. Allowed IN ADDITION to a machine check.
               {
                 position: 3,
                 description: "eyeball the funnel report on /dashboard/ads/{spec}",
                 kind: "human",
                 exec_kind: "needs_human",
                 params: null,
               },
             ],
           },
         ],
       },
       "planned",                                // intended_status: "planned" | "deferred"
       {
         intendedStatusSetBy: "ceo",
         // ONE-OFF → declare the mandate parent (matches the `parent` prose above):
         parentKind: "mandate",
         parentRef: "growth#ad-matched-landing-pages",   // "{owner}#{mandate-slug}"
         // GOAL-BOUND instead → drop parentKind/parentRef and pass: milestoneId: "<goal_milestones.id>"
         // OPTIONAL, wins over spec.human_review when set (e.g. a planner surface holding the note
         // separately from the spec body). `null` clears; omit to preserve.
         // humanReview: "…",
       },
     );
     console.log(ok ? "authored" : "author write failed");
   }
   main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
   ```

   Run: `npx tsx scripts/_author-{slug}.ts`.

4. **`auto_build` — leave it off for review by default.** Omit `autoBuild` and the spec lands `in_review` (the correct landing column): the review gate accepts → Ada dispositions to `planned` → the pipeline builds. Only pass `autoBuild: true` (or set `status` via `opts`) when the CEO is explicitly commissioning an immediate, review-skipping build — that is a deliberate override, not the default for "send it to devops".

5. **Confirm it landed.** Probe `public.specs` / `public.spec_phases` / `public.spec_phase_checks` for the slug — expect `status='in_review'`, `owner` set, phases present, and every phase's structured checks with `exec_kind` set (not `needs_human`-only):
   ```ts
   const s = await getSpec(WORKSPACE_ID, "my-feature-slug"); // from src/lib/specs-table
   ```

## Gotchas

- **Prose-only verification is rejected.** A phase whose only checks are prose bullets (which parse to `exec_kind='needs_human'`) fails with `MissingMachineCheckError` — that's the Phase 1 gate working, not a bug. Add ≥1 typed machine-runnable check per phase.
- **`human_review` is advisory ONLY.** Setting it does NOT block fold / ship / merge. The founder sees it on the card post-ship; the fold worker doesn't care.
- **Re-authoring the same slug re-opens it.** `authorSpecRowStructured` is idempotent on `(workspace_id, slug)` and REPLACES phases by position. If the content changed it resets review signals back to `in_review` (`reopenIfReauthoredAndChanged`) — good for refining a just-submitted spec (e.g. to pick up brain-refs), harmless for an identical re-run. A **folded** spec never un-folds via re-author.
- **Don't hand-write `docs/brain/specs/*.md`.** CI (`scripts/_check-pm-md-reads.ts` / `_check-pm-sdk-compliance.ts`) forbids the markdown path and raw `.from('specs'|'spec_phases').insert/update`. The DB row IS the spec.
- **`intended_status` only takes `planned` | `deferred`.** The `planned/in_progress/shipped` axis is DERIVED from the phase rollup at read time — never write it. `in_review`/`deferred`/`folded` are the only real stored overrides.
- **`unit_test.script` must exist in package.json.** A script name the runner can't find (e.g. `npm test` when there's no `test` script) rejects at author time — closes the cs-director `npm test` class before it can land as an un-runnable row.

## Related

[[../../docs/brain/libraries/author-spec]] · [[../../docs/brain/libraries/specs-table]] · [[../../docs/brain/libraries/spec-phase-checks-table]] · [[../../docs/brain/project-management]] · [[script-conventions]] · [[probe-db]] · [[build-spec]] · [[spec-chat]] · [[spec-test]]
