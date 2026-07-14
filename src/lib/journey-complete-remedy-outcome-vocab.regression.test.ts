/**
 * Journey-completion remedy_outcomes.outcome vocabulary pin — spec
 * .box/spec-cancel-flow-remedy-outcome-invalid-enum-values.md.
 *
 * `remedy_outcomes_outcome_check` (supabase/migrations/20260401200000_remedy_tracking_overhaul.sql)
 * restricts `remedy_outcomes.outcome` to `NULL | 'accepted' | 'passed_over' | 'rejected'`.
 * The cancel-flow completion route once wrote `outcome:'cancelled'` and `outcome:'saved'`
 * into `remedy_outcomes` — both violate the constraint (Postgres 23514) and, because the
 * inserts weren't error-checked, dropped silently. Every route-driven completion was
 * missing from cancel-flow save-rate analytics until the mapping was fixed to
 * cancelled→'rejected' and saved→'accepted'.
 *
 * A source-inspection pin (not a runtime test) so the constraint-vocabulary rule survives
 * refactors. Any future `admin.from("remedy_outcomes").insert({...})` in this route that
 * carries an out-of-vocabulary literal red-lights loudly.
 *
 * Run: npx tsx --test src/lib/journey-complete-remedy-outcome-vocab.regression.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROUTE = "src/app/api/journey/[token]/complete/route.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf-8");
}

/** Extract every `admin.from("remedy_outcomes").insert({ ... })` body from the route. */
function remedyOutcomeInsertBodies(src: string): string[] {
  const anchor = /\.from\("remedy_outcomes"\)\s*\.insert\(\{/g;
  const bodies: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    bodies.push(src.slice(m.index + m[0].length, i - 1));
  }
  return bodies;
}

test("journey/[token]/complete: no `outcome: 'cancelled'` / `outcome: 'saved'` literals in remedy_outcomes inserts (violates remedy_outcomes_outcome_check → Postgres 23514, drops silently)", () => {
  const src = read(ROUTE);
  const bodies = remedyOutcomeInsertBodies(src);
  assert.ok(
    bodies.length >= 2,
    `expected at least 2 remedy_outcomes inserts in the completion route (cancel + saved), found ${bodies.length}. The pin is stale — the route lost an insert or the shape changed and this test needs updating.`,
  );
  const invalid = bodies
    .map((b, i) => ({ i, b }))
    .filter(({ b }) => /\boutcome\s*:\s*["'](cancelled|saved)["']/.test(b));
  assert.equal(
    invalid.length,
    0,
    `remedy_outcomes.outcome must be one of NULL | 'accepted' | 'passed_over' | 'rejected' (per remedy_outcomes_outcome_check). Found ${invalid.length} insert(s) writing 'cancelled' or 'saved' — those are journey_sessions.outcome vocabulary, not remedy_outcomes.outcome. Map cancelled→'rejected' and saved→'accepted'.`,
  );
});

test("journey/[token]/complete: remedy_outcomes inserts use only the allowed outcome vocabulary", () => {
  const src = read(ROUTE);
  const bodies = remedyOutcomeInsertBodies(src);
  const ALLOWED = new Set(["accepted", "passed_over", "rejected"]);
  const invalid: { i: number; literal: string }[] = [];
  bodies.forEach((b, i) => {
    const match = b.match(/\boutcome\s*:\s*["']([^"']+)["']/);
    if (match && !ALLOWED.has(match[1])) invalid.push({ i, literal: match[1] });
  });
  assert.equal(
    invalid.length,
    0,
    `every string literal for remedy_outcomes.outcome must be one of ${Array.from(ALLOWED).join(" | ")} (per remedy_outcomes_outcome_check). Found: ${JSON.stringify(invalid)}.`,
  );
});

test("journey/[token]/complete: at least one insert writes outcome='rejected' (the corrected cancel-branch mapping)", () => {
  const src = read(ROUTE);
  const bodies = remedyOutcomeInsertBodies(src);
  const hasRejected = bodies.some((b) => /\boutcome\s*:\s*["']rejected["']/.test(b));
  assert.ok(
    hasRejected,
    `expected at least one remedy_outcomes insert to write outcome='rejected' (the cancel branch — customer churned after seeing remedies). Missing rejected literal means the cancel-flow save-rate analytics are blind to churn events.`,
  );
});
