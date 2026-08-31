/**
 * Predeploy guard: the media buyer's scale-edit rails must actually be FED.
 *
 * ## The failure this exists to prevent
 *
 * `computeMediaBuyerPlan` implements two rails on the promote path —
 * `per_object_cooldown_hours` and `per_account_daily_budget_delta_ceiling_cents`.
 * Both are driven by `recentActions` + `nowMs`, and BOTH inputs are OPTIONAL so
 * pre-rail unit tests keep the old behaviour.
 *
 * The runner never passed them. Zero call sites. So `inCooldown()` returned
 * `{in:false}` for every object and the rail could not fire — while the policy
 * row said `per_object_cooldown_hours: 24` and every dashboard implied it was
 * enforced.
 *
 * Observed cost (2026-08): adset 120249488919900682 scaled at 08-18 22:00 and
 * again at 08-19 04:00 — six hours apart. Adset 120250143054030326 compounded
 * +20% steps from $259 to $1,114/day in ~20 hours. The CEO's rule is one budget
 * change per adset per day.
 *
 * A unit test cannot catch this: the pure function's cooldown behaviour IS
 * pinned (`agent.test.ts` — "winner whose parent adset is INSIDE
 * per_object_cooldown_hours is deferred"), and it passed the whole time. The
 * defect was entirely in the wiring, which is exactly the shape a static guard
 * catches and a fixture-fed test never will.
 *
 * ## What it asserts
 *
 *   1. the live `computeMediaBuyerPlan({...})` call in the runner passes
 *      `recentActions` AND `nowMs`
 *   2. `readRecentIterationActions` exists and is called
 *   3. the runner emits `media_buyer_scale_rail_deferred` so a suppressed
 *      promote is cited, never silent
 *
 * Deliberately textual rather than behavioural — the point is to make the
 * WIRING itself the invariant. Wired into `predeploy:static`.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const AGENT = resolve(__dirname, "../src/lib/media-buyer/agent.ts");

function fail(msg: string): never {
  console.error(`✗ check-scale-rails-wired — ${msg}`);
  console.error("");
  console.error("  The per-object cooldown rail is inert unless the runner feeds it.");
  console.error("  See docs/brain/libraries/media-buyer-agent.md § Scale-edit rails.");
  process.exit(1);
}

const src = readFileSync(AGENT, "utf8");

// 1. The LIVE plan call (not the `emptyPlan` dormancy shape) must pass both inputs.
//    Find every computeMediaBuyerPlan({ ... }) call and require at least one that
//    carries recentActions + nowMs.
const callRe = /computeMediaBuyerPlan\(\{([\s\S]*?)\n\s*\}\)/g;
const calls: string[] = [];
for (let m = callRe.exec(src); m; m = callRe.exec(src)) calls.push(m[1]);
if (calls.length === 0) fail("no computeMediaBuyerPlan({...}) call site found — did the runner change shape?");

const wired = calls.filter((c) => /\brecentActions\b/.test(c) && /\bnowMs\b/.test(c));
if (wired.length === 0) {
  fail(
    `found ${calls.length} computeMediaBuyerPlan call site(s), NONE passing both recentActions and nowMs — ` +
      "the cooldown + delta-ceiling rails are inert",
  );
}

// 2. The reader must exist and be invoked.
if (!/async function readRecentIterationActions\(/.test(src)) {
  fail("readRecentIterationActions is missing — nothing can populate recentActions");
}
if (!/await readRecentIterationActions\(/.test(src)) {
  fail("readRecentIterationActions is defined but never awaited — recentActions would be empty");
}

// 3. A suppressed promote must be cited.
if (!/media_buyer_scale_rail_deferred/.test(src)) {
  fail("no media_buyer_scale_rail_deferred emission — a rail-suppressed promote would be silent");
}
if (!/for \(const d of plan\.deferred\)/.test(src)) {
  fail("plan.deferred is never iterated — deferred promotes are computed but never surfaced");
}

console.log(
  `✓ check-scale-rails-wired — ${wired.length}/${calls.length} computeMediaBuyerPlan call site(s) feed recentActions + nowMs; ` +
    "reader wired; deferred promotes cited via media_buyer_scale_rail_deferred.",
);
