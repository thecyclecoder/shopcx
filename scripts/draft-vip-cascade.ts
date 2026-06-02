/**
 * One-shot: create 4 draft SMS campaigns for the VIP Sale cascade.
 * Admin reviews each in the UI then clicks Schedule.
 *
 * Usage: npx tsx scripts/draft-vip-cascade.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

import { createClient } from "@supabase/supabase-js";

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SEND_DATE = new Date().toISOString().slice(0, 10); // today
const TARGET_HOUR = 9;
const FALLBACK_HOUR = 10;
const DEST = "https://superfoodscompany.com/discount/VIP-226?redirect=/collections/special-vip-sale";

interface Draft {
  name: string;
  message_body: string;
  included_segments: string[];
  excluded_segments: string[];
}

const drafts: Draft[] = [
  {
    name: "VIP Sale — engaged",
    message_body: "VIP Sale just opened: up to 60% off your faves. 1 day only. Shop: {shortlink}",
    included_segments: ["engaged"],
    excluded_segments: ["active_sub"],
  },
  {
    name: "VIP Sale — cycle_hitter",
    message_body: "It's reorder time! VIP Sale just opened - up to 60% off, 1 day only: {shortlink}",
    included_segments: ["cycle_hitter"],
    excluded_segments: ["engaged", "active_sub"],
  },
  {
    name: "VIP Sale — just_ordered",
    message_body: "VIP Sale just opened: up to 60% off your faves, 1 day only. Stock up: {shortlink}",
    included_segments: ["just_ordered"],
    excluded_segments: ["engaged", "cycle_hitter", "active_sub"],
  },
  {
    name: "VIP Sale — deep_lapsed",
    message_body: "It's been a minute. VIP Sale just opened: up to 60% off, today only: {shortlink}",
    included_segments: ["deep_lapsed"],
    excluded_segments: ["engaged", "cycle_hitter", "just_ordered", "active_sub"],
  },
];

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // Use any owner of this workspace as created_by — required for the
  // foreign key. Pick the first owner.
  const { data: owner } = await sb
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", W)
    .eq("role", "owner")
    .limit(1)
    .single();
  const createdBy = owner?.user_id;
  if (!createdBy) throw new Error("No workspace owner found");

  console.log(`Creating ${drafts.length} drafts for workspace ${W}, send_date=${SEND_DATE}`);

  for (const d of drafts) {
    // Validate message body length (single SMS segment)
    const len = d.message_body.length;
    if (len > 160) {
      console.warn(`  WARN: "${d.name}" body is ${len} chars — over 160. Skipping.`);
      continue;
    }
    const { data, error } = await sb.from("sms_campaigns").insert({
      workspace_id: W,
      name: d.name,
      message_body: d.message_body,
      media_url: null,
      send_date: SEND_DATE,
      target_local_hour: TARGET_HOUR,
      fallback_target_local_hour: FALLBACK_HOUR,
      fallback_timezone: "America/Chicago",
      audience_filter: {},
      included_segments: d.included_segments,
      excluded_segments: d.excluded_segments,
      coupon_enabled: false,
      coupon_discount_pct: null,
      coupon_expires_days_after_send: 21,
      shortlink_target_url: DEST,
      status: "draft",
      created_by: createdBy,
    }).select("id, name").single();
    if (error) {
      console.error(`  ✗ ${d.name}: ${error.message}`);
      continue;
    }
    console.log(`  ✓ ${data.id}  ${data.name}  (${len} chars body)`);
    console.log(`      include=[${d.included_segments.join(",")}]  exclude=[${d.excluded_segments.join(",")}]`);
    console.log(`      → /dashboard/marketing/text/${data.id}`);
  }

  console.log(`\nDone. Review each in /dashboard/marketing/text and click Schedule.`);
  console.log(`Send_date = ${SEND_DATE}. Local hour = 9 (in resolved tz), 10 (fallback).`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
