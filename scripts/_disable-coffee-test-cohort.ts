/**
 * Stop Bianca posting new TEST adsets for Amazing Coffee — it is out of stock
 * (CEO 2026-08-24).
 *
 * ## The lever
 *
 * `media_buyer_test_cohorts.is_active = false` on the Amazing Coffee row.
 * Cohorts are PRODUCT-scoped, so this is surgical:
 *
 *   - `readActiveCohortProductIds` (agent.ts) filters `is_active = true`, so
 *     Coffee stops being enumerated as a pass → no replenish → no publish.
 *   - Amazing Creamer shares the SAME ad account but has its OWN cohort row, so
 *     the account keeps running and Creamer is untouched.
 *   - Amazing Coffee K-Cups has NO cohort at all, so nothing to disable there
 *     (Bianca cannot test K-Cups today — see the note this script prints).
 *
 * Deliberately NOT `meta_ad_accounts.is_active = false`: that account serves
 * Creamer too, which the CEO wants left alone.
 *
 * Idempotent — re-running is a no-op. Writes a `director_activity` row so the
 * change is never silent, and refuses to run if it cannot find exactly one
 * Coffee cohort.
 *
 *   npx tsx scripts/_disable-coffee-test-cohort.ts            # dry run
 *   npx tsx scripts/_disable-coffee-test-cohort.ts --apply
 */
import { createAdminClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";

const APPLY = process.argv.includes("--apply");
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TARGET_TITLE = "Amazing Coffee"; // EXACT — must not match "Amazing Coffee K-Cups"

async function main() {
  const admin = createAdminClient();

  // Resolve the product by EXACT title so K-Cups can never be caught.
  const { data: prods, error: pErr } = await admin
    .from("products").select("id,title").eq("workspace_id", WS).eq("title", TARGET_TITLE);
  if (pErr) throw new Error(`products: ${pErr.message}`);
  if (!prods?.length) throw new Error(`no product titled exactly "${TARGET_TITLE}"`);
  if (prods.length > 1) throw new Error(`${prods.length} products titled "${TARGET_TITLE}" — refusing to guess`);
  const coffeeId = String(prods[0].id);
  console.log(`target product: "${TARGET_TITLE}" (${coffeeId})\n`);

  // Show the full cohort picture so the blast radius is visible before writing.
  const { data: cohorts, error: cErr } = await admin
    .from("media_buyer_test_cohorts")
    .select("id,product_id,meta_ad_account_id,is_active")
    .eq("workspace_id", WS);
  if (cErr) throw new Error(`media_buyer_test_cohorts: ${cErr.message}`);
  const pids = [...new Set((cohorts ?? []).map((c) => c.product_id).filter(Boolean))] as string[];
  const { data: titles } = await admin.from("products").select("id,title")
    .in("id", pids.length ? pids : ["00000000-0000-0000-0000-000000000000"]);
  const title = new Map((titles ?? []).map((p) => [String(p.id), String(p.title)]));

  console.log("cohort                          active   change");
  for (const c of cohorts ?? []) {
    const t = c.product_id ? (title.get(String(c.product_id)) ?? String(c.product_id).slice(0, 8)) : "(account default)";
    const hit = String(c.product_id) === coffeeId;
    console.log(`${t.slice(0, 30).padEnd(32)}${String(c.is_active).padEnd(9)}${hit ? "→ DISABLE" : "unchanged"}`);
  }

  const target = (cohorts ?? []).filter((c) => String(c.product_id) === coffeeId);
  if (target.length !== 1) throw new Error(`expected exactly 1 Amazing Coffee cohort, found ${target.length}`);
  const row = target[0];
  if (row.is_active === false) { console.log("\nAlready disabled — nothing to do."); return; }

  // Anything already queued would still fire even with the cohort off.
  const { data: queued } = await admin
    .from("ad_publish_jobs")
    .select("id,publish_status,created_at,ad_campaign_id")
    .eq("workspace_id", WS)
    .eq("origin", "media-buyer-test")
    .in("publish_status", ["queued", "pending", "processing"])
    .limit(50);
  console.log(`\nin-flight media-buyer-test publish jobs (any product): ${queued?.length ?? 0}`);
  for (const j of queued ?? []) console.log(`  ${j.id} ${j.publish_status} ${String(j.created_at).slice(0, 16)}`);
  if (queued?.length) {
    console.log("  ⚠ these predate the cohort flip and may still publish — check whether any are Coffee.");
  }

  if (!APPLY) { console.log("\nDRY RUN — re-run with --apply to write."); return; }

  const { error: upErr } = await admin
    .from("media_buyer_test_cohorts")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("is_active", true); // compare-and-set
  if (upErr) throw new Error(`update failed: ${upErr.message}`);

  const { error: aErr } = await admin.from("director_activity").insert({
    workspace_id: WS,
    director_function: "growth",
    action_kind: "media_buyer_cohort_disabled",
    spec_slug: null,
    reason:
      `Amazing Coffee test cohort disabled — product is OUT OF STOCK (CEO 2026-08-24). ` +
      `Bianca will no longer enumerate Coffee as a pass, so no replenish and no new test adsets. ` +
      `Amazing Creamer shares the ad account but keeps its own ACTIVE cohort and is unaffected. ` +
      `Re-enable when stock returns.`,
    metadata: {
      cohort_id: row.id,
      product_id: coffeeId,
      product_title: TARGET_TITLE,
      meta_ad_account_id: row.meta_ad_account_id,
      reason_code: "out_of_stock",
      autonomous: false,
    },
  });
  if (aErr) console.error(`⚠ audit row failed (cohort DID change): ${aErr.message}`);

  const { data: after } = await admin.from("media_buyer_test_cohorts")
    .select("is_active").eq("id", row.id).single();
  console.log(`\nAPPLIED. Amazing Coffee cohort is_active = ${after?.is_active}`);
  console.log("director_activity: media_buyer_cohort_disabled");
  console.log("\nNOTE: Amazing Coffee K-Cups has NO cohort, so Bianca cannot test it either.");
  console.log("      If you want K-Cups tested (it has ~3,900 website units), it needs one provisioned.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(errText(e)); process.exit(1); });
