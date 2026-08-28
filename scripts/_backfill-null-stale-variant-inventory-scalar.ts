/**
 * Ship-time backfill — NULL the frozen `product_variants.inventory_quantity` scalar.
 *
 * WHY (founder ruling 2026-08-28):
 * The column is a backfill snapshot from 2026-04-27 with NO writer. `sync-inventory.ts` touches the
 * same rows hourly to fan `servings` down — stamping `updated_at: now()` while never updating
 * `inventory_quantity`. The result is the worst possible shape for a stale value: a four-month-old
 * number wearing a one-hour-old timestamp, so anyone sanity-checking freshness gets a false yes.
 *
 * Measured 2026-08-28 against the canonical stores:
 *   19 variants had both a scalar and a 3PL figure — 18 (95%) disagreed.
 *   2 read "in stock" while the 3PL had none:
 *     SC-TABS-SL-2      scalar 3748 · 3PL 0   ← sold to Keira Ariel (ticket 0c9f11a7)
 *     ST-PHONESOCKET-1  scalar  164 · 3PL 0
 *   Mixed Berry still read 3746 — the exact frozen figure behind incident 9a7f9481, where the AI
 *   promised a reship that could never ship.
 *
 * SAFE BECAUSE NOTHING READS IT. Verified 2026-08-28: no `src/` code selects the column. The portal
 * filters `products.variants[].inventory_quantity` (Store A, correctly synced); the dashboard
 * variants API selects around it and joins canonical via `getShopifyOnHandByVariant`; the
 * orchestrator was moved off it after 9a7f9481; and `src/lib/product-variants.ts` deliberately omits
 * it from the SDK. The only readers left are throwaway `scripts/_*` probes.
 *
 * Nulling turns a plausible wrong answer into an obvious absent one, which is the whole point —
 * canonical on-hand lives in [[inventory_levels]] via `src/lib/inventory/read.ts`:
 *   getShopifyOnHandByVariant  → the storefront BUY GATE
 *   getAmplifierOnHandBySku    → the 3PL SHIP TRUTH (the authority; founder 2026-08-28)
 *
 * Idempotent: only touches rows where the column is NOT NULL. Re-running is a no-op.
 *
 * Usage:
 *   npx tsx scripts/_backfill-null-stale-variant-inventory-scalar.ts           # dry run
 *   npx tsx scripts/_backfill-null-stale-variant-inventory-scalar.ts --apply
 */
import { createAdminClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";

const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("product_variants")
    .select("id, workspace_id, sku, title, inventory_quantity, updated_at")
    .not("inventory_quantity", "is", null);
  if (error) throw new Error(`product_variants read failed: ${error.message}`);
  const rows = (data ?? []) as Array<Record<string, unknown>>;

  console.log(`rows still carrying a frozen scalar: ${rows.length}`);
  if (!rows.length) return console.log("nothing to do — already NULL everywhere");

  // Show the dangerous class explicitly so the operator sees WHY this matters.
  const { getAmplifierOnHandBySku } = await import("../src/lib/inventory/read");
  const byWs = new Map<string, Map<string, number>>();
  let dangerous = 0;
  for (const r of rows) {
    const ws = String(r.workspace_id);
    if (!byWs.has(ws)) byWs.set(ws, await getAmplifierOnHandBySku(admin, ws));
    const ship = byWs.get(ws)!.get(String(r.sku ?? ""));
    const scalar = Number(r.inventory_quantity ?? 0);
    if (ship !== undefined && scalar > 0 && ship <= 0) {
      dangerous++;
      console.log(`  ⚠️ ${String(r.sku).padEnd(24)} scalar=${String(scalar).padStart(6)}  3PL=${ship}  (reads in-stock, cannot ship)`);
    }
  }
  console.log(`  of which "scalar > 0 while the 3PL has none": ${dangerous}`);

  if (!APPLY) return console.log("\nDRY RUN — re-run with --apply to NULL the column.");

  let ok = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const { error: uErr } = await admin
        .from("product_variants")
        .update({ inventory_quantity: null })
        .eq("id", r.id as string);
      if (uErr) throw uErr;
      ok++;
    } catch (e) {
      failed++;
      console.error(`  ✗ ${r.sku}: ${errText(e)}`);
    }
  }
  console.log(`\nnulled ${ok}/${rows.length}${failed ? ` · ${failed} failed` : ""}`);

  const { count } = await admin
    .from("product_variants")
    .select("*", { count: "exact", head: true })
    .not("inventory_quantity", "is", null);
  console.log(`remaining non-null: ${count ?? "?"}`);
}

main().catch((e) => {
  console.error(errText(e));
  process.exit(1);
});
