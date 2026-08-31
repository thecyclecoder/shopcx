/**
 * Get Amazing Coffee K-Cups into the ad flow (CEO 2026-08-25).
 *
 * The chain, in dependency order — one flag gates the first TWO steps:
 *
 *   1. `products.is_advertised = true`
 *        · the hero gate. `/api/ads/advertised-products` filters the Dahlia competitor→ad product
 *          dropdown on it, which is why K-Cups had no option there.
 *        · it ALSO short-circuits `generateAngles`, which returns `not_advertised` BEFORE the
 *          metered Opus call. So the missing dropdown and the missing angles are one root cause.
 *   2. generate `product_ad_angles` — K-Cups had 0; every other hero product has 22-36. Angles are
 *      the ad-copy source, and Bianca's replenish DEFERS a campaign whose `angle_id` is null.
 *
 * Not blockers (already verified good): 23 product_media rows, a rich intelligence corpus
 * (12 ingredient entries, 10 proof quotes, 1,110 reviews @ 4.9), an ACTIVE test cohort with a
 * campaign + adset template and 3 open slots, and 3,864 units of website-side stock.
 *
 * Competitors: K-Cups has none of its own, but Amazing Coffee has 10 (mudwtr, ryze, foursigmatic,
 * bulletproof, erthlabs, everydaydose, …). Per the CEO those apply to K-Cups, so the research side
 * needs no new scraping — only the product scoping question below.
 *
 * IDEMPOTENT. Pass --apply to write. `--angles` additionally spends ONE Opus call to generate.
 */
import { createAdminClient } from "./_bootstrap";
import { generateAngles } from "../src/lib/ad-angles";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KCUPS = "f081a8ee-530b-4789-8654-bd57c3a51569";
const APPLY = process.argv.includes("--apply");
const DO_ANGLES = process.argv.includes("--angles");

async function main() {
  const admin = createAdminClient();

  const { data: p } = await admin.from("products")
    .select("id,title,is_advertised").eq("id", KCUPS).maybeSingle();
  if (!p) throw new Error("no K-Cups product row");
  console.log(`${p.title} · is_advertised=${p.is_advertised}`);

  // ── 1. the hero gate ─────────────────────────────────────────────────────
  if (p.is_advertised === true) {
    console.log("  is_advertised already true — no-op");
  } else if (!APPLY) {
    console.log("  would set is_advertised = true (unlocks the Dahlia dropdown AND angle generation)");
  } else {
    const { error } = await admin.from("products")
      .update({ is_advertised: true }).eq("id", KCUPS).eq("is_advertised", false); // compare-and-set
    if (error) throw new Error(`products update: ${error.message}`);
    console.log("  ✅ is_advertised = true");

    const { error: ae } = await admin.from("director_activity").insert({
      workspace_id: WS,
      director_function: "growth",
      action_kind: "product_promoted_to_advertised",
      reason:
        `CEO 2026-08-25: Amazing Coffee K-Cups flagged is_advertised — it had no option in the Dahlia ` +
        `competitor→ad product dropdown (/api/ads/advertised-products filters on this flag) and angle ` +
        `generation was short-circuiting on the same flag with reason='not_advertised'. K-Cups is the ` +
        `unconstrained-stock lever: 3,864 website units vs an FBA-starved catalogue.`,
      metadata: { product_id: KCUPS, autonomous: false },
    });
    if (ae) console.log(`  ⚠ audit row failed: ${ae.message}`);
  }

  // ── 2. angles ────────────────────────────────────────────────────────────
  const { count: angleCount } = await admin.from("product_ad_angles")
    .select("id", { count: "exact", head: true }).eq("product_id", KCUPS).eq("is_active", true);
  console.log(`\nactive angles: ${angleCount ?? 0}`);
  if ((angleCount ?? 0) > 0) {
    console.log("  already has angles — skipping generation");
  } else if (!DO_ANGLES) {
    console.log("  0 angles. Re-run with --apply --angles to generate (ONE metered Opus call).");
  } else if (!APPLY) {
    console.log("  --angles given but not --apply; nothing generated.");
  } else {
    console.log("  generating (one Opus call)…");
    const res = await generateAngles(KCUPS, 12);
    console.log(`  ok=${res.ok} inserted=${res.inserted.length} rejected=${res.rejected.length} ${res.reason ? `reason=${res.reason}` : ""}`);
    for (const a of res.inserted.slice(0, 12)) {
      console.log(`    ✅ ${String((a as Record<string, unknown>).hook_slug ?? "").padEnd(18)} ${String((a as Record<string, unknown>).meta_headline ?? "").slice(0, 60)}`);
    }
    for (const r of res.rejected.slice(0, 5)) console.log(`    ✗ rejected: ${JSON.stringify(r).slice(0, 140)}`);
  }

  console.log(`\n${APPLY ? "APPLIED" : "DRY RUN (pass --apply, add --angles to generate)"}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
