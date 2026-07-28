/**
 * Regression: reconcileSwallowedEscalations must build its "already surfaced" set from the KEYS
 * UNDER TEST, never a blind sample of dashboard_notifications.
 *
 * The 2026-07-28 incident: the lookup was
 *   .from("dashboard_notifications").eq("type", APPROVAL_REQUEST_TYPE).limit(5000)
 * With 416,562 approval-request rows that sampled 1.2% of the table, so ~every key in the 1000-row
 * escalation ledger read as "swallowed" and each 5-min pass re-emitted ~600 founder cards — which
 * grew the table, which shrank the effective sample, which re-emitted more. 320k+ cards.
 *
 * These tests pin the two properties that make that impossible:
 *   1. the surfaced-set query FILTERS on dedupe_key (a keyed lookup, not a bare sample)
 *   2. a re-emit pass is bounded by SWALLOWED_REEMIT_CEILING
 *
 * Run: npm run test:swallowed-escalation-sample
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "src/lib/agents/platform-director.ts"), "utf8");

/** The body of `reconcileSwallowedEscalations` only. */
function reconcileBody(): string {
  const start = SRC.indexOf("export async function reconcileSwallowedEscalations");
  assert.ok(start > -1, "reconcileSwallowedEscalations must exist");
  const next = SRC.indexOf("\nexport ", start + 10);
  return SRC.slice(start, next === -1 ? SRC.length : next);
}

test("the surfaced-set lookup filters on dedupe_key — never a blind table sample", () => {
  const body = reconcileBody();
  const notifQuery = body.slice(body.indexOf("dashboard_notifications"));
  assert.match(
    notifQuery,
    /metadata->>dedupe_key/,
    "the surfaced-set query MUST filter on metadata->>dedupe_key; a bare .limit() sample re-emits the world as the table grows",
  );
});

test("no unfiltered .limit(5000) sample survives in the reconcile path", () => {
  const body = reconcileBody();
  assert.doesNotMatch(
    body,
    /\.eq\("type", APPROVAL_REQUEST_TYPE\)\s*\n\s*\.limit\(/,
    "a type-only + limit query is the exact 2026-07-28 bug shape",
  );
});

test("a re-emit pass is bounded by an explicit ceiling", () => {
  assert.match(SRC, /const SWALLOWED_REEMIT_CEILING\s*=\s*\d+/, "the ceiling constant must exist");
  const ceiling = Number(/const SWALLOWED_REEMIT_CEILING\s*=\s*(\d+)/.exec(SRC)?.[1]);
  assert.ok(ceiling > 0 && ceiling <= 100, `ceiling must be a small positive bound, got ${ceiling}`);
  assert.match(
    reconcileBody(),
    /reEmitted\.length\s*>=\s*SWALLOWED_REEMIT_CEILING/,
    "the re-emit loop must break at the ceiling",
  );
});

test("a failed surfaced-set read fails CLOSED (treated as surfaced, not as swallowed)", () => {
  const body = reconcileBody();
  assert.match(
    body,
    /if \(error\)[\s\S]{0,400}surfaced\.add/,
    "on a read error the chunk's keys must be added to `surfaced` — reading an error as 'nothing surfaced' re-emits the world",
  );
});
