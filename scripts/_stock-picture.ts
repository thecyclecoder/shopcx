/**
 * Stock reality check on the ramp plan — we can only sell what we can ship.
 *
 * Canonical 3PL source is `inventory_levels` (location='amplifier_3pl'), fed
 * daily from Amplifier `/reports/inventory/current` by the sync-3pl-inventory
 * cron. NOT the qb_* snapshots (those are the accounting rollup).
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();

  const { data: sample } = await admin.from("inventory_levels").select("*").eq("workspace_id", WS).limit(1);
  if (sample?.[0]) console.log("inventory_levels columns:", Object.keys(sample[0]).join(", "), "\n");

  const rows: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from("inventory_levels").select("*")
      .eq("workspace_id", WS).range(off, off + 999);
    if (error) throw new Error(`inventory_levels: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  const byLoc: Record<string, Array<Record<string, unknown>>> = {};
  for (const r of rows) {
    const l = String(r.location ?? "?");
    (byLoc[l] ??= []).push(r);
  }

  for (const [loc, set] of Object.entries(byLoc)) {
    console.log(`\n=== ${loc} — ${set.length} SKU(s) ===`);
    const qtyKey = "on_hand";
    const skuKey = "sku";
    if (!qtyKey || !skuKey) { console.log("  (unexpected shape)", Object.keys(set[0] ?? {})); continue; }
    const sorted = [...set]
      .filter((r) => !/DMG|SAMPLE|INSERT|TEST/i.test(String(r[skuKey])))
      .sort((a, b) => Number(b[qtyKey] ?? 0) - Number(a[qtyKey] ?? 0));
    let out = 0, low = 0;
    for (const r of sorted) {
      const q = Number(r[qtyKey] ?? 0);
      if (q === 0) out++;
      else if (q < 200) low++;
      const flag = q === 0 ? "  ❌ OUT" : q < 200 ? "  ⚠ low" : "";
      const inb = Number(r.inbound ?? 0), res = Number(r.reserved ?? 0);
      const synced = r.source_synced_at ? String(r.source_synced_at).slice(0, 10) : "";
      console.log(`  ${String(r[skuKey]).slice(0, 30).padEnd(32)} onHand ${String(q).padStart(6)}  inbound ${String(inb).padStart(6)}  reserved ${String(res).padStart(5)}  ${synced}${flag}`);
    }
    console.log(`  → ${out} OUT, ${low} low (<200), ${sorted.length - out - low} healthy`);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
