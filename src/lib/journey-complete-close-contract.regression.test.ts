/**
 * Journey-completion close-contract pin — spec
 * docs/brain/specs/journey-completion-stamps-closed-at-so-cora-can-grade.md.
 *
 * Every ticket close writer in the journey completion route (cancel / saved / declined) must
 * stamp `status='closed'` alongside `closed_at` AND `updated_at`, not just `resolved_at`.
 * Cora's 30-min settle gate at src/lib/inngest/ticket-analysis-cron.ts filters on
 * `closed_at IS NOT NULL AND closed_at <= (now - 30 min)` — a close writer that leaves
 * closed_at null leaves the ticket permanently invisible to the analyzer even though it
 * looks closed to the Control Tower, which is exactly the "phantom analyzer backlog +
 * ungraded journey ticket" incident this spec repairs.
 *
 * A source-inspection pin (not a runtime test) so an in-file refactor that preserves the
 * semantic — extracting the six-field write into a helper, reordering the fields, moving
 * the timestamp into a `const ts = ...` — keeps passing, while a refactor that reintroduces
 * a bare `status: "closed", resolved_at: ...` write red-lights loudly.
 *
 * Run: npx tsx --test src/lib/journey-complete-close-contract.regression.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROUTE = "src/app/api/journey/[token]/complete/route.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf-8");
}

/** Every `status: "closed"` write in the journey completion route must carry all four
 *  close-contract fields (status, resolved_at, closed_at, updated_at) in the same update
 *  block. The regex windows the fields to a single `.update({ ... })` call so a two-write
 *  pattern that splits them into separate updates does not accidentally pass. */
function countCloseWritesWithFullContract(src: string): { closedWrites: number; contractComplete: number } {
  // Find every `.update({ ... status: "closed" ... })` block by walking `.update({` opens.
  // A close write is any `admin.from("tickets").update({` block whose body contains
  // `status: "closed"`.
  const closedWrites: string[] = [];
  const anchor = /\.from\("tickets"\)\s*\.update\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(src))) {
    // Scan forward to find the matching `})` at the same brace depth.
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    const body = src.slice(m.index + m[0].length, i - 1);
    if (/status:\s*"closed"/.test(body)) closedWrites.push(body);
  }
  const contractComplete = closedWrites.filter(
    (b) =>
      /\bresolved_at\s*:/.test(b) &&
      /\bclosed_at\s*:/.test(b) &&
      /\bupdated_at\s*:/.test(b),
  ).length;
  return { closedWrites: closedWrites.length, contractComplete };
}

test("journey/[token]/complete: every status='closed' write stamps resolved_at + closed_at + updated_at together", () => {
  const src = read(ROUTE);
  const { closedWrites, contractComplete } = countCloseWritesWithFullContract(src);
  // Sanity — the route must have close writes at all. If a refactor collapses them into a
  // shared helper this count drops legitimately; when that happens the counts still match
  // (helper-in-file), and this pin still fires on the helper's body.
  assert.ok(
    closedWrites >= 3,
    `expected the journey completion route to contain at least 3 status='closed' write blocks (cancel + saved + declined), found ${closedWrites}. The pin is stale — either the route lost a close writer or the shape changed and this test needs updating.`,
  );
  assert.equal(
    contractComplete,
    closedWrites,
    `every status='closed' write in ${ROUTE} must include resolved_at AND closed_at AND updated_at in the same update block (Cora's ticket-analysis-cron settle gate selects on closed_at IS NOT NULL — a null closed_at leaves the ticket permanently invisible to the analyzer). Found ${contractComplete}/${closedWrites} writes with the full contract.`,
  );
});

test("journey/[token]/complete: cancel outcome branch closes with the full contract", () => {
  const src = read(ROUTE);
  // The cancelled branch is the origin bug — a customer cancelled a sub, the flow set
  // status=closed + resolved_at, but closed_at stayed null so Cora skipped the ticket.
  // Pin that this branch's close write specifically carries closed_at.
  const cancelBranch = src.match(/if\s*\(outcome\s*===\s*"cancelled"\s*&&\s*selectedSub\)[\s\S]*?else if\s*\(outcome\?\.startsWith\("saved_"\)/);
  assert.ok(cancelBranch, "cancelled-outcome branch not found — regression pin structure changed, update this test");
  assert.match(
    cancelBranch[0],
    /status:\s*"closed"[\s\S]{0,300}?closed_at:/,
    "cancelled-outcome close write must include closed_at within the same update block",
  );
});

test("journey/[token]/complete: saved outcome branch closes with the full contract", () => {
  const src = read(ROUTE);
  const savedBranch = src.match(/else if\s*\(outcome\?\.startsWith\("saved_"\)[\s\S]*?\/\/ Log actions as internal note/);
  assert.ok(savedBranch, "saved-outcome branch not found — regression pin structure changed, update this test");
  assert.match(
    savedBranch[0],
    /status:\s*"closed"[\s\S]{0,300}?closed_at:/,
    "saved-outcome close write must include closed_at within the same update block",
  );
});
