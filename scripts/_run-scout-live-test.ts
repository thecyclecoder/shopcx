/**
 * First LIVE end-to-end Meta scout — one product, bounded vision cap.
 *
 * Exercises the exact path the box job runs (`runCreativeScoutSweep`), so a green run here proves
 * collect → render → vision → persist works assembled, not just per-module.
 *
 * ⚠️ WRITES TO PROD `creative_skeletons` and spends vision tokens. Bounded by VISION_CAP per
 * competitor. Idempotent in the sense that already-stored ad_keys are skipped (splitNewExisting),
 * so a re-run does not re-vision the same ads.
 */
import "./_bootstrap";
import { runCreativeScoutSweep } from "../src/lib/ads/creative-scout-runner";

const WORKSPACE = process.env.WORKSPACE || "";
const PRODUCT = process.env.PRODUCT || "";
const VISION_CAP = Number(process.env.VISION_CAP || 2);

async function main() {
  if (!WORKSPACE || !PRODUCT) throw new Error("set WORKSPACE= and PRODUCT=");
  console.log(`live scout · workspace ${WORKSPACE.slice(0, 8)} · product ${PRODUCT.slice(0, 8)} · visionCap ${VISION_CAP}\n`);
  const t0 = Date.now();
  const r = await runCreativeScoutSweep({
    workspaceId: WORKSPACE,
    productId: PRODUCT,
    force: true, // bypass the freshness gate — this is a deliberate test run
    visionCap: VISION_CAP,
  });
  console.log(`\n── result (${Math.round((Date.now() - t0) / 1000)}s) ──`);
  console.log(`  products     ${r.products}`);
  console.log(`  competitors  ${r.competitors}`);
  console.log(`  ads seen     ${r.searched}`);
  console.log(`  NEW ingested ${r.inserted}`);
  console.log(`  re-observed  ${r.reobserved}`);
  console.log(`  failed       ${r.failed}`);
  console.log(`  unresolved   ${r.unresolved.length ? r.unresolved.join(", ") : "none"}`);
  console.log(`  imitation review queued: ${r.imitationReviewEnqueued}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
