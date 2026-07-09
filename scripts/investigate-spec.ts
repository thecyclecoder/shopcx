/**
 * investigate-spec — Mario's (and any operator's) one-call investigation over the read-only
 * spec-investigation SDK ([[../docs/brain/libraries/spec-investigation]]). Prints the full lifecycle
 * snapshot for a spec, or a focused answer, as JSON.
 *
 *   npx tsx scripts/investigate-spec.ts <slug>                # full investigateSpec
 *   npx tsx scripts/investigate-spec.ts <slug> review         # whyDidSpecReviewFail
 *   npx tsx scripts/investigate-spec.ts <slug> waiting        # whatIsSpecWaitingOn
 *   npx tsx scripts/investigate-spec.ts <slug> building       # whyIsSpecNotBuilding
 *   npx tsx scripts/investigate-spec.ts <slug> timeline       # getSpecTimeline
 *   npx tsx scripts/investigate-spec.ts --goal <goalSlug>     # investigateGoal
 *
 * PHANTOM CHECK (Mario): `investigateSpec` returns null ONLY when there is no spec row at all — a
 * true phantom (a timecard event backfilled from a spec_status_history row whose authorship failed).
 * A null result here ⇒ trigger_accurate=false: there is nothing to fix.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import {
  investigateSpec,
  whyDidSpecReviewFail,
  whatIsSpecWaitingOn,
  whyIsSpecNotBuilding,
  getSpecTimeline,
  investigateGoal,
} from "../src/lib/spec-investigation";

const WORKSPACE_ID = process.env.SHOPCX_WORKSPACE_ID || "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company

function out(v: unknown) {
  console.log(JSON.stringify(v, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--goal") {
    const goalSlug = args[1];
    if (!goalSlug) throw new Error("usage: investigate-spec --goal <goalSlug>");
    out(await investigateGoal(WORKSPACE_ID, goalSlug));
    return;
  }
  const slug = args[0];
  const mode = args[1] ?? "full";
  if (!slug) throw new Error("usage: investigate-spec <slug> [review|waiting|building|timeline]");
  switch (mode) {
    case "review":
      out(await whyDidSpecReviewFail(WORKSPACE_ID, slug));
      break;
    case "waiting":
      out(await whatIsSpecWaitingOn(WORKSPACE_ID, slug));
      break;
    case "building":
      out(await whyIsSpecNotBuilding(WORKSPACE_ID, slug));
      break;
    case "timeline":
      out(await getSpecTimeline(WORKSPACE_ID, slug));
      break;
    default: {
      const inv = await investigateSpec(WORKSPACE_ID, slug);
      if (!inv) {
        out({ phantom: true, slug, note: "No spec row exists for this slug — a true phantom (trigger_accurate=false)." });
        return;
      }
      out(inv);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
