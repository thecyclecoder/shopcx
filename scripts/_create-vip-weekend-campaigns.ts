/**
 * VIP Weekend Sale — create the 16 single-segment SMS campaigns.
 *   Day 1: Sat 2026-07-25, 9am local ("Only 38 left!")
 *          9am has passed in ET/CT/MT, so those recipients stage with a PAST
 *          scheduled_send_at and the 1-min tick sends them immediately
 *          (useSendAt is false under 15 min). PT goes via Twilio SendAt.
 *   Day 2: Sun 2026-07-26, 9am local ("Last chance" / "Expires Midnight!")
 *
 * Coupon VIPONLY already exists in Shopify => coupon_enabled=false and the code
 * rides in the /discount/{CODE} shortlink target, which the scheduler parses
 * back into sms_campaigns.coupon_code for revenue attribution.
 *
 * Modes (default is read-only):
 *   (no flag)    preview real audience counts per campaign, write nothing
 *   --create     insert the 16 rows as status='draft'
 *   --schedule   fire marketing/text-campaign.scheduled for the drafts  <-- SENDS
 */
import "./_bootstrap";
import { createAdminClient } from "./_bootstrap";
import { Inngest } from "inngest";
import { renderedLength, isGsm7 } from "../src/lib/sms-marketing-agent";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TARGET = "https://superfoodscompany.com/discount/VIPONLY?redirect=/collections/special-vip-sale";
const TZ = "America/Chicago";
const HOUR = 9;
const MAX_RENDERED = 160;

const SEGMENTS = [
  "deep_lapsed",
  "single_order",
  "active_sub",
  "cycle_hitter",
  "lapsed",
  "engaged",
  "just_ordered",
  "storefront_signup",
] as const;

const DAY1_HOOKS: Record<string, string> = {
  deep_lapsed: "OMG! You must be lucky b/c you just got picked for our VIP Weekend Sale",
  single_order: "OMG! You got picked for our VIP Weekend Sale - ready for round 2?",
  active_sub: "OMG! Our VIP subscribers got picked first for VIP Weekend Sale!",
  cycle_hitter: "OMG! You got picked for our VIP Weekend Sale - time to restock!",
  lapsed: "OMG! You must be lucky b/c you just got picked for our VIP Weekend Sale",
  engaged: "OMG! You must be lucky - you just got picked for VIP Weekend Sale!",
  just_ordered: "OMG! You got picked for our VIP Weekend Sale - stock up early!",
  storefront_signup: "OMG! You must be lucky - you just got picked for VIP Weekend Sale!",
};

const DAY2_HOOKS: Record<string, string> = {
  deep_lapsed: "Last chance! The VIP Weekend Sale you got picked for ends tonight.",
  single_order: "Last chance! Your VIP Weekend Sale pick - final shot at round 2.",
  active_sub: "Last chance VIPs! The sale you got picked for ends tonight.",
  cycle_hitter: "Last chance! Your VIP Weekend Sale pick - restock before it ends.",
  lapsed: "Last chance! Your VIP Weekend Sale pick ends tonight - come back.",
  engaged: "Last chance! The VIP Weekend Sale you got picked for ends tonight.",
  just_ordered: "Last chance on the VIP Weekend Sale you got picked for!",
  storefront_signup: "Last chance to use the VIP Weekend invite you got picked for!",
};

const SIGNOFF = "Shed lbs, feel great!";

function compose(hook: string, urgency: string): string {
  return `${hook}\n\nTap for Coupon: {shortlink}\n${urgency}\n\n${SIGNOFF}`;
}

interface Spec {
  name: string;
  segment: string;
  day: 1 | 2;
  sendDate: string;
  body: string;
}

function buildSpecs(): Spec[] {
  const out: Spec[] = [];
  for (const segment of SEGMENTS) {
    out.push({
      name: `VIP Weekend Sale - Day 1 - ${segment}`,
      segment,
      day: 1,
      sendDate: "2026-07-25",
      body: compose(DAY1_HOOKS[segment], "Only 38 left!"),
    });
  }
  for (const segment of SEGMENTS) {
    out.push({
      name: `VIP Weekend Sale - Last Chance - ${segment}`,
      segment,
      day: 2,
      sendDate: "2026-07-26",
      body: compose(DAY2_HOOKS[segment], "Expires Midnight!"),
    });
  }
  return out;
}

/** Mirrors resolve-audience in marketing-text.ts exactly (keyset paginated). */
async function previewAudience(segment: string): Promise<number> {
  const admin = createAdminClient();
  const excluded = segment === "active_sub" ? [] : ["active_sub"];
  const excludeSet = new Set(excluded);
  let count = 0;
  let lastId: string | null = null;
  for (;;) {
    let q = admin
      .from("customers")
      .select("id, segments")
      .eq("workspace_id", WS)
      .not("phone", "is", null)
      .eq("sms_marketing_status", "subscribed")
      .or("phone_status.is.null,phone_status.eq.good")
      .overlaps("segments", [segment])
      .order("id", { ascending: true })
      .limit(1000);
    if (lastId) q = q.gt("id", lastId);
    const { data, error } = await q;
    if (error) throw new Error(`audience query: ${error.message}`);
    const page = data || [];
    for (const r of page) {
      const segs = (r.segments as string[] | null) || [];
      if (!segs.some((s) => excludeSet.has(s))) count++;
    }
    if (page.length < 1000) break;
    lastId = page[page.length - 1].id as string;
  }
  return count;
}

async function main() {
  const mode = process.argv.includes("--schedule")
    ? "schedule"
    : process.argv.includes("--create")
      ? "create"
      : "preview";
  const specs = buildSpecs();

  // ── validate every body before anything else ────────────────────────────
  let bad = 0;
  for (const s of specs) {
    const rl = renderedLength(s.body);
    const gsm = isGsm7(s.body);
    if (rl > MAX_RENDERED || !gsm) {
      console.log(`INVALID ${s.name}: rendered=${rl} gsm7=${gsm}`);
      bad++;
    }
  }
  if (bad) throw new Error(`${bad} invalid bodies — refusing to continue`);
  console.log(`all ${specs.length} bodies valid (GSM-7, rendered <= ${MAX_RENDERED})\n`);

  const admin = createAdminClient();

  if (mode === "preview") {
    console.log("=== AUDIENCE PREVIEW (live predicate, active_sub excluded except its own) ===");
    let total = 0;
    for (const segment of SEGMENTS) {
      const n = await previewAudience(segment);
      total += n * 2; // both days
      console.log(`  ${segment.padEnd(18)} ${String(n).padStart(6)} per day`);
    }
    console.log(`\n  TOTAL across both days: ${total.toLocaleString()} sends`);
    console.log(`\n(no writes — pass --create to insert the 16 drafts)`);
    return;
  }

  if (mode === "create") {
    for (const s of specs) {
      const { data: existing } = await admin
        .from("sms_campaigns")
        .select("id")
        .eq("workspace_id", WS)
        .eq("name", s.name)
        .maybeSingle();
      if (existing) {
        console.log(`  exists, skipping: ${s.name} (${existing.id})`);
        continue;
      }
      const { data, error } = await admin
        .from("sms_campaigns")
        .insert({
          workspace_id: WS,
          name: s.name,
          status: "draft",
          message_body: s.body,
          send_date: s.sendDate,
          target_local_hour: HOUR,
          target_local_minute: 0,
          fallback_target_local_hour: HOUR,
          fallback_target_local_minute: 0,
          fallback_timezone: TZ,
          audience_filter: {},
          included_segments: [s.segment],
          excluded_segments: s.segment === "active_sub" ? [] : ["active_sub"],
          coupon_enabled: false,
          shortlink_target_url: TARGET,
          created_by: null,
        })
        .select("id")
        .single();
      if (error) {
        console.log(`  FAILED ${s.name}: ${error.message}`);
        continue;
      }
      console.log(`  created ${data!.id}  ${s.name}  (rendered ${renderedLength(s.body)})`);
    }
    console.log(`\ndrafts created — pass --schedule to send`);
    return;
  }

  // ── schedule: this SENDS ──────────────────────────────────────────────
  const inngest = new Inngest({ id: "shopcx", eventKey: process.env.INNGEST_EVENT_KEY! });
  const { data: drafts } = await admin
    .from("sms_campaigns")
    .select("id, name, status, send_date")
    .eq("workspace_id", WS)
    .like("name", "VIP Weekend Sale -%")
    .eq("status", "draft");
  if (!drafts?.length) {
    console.log("no VIP Weekend drafts found — run --create first");
    return;
  }
  for (const d of drafts) {
    await inngest.send({ name: "marketing/text-campaign.scheduled", data: { campaign_id: d.id } });
    await admin
      .from("sms_campaigns")
      .update({ status: "scheduled", scheduled_at: new Date().toISOString() })
      .eq("id", d.id);
    console.log(`  SCHEDULED ${d.name} (${d.send_date})`);
  }
  console.log(`\n${drafts.length} campaigns scheduled.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
