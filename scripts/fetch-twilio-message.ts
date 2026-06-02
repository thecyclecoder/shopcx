/**
 * Fetch one specific Twilio message + verify the shortlink redirects
 * to the correct UTM-tagged destination.
 *
 * Usage: npx tsx scripts/fetch-twilio-message.ts [message_sid]
 *   defaults to the most recent scheduled message
 */
import { readFileSync } from "fs";
import { resolve } from "path";
const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";

const SID = process.env.TWILIO_ACCOUNT_SID!;
const TOKEN = process.env.TWILIO_AUTH_TOKEN!;
const AUTH = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64");
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });

  let messageSid = process.argv[2];
  if (!messageSid) {
    // Find one scheduled message from our recent submissions
    const { data } = await sb.from("sms_campaign_recipients")
      .select("message_sid, phone, scheduled_send_at, resolved_timezone")
      .not("message_sid", "is", null)
      .order("scheduled_at_twilio", { ascending: false })
      .limit(1);
    messageSid = data?.[0]?.message_sid;
    if (!messageSid) throw new Error("no scheduled message found");
    console.log(`Using most recent scheduled message: ${messageSid}`);
    console.log(`  to: ${data![0].phone}`);
    console.log(`  scheduled_send_at: ${data![0].scheduled_send_at}`);
    console.log(`  resolved_timezone: ${data![0].resolved_timezone}\n`);
  }

  // Pull from Twilio
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages/${messageSid}.json`, { headers: { Authorization: AUTH } });
  if (!r.ok) throw new Error(`Twilio ${r.status}: ${await r.text()}`);
  const m = await r.json() as Record<string, unknown>;

  console.log("=== Twilio message ===");
  console.log(`  sid:                  ${m.sid}`);
  console.log(`  status:               ${m.status}`);
  console.log(`  to:                   ${m.to}`);
  console.log(`  from:                 ${m.from || "(via MS)"}`);
  console.log(`  messaging_service:    ${m.messaging_service_sid}`);
  console.log(`  date_created:         ${m.date_created}`);
  console.log(`  date_sent:            ${m.date_sent || "(scheduled)"}`);
  console.log(`  num_segments:         ${m.num_segments}`);
  console.log(`  body:                 ${m.body}`);
  console.log(`  body length:          ${(m.body as string).length} chars`);

  // Extract shortlink from body
  const body = m.body as string;
  const shortMatch = body.match(/https?:\/\/superfd\.co\/[A-Z0-9]+/i);
  if (!shortMatch) {
    console.log("\n(No superfd.co shortlink found in body)");
    return;
  }
  const shortUrl = shortMatch[0];
  const slug = shortUrl.split("/").pop()!;
  console.log(`\n  shortlink:            ${shortUrl}`);

  // Look up the shortlink in our DB
  const { data: sl } = await sb.from("marketing_shortlinks")
    .select("slug, target_url, campaign_id, click_count")
    .eq("slug", slug)
    .single();
  if (!sl) {
    console.log("  (shortlink not in DB)");
    return;
  }
  console.log(`\n  shortlink target_url: ${sl.target_url}`);
  console.log(`  campaign_id:          ${sl.campaign_id}`);
  console.log(`  click_count so far:   ${sl.click_count}`);

  // Decode the redirect param to show the final landing URL after Shopify's discount redirect
  try {
    const u = new URL(sl.target_url);
    const redirect = u.searchParams.get("redirect");
    console.log(`\n  --- URL breakdown ---`);
    console.log(`  base path:    ${u.origin}${u.pathname}`);
    console.log(`  ?redirect=    ${redirect}`);
    if (redirect) {
      const dummy = new URL(redirect, "https://_dummy_/");
      console.log(`\n  After Shopify applies the discount, browser lands at:`);
      console.log(`    ${u.origin}${dummy.pathname}${dummy.search}`);
      console.log(`\n  UTM params on final landing:`);
      for (const [k, v] of dummy.searchParams.entries()) {
        if (k.startsWith("utm_")) console.log(`    ${k.padEnd(15)} ${v}`);
      }
    }
  } catch (e) {
    console.log(`  (URL parse error: ${(e as Error).message})`);
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
