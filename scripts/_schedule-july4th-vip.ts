/**
 * One-off: create + schedule the 6 July 4th VIP (JULY4THVIP) single-segment
 * SMS campaigns. Replicates the API create (POST /sms-campaigns) + schedule
 * action (fire marketing/text-campaign.scheduled + status='scheduled').
 * coupon_enabled=false — the code is parsed from the /discount/ shortlink target.
 */
import { createAdminClient } from "./_bootstrap";
import { inngest } from "../src/lib/inngest/client";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TARGET = "https://superfoodscompany.com/discount/JULY4THVIP?redirect=/collections/july4thearlyaccess";
const SIGNOFF = "Shed lbs, feel great for summer! Only 39 left!";
const CTA = "Up to 60% off - grab your coupon:";

function body(hook: string): string {
  return `${hook}\n\n${CTA}\n{shortlink}\n\n${SIGNOFF}`;
}

const CAMPAIGNS: Array<{ seg: string; hook: string; excl: string[] }> = [
  { seg: "cycle_hitter", hook: "Happy 4th, time to restock!",        excl: ["active_sub"] },
  { seg: "lapsed",       hook: "Happy 4th - come back and save!",    excl: ["active_sub"] },
  { seg: "engaged",      hook: "Happy 4th! You're in early access.", excl: ["active_sub"] },
  { seg: "deep_lapsed",  hook: "Happy 4th, we miss you!",            excl: ["active_sub"] },
  { seg: "single_order", hook: "Happy 4th! Ready for order #2?",     excl: ["active_sub"] },
  { seg: "active_sub",   hook: "Happy 4th, thanks for subscribing!", excl: [] },
];

async function main() {
  const admin = createAdminClient();

  for (const c of CAMPAIGNS) {
    const message_body = body(c.hook);
    // GSM-7 guard
    const nonGsm = message_body.match(/[^\x00-\x7F]/g);
    if (nonGsm) throw new Error(`non-GSM-7 char in ${c.seg}: ${nonGsm.join("")}`);

    const { data: row, error } = await admin.from("sms_campaigns").insert({
      workspace_id: WS,
      name: `July 4th VIP — ${c.seg}`,
      message_body,
      media_url: null,
      send_date: "2026-07-04",
      target_local_hour: 9,
      fallback_target_local_hour: 10,
      fallback_timezone: "America/Chicago",
      audience_filter: {},
      included_segments: [c.seg],
      excluded_segments: c.excl,
      coupon_enabled: false,
      coupon_expires_days_after_send: 21,
      shortlink_target_url: TARGET,
      created_by: null,
    }).select("id, name").single();
    if (error || !row) throw new Error(`insert failed for ${c.seg}: ${error?.message}`);

    // schedule (mirror API POST action:"schedule")
    await inngest.send({ name: "marketing/text-campaign.scheduled", data: { campaign_id: row.id } });
    await admin.from("sms_campaigns")
      .update({ status: "scheduled", scheduled_at: new Date().toISOString() })
      .eq("id", row.id);

    console.log(`✓ scheduled ${row.name}  id=${row.id}  incl=[${c.seg}] excl=[${c.excl.join(",")}]  body=${message_body.length}ch`);
  }
  console.log("\nAll 6 fired. Audience resolves + recipients stage via the marketing-text Inngest fn; send-tick delivers at 9am local.");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
