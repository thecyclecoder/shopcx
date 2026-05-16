/**
 * Case-control segment analysis using recipient lists.
 *
 * For each of the 17 campaigns Feb 15 → Apr 19, computes:
 *   - Recipients: profiles with a `Received SMS` event attributed to
 *     the campaign (now resolved to customer_id via the staging
 *     backfill).
 *   - Converters: subset that also placed an order attributed to that
 *     campaign via UTM.
 *   - Per recipient: archetype + features at send time.
 *
 * Outputs:
 *   /tmp/casecontrol-recipients.csv  — per-(profile, campaign) row
 *   stdout summary                    — per-(archetype × campaign-type)
 *                                       conversion rates, missed
 *                                       opportunity sizing
 *
 * Methodology: case-control is bounded to actual SMS recipients —
 * there's no need to filter to "in-policy" non-recipients because the
 * audience already is the audience. The "missed opportunity" is the
 * delta between (a) high-converting archetype recipient counts and
 * (b) high-converting archetype population counts (current
 * SMS-subscribed customers in our DB).
 */

import { readFileSync, writeFileSync } from "fs";
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

import { createAdminClient } from "@/lib/supabase/admin";

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SINCE = "2026-02-15";

type CampaignType = "random" | "holiday" | "vip";
function classifyCampaign(name: string): CampaignType {
  const n = name.toLowerCase();
  if (/vday|valentine|president|st\s*patrick|easter|mother|father|memorial|labor|bfcm|black\s*friday|cyber|christmas|holiday/.test(n)) return "holiday";
  if (/vip|diamond|loyalty|insider|members/.test(n)) return "vip";
  return "random";
}

type Archetype = "cycle_hitter" | "lapsed" | "deep_lapsed" | "engaged" | "just_ordered" | "cold" | "single_order";
// Refined 2026-05-16 from per-signal lift analysis:
//   - lurker dropped: 0 converters / 50K recipients. Engagement among
//     zero-order profiles is noise (11 of 12 zero-order conversions
//     came from "no signals at all").
//   - clicked_sms_60d demoted: only 2.1× lift, and 11+ bucket converts
//     WORSE than baseline (coupon-hunters, habit-clickers).
//   - engaged hinge moved to higher-friction signals: clicked_email
//     (18.7× lift), ATC (25× lift), checkout (16× lift).
//   - deep_lapsed broken out from lapsed: r > 3.0 is its own bucket.
function assignArchetype(f: { pre_send_orders: number; replenishment_ratio: number | null; clicked_email_60d: number; added_to_cart_30d: number; checkout_started_30d: number; viewed_product_30d: number }): Archetype {
  if (f.pre_send_orders === 0) return "cold";
  if (f.pre_send_orders === 1) return "single_order";
  const r = f.replenishment_ratio;
  if (r !== null && r < 0.5) return "just_ordered";
  if (r !== null && r >= 0.5 && r <= 1.5) return "cycle_hitter";
  if (r !== null && r > 1.5 && r <= 3.0) return "lapsed";
  // r > 3.0 OR r null — deep-lapsed. Engagement signals upgrade the
  // highest-intent ones to "engaged".
  const hasIntent = f.clicked_email_60d >= 1 || f.added_to_cart_30d >= 1 || f.checkout_started_30d >= 1 || f.viewed_product_30d >= 2;
  return hasIntent ? "engaged" : "deep_lapsed";
}

async function main() {
  const admin = createAdminClient();

  // ── Load campaigns ──
  const { data: campaigns } = await admin.from("klaviyo_sms_campaign_history")
    .select("klaviyo_campaign_id, name, send_time")
    .eq("workspace_id", W).eq("channel", "sms").gte("send_time", SINCE).order("send_time");
  if (!campaigns?.length) { console.log("No campaigns"); return; }
  console.log(`Processing ${campaigns.length} campaigns since ${SINCE}\n`);

  // ── For each campaign: load recipients + converters, compute features ──
  const allRows: Array<Record<string, unknown>> = [];

  // Aggregates
  const aggByArchetype = new Map<string, { recipients: number; converters: number }>();
  const aggByArchetypeAndType = new Map<string, { recipients: number; converters: number }>();

  for (const c of campaigns) {
    const sendTimeMs = Date.parse(c.send_time as string);
    const campaignType = classifyCampaign(c.name as string);
    console.log(`\n=== ${(c.send_time as string).slice(0,10)} | ${c.name} (${campaignType}) ===`);

    // Recipients — distinct (klaviyo_profile_id, customer_id) pairs for Received SMS events
    // attributed to this campaign. Paginate.
    const recipientsMap = new Map<string, { profile_id: string; customer_id: string | null }>();
    let lastDt: string | null = null;
    while (true) {
      let q = admin.from("klaviyo_profile_events")
        .select("klaviyo_profile_id, customer_id, datetime")
        .eq("workspace_id", W)
        .eq("attributed_klaviyo_campaign_id", c.klaviyo_campaign_id)
        .order("datetime", { ascending: true })
        .limit(1000);
      if (lastDt) q = q.gt("datetime", lastDt);
      const { data } = await q;
      if (!data || data.length === 0) break;
      for (const r of data) {
        if (!recipientsMap.has(r.klaviyo_profile_id)) {
          recipientsMap.set(r.klaviyo_profile_id, { profile_id: r.klaviyo_profile_id, customer_id: r.customer_id });
        }
      }
      lastDt = data[data.length - 1].datetime;
      if (data.length < 1000) break;
    }
    const recipients = [...recipientsMap.values()];
    const recipientsWithCustomer = recipients.filter(r => r.customer_id);
    console.log(`  recipients: ${recipients.length} (${recipientsWithCustomer.length} with customer_id)`);

    // Converters — Placed Order events for this campaign.
    // NOTE: klaviyo_events uses klaviyo_metric_id (e.g. "VCkHuL"),
    // not metric_name. Only klaviyo_profile_events has metric_name.
    const PLACED_ORDER_METRIC = "VCkHuL";
    const converterCustomerIds = new Set<string>();
    const { data: orders } = await admin.from("klaviyo_events")
      .select("order_number, klaviyo_profile_id")
      .eq("workspace_id", W).eq("klaviyo_metric_id", PLACED_ORDER_METRIC)
      .eq("attributed_klaviyo_campaign_id", c.klaviyo_campaign_id);
    const converterProfileIds = new Set((orders || []).map(o => o.klaviyo_profile_id));
    const orderNumbers = [...new Set((orders || []).map(o => o.order_number).filter(Boolean))];
    if (orderNumbers.length > 0) {
      for (let i = 0; i < orderNumbers.length; i += 500) {
        const batch = orderNumbers.slice(i, i + 500);
        const { data } = await admin.from("orders").select("customer_id").eq("workspace_id", W).in("order_number", batch);
        for (const o of data || []) if (o.customer_id) converterCustomerIds.add(o.customer_id);
      }
    }
    console.log(`  converters: ${converterProfileIds.size} (resolved customer_ids: ${converterCustomerIds.size})`);

    // ── Bulk-load orders for all recipient customer_ids (for feature build) ──
    const customerIdList = [...new Set(recipientsWithCustomer.map(r => r.customer_id!))];
    const ordersByCustomer = new Map<string, Array<{ created_at: string; total_cents: number | null }>>();
    for (let i = 0; i < customerIdList.length; i += 100) {
      const batch = customerIdList.slice(i, i + 100);
      const { data } = await admin.from("orders")
        .select("customer_id, created_at, total_cents")
        .in("customer_id", batch)
        .lt("created_at", c.send_time as string);
      for (const o of data || []) {
        if (!ordersByCustomer.has(o.customer_id)) ordersByCustomer.set(o.customer_id, []);
        ordersByCustomer.get(o.customer_id)!.push({ created_at: o.created_at, total_cents: o.total_cents });
      }
    }

    // Subscriptions
    const subsByCustomer = new Map<string, "active" | "paused" | "cancelled" | null>();
    for (let i = 0; i < customerIdList.length; i += 100) {
      const batch = customerIdList.slice(i, i + 100);
      const { data } = await admin.from("subscriptions")
        .select("customer_id, status, created_at")
        .in("customer_id", batch)
        .lte("created_at", c.send_time as string);
      for (const s of data || []) {
        const cur = subsByCustomer.get(s.customer_id);
        if (s.status === "active" || (cur === null && s.status === "paused")) subsByCustomer.set(s.customer_id, s.status);
      }
    }

    // Engagement events per profile in time windows
    const profileIdList = recipients.map(r => r.profile_id);
    const eng = new Map<string, { clicked_sms_60d: number; opened_email_60d: number; clicked_email_60d: number; viewed_product_30d: number; added_to_cart_30d: number; checkout_started_30d: number; active_on_site_90d: number }>();
    const since60 = new Date(sendTimeMs - 60 * 86_400_000).toISOString();
    const since30 = new Date(sendTimeMs - 30 * 86_400_000).toISOString();
    const since90 = new Date(sendTimeMs - 90 * 86_400_000).toISOString();
    for (let i = 0; i < profileIdList.length; i += 100) {
      const batch = profileIdList.slice(i, i + 100);
      const { data } = await admin.from("klaviyo_profile_events")
        .select("klaviyo_profile_id, metric_name, datetime")
        .eq("workspace_id", W)
        .in("klaviyo_profile_id", batch)
        .gte("datetime", since90)
        .lt("datetime", c.send_time as string);
      for (const e of data || []) {
        if (!eng.has(e.klaviyo_profile_id)) eng.set(e.klaviyo_profile_id, {
          clicked_sms_60d: 0, opened_email_60d: 0, clicked_email_60d: 0,
          viewed_product_30d: 0, added_to_cart_30d: 0, checkout_started_30d: 0,
          active_on_site_90d: 0,
        });
        const f = eng.get(e.klaviyo_profile_id)!;
        const t = Date.parse(e.datetime);
        if (e.metric_name === "Clicked SMS" && t >= Date.parse(since60)) f.clicked_sms_60d++;
        else if (e.metric_name === "Opened Email" && t >= Date.parse(since60)) f.opened_email_60d++;
        else if (e.metric_name === "Clicked Email" && t >= Date.parse(since60)) f.clicked_email_60d++;
        else if (e.metric_name === "Viewed Product" && t >= Date.parse(since30)) f.viewed_product_30d++;
        else if (e.metric_name === "Added to Cart" && t >= Date.parse(since30)) f.added_to_cart_30d++;
        else if (e.metric_name === "Checkout Started" && t >= Date.parse(since30)) f.checkout_started_30d++;
        else if (e.metric_name === "Active on Site") f.active_on_site_90d++;
      }
    }

    // ── Build per-recipient row ──
    for (const r of recipients) {
      const customerOrders = (r.customer_id && ordersByCustomer.get(r.customer_id)) || [];
      const preSendOrders = customerOrders.length;
      const preSendLtv = customerOrders.reduce((s, o) => s + (o.total_cents || 0), 0);
      const sorted = [...customerOrders].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      let days_since_last: number | null = null;
      let mean_gap: number | null = null;
      let ratio: number | null = null;
      if (sorted.length > 0) {
        days_since_last = (sendTimeMs - Date.parse(sorted[sorted.length - 1].created_at)) / 86_400_000;
        if (sorted.length > 1) {
          const gaps: number[] = [];
          for (let i = 1; i < sorted.length; i++) {
            gaps.push((Date.parse(sorted[i].created_at) - Date.parse(sorted[i - 1].created_at)) / 86_400_000);
          }
          mean_gap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
          ratio = mean_gap > 0 ? days_since_last / mean_gap : null;
        }
      }
      const e = eng.get(r.profile_id) || { clicked_sms_60d: 0, opened_email_60d: 0, clicked_email_60d: 0, viewed_product_30d: 0, added_to_cart_30d: 0, checkout_started_30d: 0, active_on_site_90d: 0 };
      const archetype = assignArchetype({ pre_send_orders: preSendOrders, replenishment_ratio: ratio, clicked_email_60d: e.clicked_email_60d, added_to_cart_30d: e.added_to_cart_30d, checkout_started_30d: e.checkout_started_30d, viewed_product_30d: e.viewed_product_30d });
      const converted = converterProfileIds.has(r.profile_id) || (r.customer_id && converterCustomerIds.has(r.customer_id)) ? 1 : 0;

      allRows.push({
        campaign_id: c.klaviyo_campaign_id,
        campaign_name: c.name,
        campaign_type: campaignType,
        send_time: c.send_time,
        profile_id: r.profile_id,
        customer_id: r.customer_id || "",
        archetype,
        converted,
        pre_send_orders: preSendOrders,
        pre_send_ltv_cents: preSendLtv,
        replenishment_ratio: ratio?.toFixed(3) ?? "",
        active_sub_at_send: subsByCustomer.get(r.customer_id || "") === "active" ? 1 : 0,
        ...e,
      });

      // Aggregates
      const aKey = archetype;
      if (!aggByArchetype.has(aKey)) aggByArchetype.set(aKey, { recipients: 0, converters: 0 });
      aggByArchetype.get(aKey)!.recipients++;
      if (converted) aggByArchetype.get(aKey)!.converters++;

      const aTKey = `${archetype}|${campaignType}`;
      if (!aggByArchetypeAndType.has(aTKey)) aggByArchetypeAndType.set(aTKey, { recipients: 0, converters: 0 });
      aggByArchetypeAndType.get(aTKey)!.recipients++;
      if (converted) aggByArchetypeAndType.get(aTKey)!.converters++;
    }

    console.log(`  built ${recipients.length} recipient rows`);
  }

  // ── Write CSV ──
  const header = Object.keys(allRows[0] || {});
  const csv = [
    header.join(","),
    ...allRows.map(r => header.map(k => {
      const v = r[k]; if (v === null || v === undefined) return "";
      const s = String(v);
      return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")),
  ].join("\n");
  writeFileSync("/tmp/casecontrol-recipients.csv", csv);
  console.log(`\n✓ Wrote /tmp/casecontrol-recipients.csv (${allRows.length} rows)`);

  // ── Summary ──
  console.log("\n═══ ARCHETYPE CONVERSION RATES (across all 17 campaigns) ═══");
  console.log("Archetype     | Recipients |  Converted |  Conv % ");
  console.log("--------------|------------|------------|---------");
  for (const [a, v] of [...aggByArchetype.entries()].sort((x, y) => (y[1].converters/y[1].recipients) - (x[1].converters/x[1].recipients))) {
    const rate = v.recipients > 0 ? (v.converters / v.recipients * 100).toFixed(2) : "—";
    console.log(`${a.padEnd(13)} | ${String(v.recipients).padStart(10)} | ${String(v.converters).padStart(10)} | ${String(rate + "%").padStart(7)}`);
  }

  console.log("\n═══ ARCHETYPE × CAMPAIGN TYPE ═══");
  const types = ["random", "holiday", "vip"];
  const archetypes = [...new Set([...aggByArchetypeAndType.keys()].map(k => k.split("|")[0]))];
  console.log("Archetype        " + types.map(t => `${t} (recv / conv / %)`.padStart(30)).join("  "));
  for (const a of archetypes) {
    const cells = types.map(t => {
      const v = aggByArchetypeAndType.get(`${a}|${t}`);
      if (!v) return "—".padStart(30);
      const rate = v.recipients > 0 ? (v.converters / v.recipients * 100).toFixed(2) : "—";
      return `${v.recipients} / ${v.converters} / ${rate}%`.padStart(30);
    });
    console.log(`${a.padEnd(15)}  ${cells.join("  ")}`);
  }

  console.log("\n═══ TOP-LINE ═══");
  const totalRec = [...aggByArchetype.values()].reduce((s, v) => s + v.recipients, 0);
  const totalConv = [...aggByArchetype.values()].reduce((s, v) => s + v.converters, 0);
  console.log(`Total recipients across 17 campaigns: ${totalRec}`);
  console.log(`Total converters: ${totalConv}`);
  console.log(`Overall conversion: ${(totalConv / totalRec * 100).toFixed(3)}%`);
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
