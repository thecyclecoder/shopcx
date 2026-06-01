/**
 * One-click provisioner for Twilio Verify Service. Run once per
 * workspace. Idempotent — returns the existing SID if already
 * configured.
 *
 * Verify is Twilio's purpose-built OTP service: high-deliverability
 * pool, built-in rate limit / brute force protection / multi-channel
 * fallback. We use it for the storefront checkout login flow and
 * (later) for the portal login.
 */
import { readFileSync } from "fs"; import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

const WS = process.argv[2] || "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const { createVerifyService } = await import("../src/lib/twilio-verify");
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: ws } = await admin.from("workspaces").select("name, twilio_verify_service_sid").eq("id", WS).single();
  if (!ws) { console.log("Workspace not found"); return; }
  const friendlyName = `${ws.name || "ShopCX"} Checkout OTP`;
  console.log(`Provisioning Twilio Verify Service for ${ws.name}…`);
  const result = await createVerifyService(WS, friendlyName);
  if (!result.success) {
    console.error("✗ Failed:", result.error);
    process.exit(1);
  }
  console.log(`✓ Service SID: ${result.sid}`);
}
main().catch(e => { console.error(e); process.exit(1); });
