/**
 * Two inputs the trim decision needs:
 *   1. Website-side (3PL/Amplifier) stock for the products we're advertising — the website is
 *      what responds at lag 0, so its stock gates the immediate return on any spend.
 *   2. Meta account-level spend caps — the clean structural lever against a budget ratchet.
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken } from "../src/lib/meta-ads";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();

  // ── 1. website / 3PL stock ────────────────────────────────────────────────
  const { data: inv, error } = await admin.from("inventory_levels")
    .select("sku,location,on_hand,inbound,source_synced_at").eq("workspace_id", WS);
  if (error) {
    console.log(`inventory_levels: ${error.message}`);
  } else {
    const rows = (inv ?? []).filter((r) => true);
    const byLoc: Record<string, number> = {};
    for (const r of rows) byLoc[String(r.location)] = (byLoc[String(r.location)] ?? 0) + Number(r.on_hand ?? 0);
    console.log("=== WEBSITE / 3PL STOCK by location ===");
    for (const [k, v] of Object.entries(byLoc).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${v} units`);

    const interesting = /TAB|ASHW|ZEN|GURU|CREAM|COFFEE|POD|CREAT/i;
    console.log("\n  advertised lines (non-amazon locations):");
    for (const r of rows
      .filter((r) => interesting.test(String(r.sku)) && !/amazon/i.test(String(r.location)))
      .sort((a, b) => Number(b.on_hand) - Number(a.on_hand))
      .slice(0, 30)) {
      console.log(`    ${String(r.sku).slice(0, 30).padEnd(30)} ${String(r.location).padEnd(14)} ${String(r.on_hand).padStart(7)}`);
    }
  }

  // ── 2. Meta account spend caps ────────────────────────────────────────────
  const token = await getMetaUserToken(WS);
  if (!token) { console.log("\nno Meta token"); return; }
  const { data: accts } = await admin.from("meta_ad_accounts")
    .select("meta_account_id,meta_account_name").eq("workspace_id", WS);

  console.log("\n=== META ACCOUNT SPEND CAPS ===");
  for (const a of accts ?? []) {
    const id = String(a.meta_account_id);
    const url = `https://graph.facebook.com/v21.0/act_${id}?fields=name,spend_cap,amount_spent,balance,account_status&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    const j = (await res.json()) as Record<string, unknown>;
    if (j.error) { console.log(`  ${a.meta_account_name}: ${JSON.stringify(j.error)}`); continue; }
    const cap = Number(j.spend_cap ?? 0);
    console.log(`  ${String(a.meta_account_name).padEnd(26)} spend_cap ${cap ? "$" + (cap / 100).toFixed(0) : "NONE ⚠"} · lifetime spent $${(Number(j.amount_spent ?? 0) / 100).toFixed(0)} · status ${j.account_status}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
