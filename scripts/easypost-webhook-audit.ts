/**
 * Audit EasyPost webhook configuration for both live and test API keys.
 *   1. List all webhooks registered on each API key
 *   2. Show their URL, mode, status (active/disabled)
 *   3. Compare to our stored easypost_webhook_secret (per workspace)
 *   4. Show what mode the labels we've been buying are in
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const { data: ws } = await admin
    .from("workspaces")
    .select("easypost_live_api_key_encrypted, easypost_test_api_key_encrypted, easypost_webhook_secret")
    .eq("id", W)
    .single();
  const { decrypt } = await import("../src/lib/crypto");

  const liveKey = ws?.easypost_live_api_key_encrypted ? decrypt(ws.easypost_live_api_key_encrypted) : null;
  const testKey = ws?.easypost_test_api_key_encrypted ? decrypt(ws.easypost_test_api_key_encrypted) : null;
  const storedSecret = ws?.easypost_webhook_secret ? decrypt(ws.easypost_webhook_secret) : null;

  console.log("Stored EasyPost config:");
  console.log(`  live API key:    ${liveKey ? "✓ (" + liveKey.slice(0, 12) + "…)" : "—"}`);
  console.log(`  test API key:    ${testKey ? "✓ (" + testKey.slice(0, 12) + "…)" : "—"}`);
  console.log(`  webhook secret:  ${storedSecret ? "✓ (" + storedSecret.length + " chars)" : "—"}`);

  for (const [mode, key] of [["LIVE", liveKey], ["TEST", testKey]]) {
    if (!key) { console.log(`\n${mode} key not set — skipping`); continue; }
    console.log(`\n──── ${mode} webhooks ────`);
    const auth = "Basic " + Buffer.from((key as string) + ":").toString("base64");
    const res = await fetch("https://api.easypost.com/v2/webhooks", { headers: { Authorization: auth } });
    if (!res.ok) {
      console.log(`  ✗ ${res.status}: ${(await res.text()).slice(0, 200)}`);
      continue;
    }
    const data = await res.json();
    const hooks = (data.webhooks || []) as { id: string; url: string; mode: string; disabled_at?: string; created_at: string; webhook_secret?: string | null }[];
    console.log(`  ${hooks.length} webhook(s) registered:`);
    for (const h of hooks) {
      console.log(`    ${h.id}  mode=${h.mode}  ${h.disabled_at ? "DISABLED at " + h.disabled_at : "active"}`);
      console.log(`      url:    ${h.url}`);
      console.log(`      created: ${h.created_at}`);
      console.log(`      secret set on EasyPost: ${h.webhook_secret ? "yes" : "no/unknown"}`);
    }
  }

  // Look at the actual shipments we created — what mode were they in?
  console.log(`\n──── Shipment mode audit ────`);
  console.log(`Checking each return's shipment for live vs test mode…\n`);
  const { data: returns } = await admin
    .from("returns")
    .select("order_number, easypost_shipment_id")
    .eq("workspace_id", W)
    .not("easypost_shipment_id", "is", null);
  if (!liveKey && !testKey) return;
  const probeKey = liveKey || testKey!;
  const auth = "Basic " + Buffer.from(probeKey + ":").toString("base64");
  for (const r of returns || []) {
    const res = await fetch(`https://api.easypost.com/v2/shipments/${r.easypost_shipment_id}`, { headers: { Authorization: auth } });
    if (!res.ok) {
      console.log(`  ${r.order_number}  ${r.easypost_shipment_id}  → ${res.status} (likely WRONG-MODE key)`);
      continue;
    }
    const ship = await res.json();
    console.log(`  ${r.order_number}  mode=${ship.mode}  tracker_id=${ship.tracker?.id || "—"}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
