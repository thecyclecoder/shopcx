/**
 * One-off: send ONE real test SMS of the VIP Weekend Day-1 body to a single
 * number, using a REAL reserved shortlink + a REAL customers.short_code so the
 * test exercises the exact production URL shape:
 *
 *     https://superfd.co/{6-char slug}/{5-char short_code}
 *
 * That means the test also proves the click path end-to-end: /api/sl/[slug]
 * resolves the trailing customer code, logs the click, and 302s to the
 * VIPONLY discount URL which applies the code at the store.
 *
 * Sends to ONE number. Does not touch sms_campaigns and does not schedule
 * anything. The shortlink row it creates has campaign_id = null.
 */
import "./_bootstrap";
import { createAdminClient } from "./_bootstrap";
import { generateShortlinkSlug } from "../src/lib/shortlink-slug";
import { sendSMS } from "../src/lib/twilio";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TO = process.argv[2] || "+18583349198";
const SHORT_CODE = process.argv[3] || "Q40E0"; // Dylan's customers.short_code

const TARGET = "https://superfoodscompany.com/discount/VIPONLY?redirect=/collections/special-vip-sale";

// The Day-1 body, verbatim founder template (the LONGEST of the eight —
// 139 stored / 157 rendered — so the test shows the worst case).
const HOOK = "OMG! You must be lucky b/c you just got picked for our VIP Weekend Sale";
const URGENCY = "Only 38 left!";
const SIGNOFF = "Shed lbs, feel great!";

async function main() {
  const admin = createAdminClient();

  // Reserve a real slug, same generator + table the scheduler uses.
  let slug = "";
  for (let i = 0; i < 3; i++) {
    const candidate = generateShortlinkSlug(6);
    const { error } = await admin.from("marketing_shortlinks").insert({
      workspace_id: WS,
      slug: candidate,
      target_url: TARGET,
      campaign_id: null, // standalone test link, not a campaign
      is_active: true,
    });
    if (!error) {
      slug = candidate;
      break;
    }
    if (!String(error.message).includes("duplicate")) throw error;
  }
  if (!slug) throw new Error("slug collision x3");

  const { data: wsRow } = await admin.from("workspaces").select("shortlink_domain").eq("id", WS).single();
  const personalLink = `https://${wsRow!.shortlink_domain}/${slug}/${SHORT_CODE}`;

  const body = `${HOOK}\n\nTap for Coupon: ${personalLink}\n${URGENCY}\n\n${SIGNOFF}`;

  console.log(`slug        : ${slug}`);
  console.log(`target      : ${TARGET}`);
  console.log(`personal    : ${personalLink}  (${personalLink.length} chars)`);
  console.log(`to          : ${TO}`);
  console.log(`body length : ${body.length} chars`);
  console.log(`---\n${body}\n---`);

  const res = await sendSMS(WS, TO, body);
  console.log(res.success ? `SENT sid=${res.messageSid}` : `FAILED ${res.error} (${res.errorCode})`);
  if (!res.success) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
