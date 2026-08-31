/**
 * Apply the shared-competitor-shelf migration and point K-Cups at Amazing Coffee.
 *
 * K-Cups is the same coffee in a pod, so the coffee competitors (mudwtr, ryze, foursigmatic,
 * bulletproof, erthlabs, …) legitimately serve it — but `creative_skeletons.product_id` is the
 * deliberate imitate link, so K-Cups was imitating from an EMPTY shelf.
 *
 * Directed on purpose: K-Cups → Amazing Coffee, never the reverse (Coffee has its own rich shelf).
 * Sweep seeds stay strictly product-scoped, so this shares the shelf WITHOUT doubling AdLibrary quota.
 *
 * IDEMPOTENT. Pass --apply to write.
 */
import { pgClient, createAdminClient } from "./_bootstrap";
import { readFileSync } from "node:fs";
import { resolveShelfProductIds } from "../src/lib/ads/creative-sourcing";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KCUPS = "f081a8ee-530b-4789-8654-bd57c3a51569";
const COFFEE = "ea433e56-0aa4-4b46-9107-feb11f77f533";
const MIGRATION = "supabase/migrations/20261214120000_products_competitor_shelf_source.sql";
const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();

  // Does the column exist yet?
  const probe = await admin.from("products").select("competitor_shelf_source_id").limit(1);
  const columnExists = !probe.error;
  console.log(`column competitor_shelf_source_id: ${columnExists ? "present" : "MISSING — migration needed"}`);

  if (!columnExists) {
    if (!APPLY) { console.log("  would apply " + MIGRATION); }
    else {
      const sql = readFileSync(MIGRATION, "utf8");
      const c = pgClient();
      await c.connect();
      try { await c.query(sql); console.log("  ✅ migration applied"); }
      finally { await c.end(); }
    }
  }

  if (!APPLY) { console.log("\nDRY RUN — pass --apply"); return; }

  // Point K-Cups at Amazing Coffee (compare-and-set: only when currently unset).
  const { data: cur } = await admin.from("products")
    .select("id,title,competitor_shelf_source_id").eq("id", KCUPS).maybeSingle();
  if (cur?.competitor_shelf_source_id === COFFEE) {
    console.log("\nK-Cups already points at Amazing Coffee — no-op");
  } else if (cur?.competitor_shelf_source_id) {
    console.log(`\n⚠ K-Cups already points at ${cur.competitor_shelf_source_id} — SKIPPING (not overwriting)`);
  } else {
    const { error } = await admin.from("products")
      .update({ competitor_shelf_source_id: COFFEE }).eq("id", KCUPS).is("competitor_shelf_source_id", null);
    if (error) throw new Error(`products update: ${error.message}`);
    console.log("\n✅ K-Cups → Amazing Coffee shelf");

    await admin.from("director_activity").insert({
      workspace_id: WS,
      director_function: "growth",
      action_kind: "product_competitor_shelf_shared",
      reason:
        `CEO 2026-08-25: Amazing Coffee K-Cups now imitates from Amazing Coffee's scouted competitor shelf. ` +
        `K-Cups is the same coffee in a pod, so the coffee competitors serve it — but creative_skeletons.product_id ` +
        `is the deliberate imitate link, so K-Cups was sourcing from an empty shelf. A POINTER rather than copied ` +
        `competitor rows: the AdLibrary freshness ledger is keyed on (workspace, keyword) and the sweep walks ` +
        `products sequentially, so duplicate rows would have let whichever product sweeps first starve the other ` +
        `permanently while burning storage for nothing. Sweep seeds stay product-scoped — no extra quota.`,
      metadata: { product_id: KCUPS, shelf_source_id: COFFEE, autonomous: false },
    });
    console.log("✅ audit row written");
  }

  // Verify through the real resolver, then count what K-Cups can now see.
  const ids = await resolveShelfProductIds(admin, KCUPS);
  console.log(`\nresolveShelfProductIds(K-Cups) → ${ids.length} id(s): ${ids.join(", ")}`);

  const { count: own } = await admin.from("creative_skeletons")
    .select("id", { count: "exact", head: true }).eq("workspace_id", WS).eq("product_id", KCUPS);
  const { count: shelf } = await admin.from("creative_skeletons")
    .select("id", { count: "exact", head: true }).eq("workspace_id", WS).in("product_id", ids);
  console.log(`  skeletons on K-Cups' own shelf: ${own ?? 0}`);
  console.log(`  skeletons visible via the shared shelf: ${shelf ?? 0}`);

  // And the reverse must NOT have widened.
  const coffeeIds = await resolveShelfProductIds(admin, COFFEE);
  console.log(`\nresolveShelfProductIds(Amazing Coffee) → ${coffeeIds.length} id(s) ${coffeeIds.length === 1 ? "✅ not widened (directed)" : "⚠ unexpectedly widened"}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
