/**
 * One-shot CLI: discover Amazon resellers and populate
 * known_resellers. Run: npx tsx scripts/discover-resellers.ts
 *
 * After it finishes, review entries in the dashboard and flip
 * unverified → active for the ones that should be in fraud scope.
 */
import { readFileSync } from "fs";

const envPath = "/Users/admin/Projects/shopcx/.env.local";
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { discoverResellers } = await import("../src/lib/known-resellers");
  const admin = createAdminClient();

  const { data: workspaces } = await admin
    .from("workspaces")
    .select("id, name")
    .not("shopify_access_token_encrypted", "is", null);

  for (const ws of workspaces || []) {
    console.log(`\n══ ${ws.name} (${ws.id}) ══`);
    const { data: conn } = await admin
      .from("amazon_connections")
      .select("id")
      .eq("workspace_id", ws.id)
      .eq("is_active", true)
      .maybeSingle();
    if (!conn) {
      console.log(`  skip: no Amazon connection`);
      continue;
    }
    const result = await discoverResellers(ws.id);
    console.log(`  ASINs scanned:      ${result.asinsScanned}`);
    console.log(`  New resellers:      ${result.sellersDiscovered}`);
    console.log(`  Existing updated:   ${result.sellersUpdated}`);
  }

  console.log("\nDone. Review unverified resellers in /dashboard/settings/fraud-detection/resellers");
}
main().catch(e => { console.error(e); process.exit(1); });
