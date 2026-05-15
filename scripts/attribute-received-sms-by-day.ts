/**
 * Attribute Received SMS events to campaigns by re-pulling on send-day
 * windows and extracting event_properties.$message.
 *
 * Klaviyo's event_properties.$message contains the canonical
 * klaviyo_campaign_id for campaign-typed sends. We extract it and store
 * on klaviyo_profile_events.attributed_klaviyo_campaign_id so
 * downstream segmentation analyses can do per-campaign case-control.
 *
 * Flow-typed events (welcome flows, drip campaigns) get null
 * attribution — they aren't part of any campaign in
 * klaviyo_sms_campaign_history.
 *
 * Usage:
 *   npx tsx scripts/attribute-received-sms-by-day.ts                    # all 17 campaigns
 *   npx tsx scripts/attribute-received-sms-by-day.ts --campaign 01KPJZ5Q3QP3Q7R7VM2275XTB5
 *   npx tsx scripts/attribute-received-sms-by-day.ts --since 2026-02-15
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
import { decrypt } from "@/lib/crypto";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const METRIC_ID = "Vu4Mrq";
const KLAVIYO_REVISION = "2025-01-15";
const PAGE_SIZE = 200;
const UPSERT_CHUNK = 500;

function parseArgs() {
  const out = { campaign: null as string | null, since: "2026-02-15" };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--campaign") out.campaign = a[++i];
    else if (a[i] === "--since") out.since = a[++i];
  }
  return out;
}

let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  console.log("\n\nSIGINT — finishing current page then exiting.");
});

async function main() {
  const args = parseArgs();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // Get the Klaviyo API key
  const { data: ws } = await supabase.from("workspaces").select("klaviyo_api_key_encrypted").eq("id", WS).single();
  const apiKey = decrypt(ws!.klaviyo_api_key_encrypted);
  const headers = {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: KLAVIYO_REVISION,
    Accept: "application/json",
  };

  // Pull the campaigns we care about
  let campaignQ = supabase.from("klaviyo_sms_campaign_history")
    .select("klaviyo_campaign_id, name, send_time")
    .eq("workspace_id", WS).eq("channel", "sms");
  if (args.campaign) campaignQ = campaignQ.eq("klaviyo_campaign_id", args.campaign);
  else campaignQ = campaignQ.gte("send_time", args.since);
  const { data: campaigns } = await campaignQ.order("send_time");
  if (!campaigns?.length) { console.log("No matching campaigns"); return; }

  console.log(`Processing ${campaigns.length} campaign(s)...\n`);

  let totalAttributed = 0;
  let totalSkippedFlow = 0;
  let totalSkippedOther = 0;

  for (const c of campaigns) {
    if (interrupted) break;
    const sendDay = (c.send_time as string).slice(0, 10);
    const dayStart = `${sendDay}T00:00:00Z`;
    const dayEnd = new Date(new Date(`${sendDay}T00:00:00Z`).getTime() + 86_400_000).toISOString();

    console.log(`[${sendDay}] ${c.name}`);
    console.log(`  campaign_id: ${c.klaviyo_campaign_id}`);

    // Idempotency: if this campaign already has any attributed rows, skip
    const { count: existing } = await supabase
      .from("klaviyo_profile_events")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", WS)
      .eq("attributed_klaviyo_campaign_id", c.klaviyo_campaign_id);
    if ((existing || 0) > 0) {
      console.log(`  skipping — already attributed (${existing} rows in DB)\n`);
      continue;
    }

    console.log(`  window: ${dayStart} → ${dayEnd}`);

    const filter = `and(equals(metric_id,"${METRIC_ID}"),greater-than(datetime,${dayStart}),less-than(datetime,${dayEnd}))`;
    let url: string | null = `https://a.klaviyo.com/api/events?filter=${encodeURIComponent(filter)}&sort=datetime&page[size]=${PAGE_SIZE}`;

    let pages = 0;
    let dayMatched = 0;
    let dayFlow = 0;
    let dayOther = 0;
    const t0 = Date.now();
    const updates: Array<{ klaviyo_event_id: string }> = [];

    while (url && !interrupted) {
      pages++;
      const r = await fetch(url, { headers });
      if (r.status === 429) { console.log(`    page ${pages}: 429, sleeping 5s`); await new Promise(res => setTimeout(res, 5000)); continue; }
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        console.log(`    page ${pages} ${r.status}: ${text.slice(0, 200)}`);
        break;
      }
      const body = (await r.json()) as {
        data: Array<{ id: string; attributes?: { event_properties?: Record<string, unknown> } }>;
        links?: { next?: string };
      };

      for (const e of body.data || []) {
        const props = e.attributes?.event_properties || {};
        const msgType = props["Message Type"];
        const msgRef = props["$message"];
        if (msgType === "flow") { dayFlow++; continue; }
        if (msgType !== "campaign") { dayOther++; continue; }
        if (msgRef === c.klaviyo_campaign_id) {
          updates.push({ klaviyo_event_id: e.id });
          dayMatched++;
        } else {
          // A different campaign's event in this day window — skip
          dayOther++;
        }
      }

      // Batch update with .in() — single query per chunk
      while (updates.length >= UPSERT_CHUNK) {
        const chunk = updates.splice(0, UPSERT_CHUNK);
        const ids = chunk.map(u => u.klaviyo_event_id);
        const { error } = await supabase
          .from("klaviyo_profile_events")
          .update({ attributed_klaviyo_campaign_id: c.klaviyo_campaign_id })
          .eq("workspace_id", WS)
          .in("klaviyo_event_id", ids);
        if (error) throw new Error(`batch update: ${error.message}`);
      }

      url = body.links?.next || null;
    }

    // Flush any remaining
    while (updates.length > 0) {
      const chunk = updates.splice(0, UPSERT_CHUNK);
      const ids = chunk.map(u => u.klaviyo_event_id);
      const { error } = await supabase
        .from("klaviyo_profile_events")
        .update({ attributed_klaviyo_campaign_id: c.klaviyo_campaign_id })
        .eq("workspace_id", WS)
        .in("klaviyo_event_id", ids);
      if (error) throw new Error(`final flush: ${error.message}`);
    }

    const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
    console.log(`  matched=${dayMatched} flow=${dayFlow} other=${dayOther} pages=${pages} time=${elapsedMin}min\n`);
    totalAttributed += dayMatched;
    totalSkippedFlow += dayFlow;
    totalSkippedOther += dayOther;
  }

  console.log(`\n=== DONE ===`);
  console.log(`Attributed: ${totalAttributed}`);
  console.log(`Skipped (flow): ${totalSkippedFlow}`);
  console.log(`Skipped (other campaigns / unknown): ${totalSkippedOther}`);
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
