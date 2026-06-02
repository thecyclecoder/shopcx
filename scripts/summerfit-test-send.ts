/**
 * Send a test SUMMERFIT SMS to Dylan's phone (858-334-9198) BEFORE
 * scheduling the real campaign. Uses the same MessagingServiceSid +
 * shortlink resolution path the production send uses, but builds a
 * one-off shortlink for Dylan's customer code so the URL renders
 * exactly like the production message will.
 */
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
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TEST_PHONE = "+18583349198";
const COUPON_CODE = "SUMMERFIT";
const TARGET_URL = "https://superfoodscompany.com/discount/SUMMERFIT?redirect=/collections/summer-ready";
const MESSAGE_TEMPLATE = "Get summer-ready with our natural superfoods - 1 day only sale.\n\nGet Coupon: {shortlink}\n\nOnly 43 coupons left!";

async function main() {
  const { data: ws } = await admin
    .from("workspaces")
    .select("twilio_marketing_messaging_service_sid, shortlink_domain")
    .eq("id", WORKSPACE_ID)
    .single();
  if (!ws?.twilio_marketing_messaging_service_sid) throw new Error("no MessagingServiceSid");
  if (!ws?.shortlink_domain) throw new Error("no shortlink_domain");

  // Reuse the test slug or create one
  const TEST_SLUG = "SFTEST";  // 6-char Crockford base32 — manual for test
  const { data: existing } = await admin
    .from("marketing_shortlinks")
    .select("id, slug")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("slug", TEST_SLUG)
    .maybeSingle();
  if (!existing) {
    await admin.from("marketing_shortlinks").insert({
      workspace_id: WORKSPACE_ID,
      slug: TEST_SLUG,
      target_url: TARGET_URL,
      is_active: true,
    });
    console.log("Created test shortlink:", TEST_SLUG);
  } else {
    // Refresh target_url in case it changed
    await admin.from("marketing_shortlinks").update({ target_url: TARGET_URL, is_active: true }).eq("slug", TEST_SLUG).eq("workspace_id", WORKSPACE_ID);
    console.log("Reusing test shortlink:", TEST_SLUG);
  }

  // Find Dylan's customer short_code so the URL has the same /SLUG/CUSTCODE structure as production
  const { data: dylanCust } = await admin
    .from("customers")
    .select("short_code, email")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("phone", TEST_PHONE)
    .maybeSingle();
  const custCode = dylanCust?.short_code || "TEST";
  console.log("Dylan customer:", dylanCust?.email, "short_code:", custCode);

  const shortlinkUrl = `https://${ws.shortlink_domain}/${TEST_SLUG}/${custCode}`;
  const body = MESSAGE_TEMPLATE.replace("{coupon}", COUPON_CODE).replace("{shortlink}", shortlinkUrl);

  console.log("\nTest message:");
  console.log("  ", body);
  console.log(`  Length: ${body.length} (limit 160 for 1 segment)`);

  const { sendSMS } = await import("@/lib/twilio");
  const result = await sendSMS(WORKSPACE_ID, TEST_PHONE, body, {
    messagingServiceSid: ws.twilio_marketing_messaging_service_sid,
  });
  console.log("\nTwilio result:", result);
}

main().catch((e) => { console.error(e); process.exit(1); });
