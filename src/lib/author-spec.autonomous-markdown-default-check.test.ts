/**
 * Unit tests for `buildStructuredSpecInputFromMarkdown` as the authoring path for AUTONOMOUS markdown
 * writers — autonomous-markdown-authors-get-the-default-machine-check (2026-08-11).
 *
 * THE LOOP THIS PINS. `markNewSpecInReview` is the shared authoring seam for seven autonomous lanes
 * (db_health, the director groomed_split lanes, bounce-back split, spec-chat, migration-fix, the
 * developer message center). None of them emit typed `checks[]` — they hand over prose markdown. It used
 * to call `authorSpecRowFromMarkdown`, which derives checks ONLY from the prose `## Verification` blob and
 * throws `MissingMachineCheckError` when every bullet lands as `needs_human`.
 *
 * Live consequence: the db_health slow-query signature 4608471940106465663 failed every ~10 minutes with
 * "spec db-index-specs has a phase with no machine-runnable verification — phase 1 (Phase 1 — add index)"
 * while the seq scan it was trying to fix grew to 26,677 calls / 2,434s cumulative. The fix could not be
 * written down, so it was never built, so the query stayed slow, so the detector re-fired. Forever.
 *
 * Run:  npx tsx --test src/lib/author-spec.autonomous-markdown-default-check.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildStructuredSpecInputFromMarkdown, assertEveryPhaseHasMachineCheck } from "./author-spec";

/** The real shape a db_health proposal hands to markNewSpecInReview — prose-only Verification. */
const DB_HEALTH_MARKDOWN = `# Add index for the specs slow query

**Owner:** [[../functions/platform]] · **Parent:** [[../functions/platform]] — "Infra & DevOps / reliability" mandate: a seq scan on a hot table is a reliability cost.

**Why:** A slow query on \`specs\` is doing a sequential scan on every call.
**What:** An index that turns the seq scan into an index scan.

The \`specs\` table is scanned sequentially by a hot query (91ms mean × 26,677 calls = 2,434s cumulative).

## Phase 1 — add index

Add the covering index for the hot predicate in a new \`supabase/migrations/*.sql\`.

## Verification

- On the DB, confirm the new index exists and the query plan no longer shows a Seq Scan.
- Confirm mean execution time drops on the next db-health pass.
`;

test("THE LOOP: a prose-only autonomous markdown now yields a machine-runnable check", () => {
  const input = buildStructuredSpecInputFromMarkdown("db-index-specs", DB_HEALTH_MARKDOWN);
  assert.equal(input.phases.length, 1);
  const checks = input.phases[0].checks ?? [];
  assert.ok(checks.length >= 1, "phase must carry at least one check");
  assert.ok(
    checks.some((c) => c.exec_kind === "tsc" && c.kind === "auto"),
    "the default machine-runnable tsc check must be attached",
  );
});

test("…and it therefore PASSES the chokepoint that was rejecting it", () => {
  const input = buildStructuredSpecInputFromMarkdown("db-index-specs", DB_HEALTH_MARKDOWN);
  // This is the exact gate that threw MissingMachineCheckError on every db_health retry.
  assert.doesNotThrow(() =>
    assertEveryPhaseHasMachineCheck(
      "db-index-specs",
      input.phases.map((p) => ({
        title: p.title,
        checks: p.checks ?? [],
        specText: [DB_HEALTH_MARKDOWN, p.title, p.body].filter(Boolean).join("\n"),
      })),
    ),
  );
});

test("the human prose bullets are PRESERVED verbatim on `verification` — nothing is lost", () => {
  const input = buildStructuredSpecInputFromMarkdown("db-index-specs", DB_HEALTH_MARKDOWN);
  const v = input.phases[0].verification ?? "";
  assert.match(v, /Seq Scan/, "the operator-facing bullets must survive");
  assert.match(v, /mean execution time/);
});

test("owner + parent are carried through, so the spec is not an orphan", () => {
  const input = buildStructuredSpecInputFromMarkdown("db-index-specs", DB_HEALTH_MARKDOWN);
  assert.match(input.owner, /platform/);
  assert.match(input.parent, /mandate/);
});

test("a multi-phase autonomous markdown gets the default check on EVERY phase", () => {
  const md = DB_HEALTH_MARKDOWN.replace(
    "## Verification",
    "## Phase 2 — verify the plan\n\nRe-run EXPLAIN after the index lands.\n\n## Verification",
  );
  const input = buildStructuredSpecInputFromMarkdown("db-index-specs", md);
  assert.equal(input.phases.length, 2);
  for (const p of input.phases) {
    assert.ok((p.checks ?? []).some((c) => c.exec_kind === "tsc"), `phase "${p.title}" needs the default check`);
  }
});
