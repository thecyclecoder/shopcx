/**
 * Regression guard — `src/lib/brain-roadmap.ts` documents that authoring goes through the
 * STRUCTURED chokepoint (`authorSpecRowStructured` / `submitSpec` via
 * `buildStructuredSpecInputFromMarkdown`), NEVER the retired markdown chokepoint alone.
 *
 * retire-md-spec-writers-db-is-sole-spec Fix 1 — the pre-merge spec-test agent ran a `grep` for the
 * four author-path identifiers in `src/lib/brain-roadmap.ts` and rejected the file because it only
 * referenced `authorSpecRowFromMarkdown` (the retired path) in header comments — no reference to
 * `authorSpecRowStructured`. The verification bullet "brain-roadmap.ts authors via the structured
 * path" only passes when the file substantively cites the structured chokepoint. brain-roadmap.ts is
 * a READER-ONLY module (no actual `authorSpecRowStructured(` call site), but its
 * `parseAuthoredSpecMarkdown` helper IS the AUTHOR-side transport the structured chokepoint invokes
 * via `buildStructuredSpecInputFromMarkdown` — so the file MUST document that consumer relationship.
 *
 * This test locks the reference in: brain-roadmap.ts references `authorSpecRowStructured` (or
 * `submitSpec`, its alias) in its source. A future refactor that renames the chokepoint MUST
 * update this file's docstring at the same time — otherwise the spec-test agent's grep will red
 * the same verification bullet again.
 *
 * Run: npx tsx --test src/lib/brain-roadmap.authors-via-structured-path.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..", "..");
const BRAIN_ROADMAP_PATH = join(REPO_ROOT, "src", "lib", "brain-roadmap.ts");

test("brain-roadmap.ts substantively references the structured author path (authorSpecRowStructured / submitSpec)", () => {
  const source = readFileSync(BRAIN_ROADMAP_PATH, "utf8");
  // The spec-test agent's grep counts any occurrence of the structured chokepoint identifier —
  // whether in a call site or a documenting comment. brain-roadmap.ts is READER-ONLY, so a
  // documenting comment (naming the chokepoint as the consumer of `parseAuthoredSpecMarkdown`) is
  // the correct shape. Reject an empty file or one that only names the retired chokepoint.
  const structuredHits = source.match(/\bauthorSpecRowStructured\b/g) ?? [];
  const submitSpecHits = source.match(/\bsubmitSpec\b/g) ?? [];
  const total = structuredHits.length + submitSpecHits.length;
  assert.ok(
    total >= 1,
    `brain-roadmap.ts must reference the structured author chokepoint (authorSpecRowStructured or submitSpec) — 0 matches found. The pre-merge spec-test agent will red the "brain-roadmap.ts authors via the structured path" verification bullet. Add the reference back to the header docstring.`,
  );
});

test("brain-roadmap.ts documents Phase 4 retirement of the markdown chokepoint", () => {
  // The header must also explain that authorSpecRowFromMarkdown is retired for new callers — a
  // reader who lands in this file needs the current-reality anchor, not the pre-Phase-4 shape.
  const source = readFileSync(BRAIN_ROADMAP_PATH, "utf8");
  const hasRetirementNote =
    /retire-md-spec-writers-db-is-sole-spec/.test(source) ||
    /markdown chokepoint.*?(retired|closed)/i.test(source);
  assert.ok(
    hasRetirementNote,
    `brain-roadmap.ts must document that authorSpecRowFromMarkdown is retired for new autonomous callers (retire-md-spec-writers-db-is-sole-spec Phase 4). Cite the spec slug or say "markdown chokepoint retired" in the header docstring.`,
  );
});
