/**
 * Predicted-purchase converter analysis — 3 month window.
 *
 * Pulls every Placed Order event from klaviyo_events that's UTM-attributed
 * to an SMS campaign in our klaviyo_sms_campaign_history (sent since
 * 2026-02-15), maps it to our customer via the order_number, and computes
 * each converter's features AT THE TIME OF THE CAMPAIGN SEND:
 *
 *   Order features (from orders table):
 *     pre_send_orders                    — count of orders before send
 *     pre_send_ltv_cents                 — sum total_cents before send
 *     days_since_last_order              — send_time − MAX(prior order)
 *     mean_reorder_gap_days              — avg gap between prior orders
 *     replenishment_ratio                — days_since_last / mean_gap
 *     active_sub_at_send                 — was an active sub in place
 *
 *   Engagement features (from profile_events):
 *     clicked_sms_60d, opened_email_60d, clicked_email_60d
 *     viewed_product_30d, added_to_cart_30d, checkout_started_30d
 *     active_on_site_90d
 *
 * Archetype assigned per the framework in
 * `project_segment_archetypes`.
 *
 * Output:
 *   /tmp/segment-features-3mo.csv     — one row per (profile, campaign)
 *   stdout summary                    — archetype mix, top patterns,
 *                                       campaign-type comparison
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

type Archetype = "cycle_hitter" | "lapsed" | "engaged" | "just_ordered" | "lurker" | "cold" | "single_order";
function assignArchetype(f: ConverterFeatures): Archetype {
  if (f.pre_send_orders === 0) {
    // Lurkers: 0 orders but engagement signals
    if ((f.clicked_sms_60d || 0) >= 3 || (f.active_on_site_90d || 0) >= 5 || (f.added_to_cart_30d || 0) >= 1) return "lurker";
    return "cold";
  }
  if (f.pre_send_orders === 1) return "single_order";
  // Multi-order
  const r = f.replenishment_ratio;
  if (r !== null && r < 0.5) return "just_ordered";
  if (r !== null && r >= 0.5 && r <= 1.5) return "cycle_hitter";
  if (r !== null && r > 1.5 && r <= 3.0) return "lapsed";
  if ((f.clicked_sms_60d || 0) >= 5 || (f.added_to_cart_30d || 0) >= 2) return "engaged";
  return "lapsed"; // ratio > 3, deep lapsed
}

interface ConverterFeatures {
  profile_id: string;
  customer_id: string;
  campaign_id: string;
  campaign_name: string;
  campaign_type: CampaignType;
  send_time: string;
  order_number: string;
  order_value_cents: number;

  pre_send_orders: number;
  pre_send_ltv_cents: number;
  days_since_last_order: number | null;
  mean_reorder_gap_days: number | null;
  replenishment_ratio: number | null;
  active_sub_at_send: boolean;

  clicked_sms_60d: number;
  opened_email_60d: number;
  clicked_email_60d: number;
  viewed_product_30d: number;
  added_to_cart_30d: number;
  checkout_started_30d: number;
  active_on_site_90d: number;

  archetype: Archetype;
}

async function main() {
  const admin = createAdminClient();

  // ── 1) Load campaigns ──
  const { data: campaigns } = await admin.from("klaviyo_sms_campaign_history")
    .select("klaviyo_campaign_id, name, send_time")
    .eq("workspace_id", W).eq("channel", "sms").gte("send_time", SINCE);
  const campaignsById = new Map<string, { name: string; send_time: string; type: CampaignType }>();
  for (const c of campaigns || []) {
    campaignsById.set(c.klaviyo_campaign_id as string, {
      name: c.name as string,
      send_time: c.send_time as string,
      type: classifyCampaign(c.name as string),
    });
  }
  const campaignIds = [...campaignsById.keys()];
  console.log(`Loaded ${campaignIds.length} campaigns since ${SINCE}`);

  // ── 2) Pull all Placed Order events attributed to these campaigns ──
  // Page through — single query is fine since we expect 200-400 events.
  let allEvents: Array<{ klaviyo_profile_id: string; order_number: string; attributed_campaign_id: string; datetime: string; value: number }> = [];
  let page = 0;
  const PAGE_SIZE = 1000;
  while (true) {
    const { data, error } = await admin.from("klaviyo_events")
      .select("klaviyo_profile_id, order_number, attributed_campaign_id, datetime, value")
      .eq("workspace_id", W)
      .in("attributed_campaign_id", campaignIds)
      .not("order_number", "is", null)
      .order("datetime", { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) { console.error("events query error:", error); break; }
    if (!data || data.length === 0) break;
    allEvents = allEvents.concat(data as never[]);
    if (data.length < PAGE_SIZE) break;
    page++;
  }
  console.log(`Loaded ${allEvents.length} Placed Order events attributed to these campaigns`);

  // ── 3) Resolve order_number → customer_id ──
  const orderNumbers = [...new Set(allEvents.map(e => e.order_number).filter(Boolean))];
  const orderToCustomer = new Map<string, string>();
  for (let i = 0; i < orderNumbers.length; i += 500) {
    const batch = orderNumbers.slice(i, i + 500);
    const { data: rows } = await admin.from("orders").select("order_number, customer_id").eq("workspace_id", W).in("order_number", batch);
    for (const r of rows || []) {
      if (r.customer_id) orderToCustomer.set(r.order_number as string, r.customer_id as string);
    }
  }
  console.log(`Resolved ${orderToCustomer.size}/${orderNumbers.length} order_numbers → customer_id`);

  // ── 4) For each converter event, compute features ──
  const features: ConverterFeatures[] = [];
  let resolved = 0;
  let unresolved = 0;
  for (const ev of allEvents) {
    const customerId = orderToCustomer.get(ev.order_number);
    if (!customerId) { unresolved++; continue; }
    const campaign = campaignsById.get(ev.attributed_campaign_id);
    if (!campaign) continue;
    const sendTimeMs = Date.parse(campaign.send_time);

    // Get linked customer ids
    const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", customerId).maybeSingle();
    let linkedIds = [customerId];
    if (link?.group_id) {
      const { data: grp } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
      for (const g of grp || []) if (!linkedIds.includes(g.customer_id)) linkedIds.push(g.customer_id);
    }

    // Orders before send
    const { data: priorOrders } = await admin.from("orders")
      .select("created_at, total_cents")
      .in("customer_id", linkedIds)
      .lt("created_at", campaign.send_time)
      .order("created_at", { ascending: true });

    const preSendOrders = (priorOrders || []).length;
    const preSendLtv = (priorOrders || []).reduce((s, o) => s + (o.total_cents || 0), 0);

    let daysSinceLastOrder: number | null = null;
    let meanGap: number | null = null;
    let ratio: number | null = null;
    if (preSendOrders > 0) {
      const last = priorOrders![priorOrders!.length - 1];
      daysSinceLastOrder = (sendTimeMs - Date.parse(last.created_at as string)) / 86_400_000;
      if (preSendOrders > 1) {
        const gaps: number[] = [];
        for (let i = 1; i < priorOrders!.length; i++) {
          gaps.push((Date.parse(priorOrders![i].created_at as string) - Date.parse(priorOrders![i - 1].created_at as string)) / 86_400_000);
        }
        meanGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
        ratio = meanGap > 0 ? daysSinceLastOrder / meanGap : null;
      }
    }

    // Active sub at send
    const { data: subs } = await admin.from("subscriptions").select("status, created_at, updated_at").in("customer_id", linkedIds).lte("created_at", campaign.send_time);
    // Heuristic: an active sub at send time = currently active OR (cancelled but cancelled_at after send_time, which we don't store — best-effort: status='active' is the most conservative)
    const activeSubAtSend = (subs || []).some(s => s.status === "active");

    // Find profile-level engagement events.
    // We need the klaviyo_profile_id from the Placed Order event to match the right person's events
    const profileId = ev.klaviyo_profile_id;

    async function countEvents(metric: string, daysBack: number): Promise<number> {
      const since = new Date(sendTimeMs - daysBack * 86_400_000).toISOString();
      const { data } = await admin.from("profile_events")
        .select("id").eq("workspace_id", W).eq("klaviyo_profile_id", profileId).eq("metric_name", metric).gte("datetime", since).lt("datetime", campaign.send_time);
      return (data || []).length;
    }

    const [
      clickedSms60, openedEmail60, clickedEmail60,
      viewedProduct30, addedToCart30, checkoutStarted30,
      activeOnSite90,
    ] = await Promise.all([
      countEvents("Clicked SMS", 60),
      countEvents("Opened Email", 60),
      countEvents("Clicked Email", 60),
      countEvents("Viewed Product", 30),
      countEvents("Added to Cart", 30),
      countEvents("Checkout Started", 30),
      countEvents("Active on Site", 90),
    ]);

    const f: ConverterFeatures = {
      profile_id: profileId,
      customer_id: customerId,
      campaign_id: ev.attributed_campaign_id,
      campaign_name: campaign.name,
      campaign_type: campaign.type,
      send_time: campaign.send_time,
      order_number: ev.order_number,
      order_value_cents: Math.round((ev.value || 0) * 100),

      pre_send_orders: preSendOrders,
      pre_send_ltv_cents: preSendLtv,
      days_since_last_order: daysSinceLastOrder,
      mean_reorder_gap_days: meanGap,
      replenishment_ratio: ratio,
      active_sub_at_send: activeSubAtSend,

      clicked_sms_60d: clickedSms60,
      opened_email_60d: openedEmail60,
      clicked_email_60d: clickedEmail60,
      viewed_product_30d: viewedProduct30,
      added_to_cart_30d: addedToCart30,
      checkout_started_30d: checkoutStarted30,
      active_on_site_90d: activeOnSite90,

      archetype: "cold",
    };
    f.archetype = assignArchetype(f);
    features.push(f);
    resolved++;
    if (resolved % 25 === 0) console.log(`  ${resolved}/${allEvents.length} converters processed…`);
  }

  console.log(`\nResolved ${resolved} converters | unresolved ${unresolved}`);

  // ── 5) Write CSV ──
  const header = [
    "profile_id", "customer_id", "campaign_id", "campaign_name", "campaign_type", "send_time",
    "order_number", "order_value_cents",
    "pre_send_orders", "pre_send_ltv_cents", "days_since_last_order", "mean_reorder_gap_days", "replenishment_ratio",
    "active_sub_at_send",
    "clicked_sms_60d", "opened_email_60d", "clicked_email_60d",
    "viewed_product_30d", "added_to_cart_30d", "checkout_started_30d", "active_on_site_90d",
    "archetype",
  ];
  const rows = features.map(f => header.map(k => {
    const v = (f as Record<string, unknown>)[k];
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
    if (typeof v === "boolean") return v ? "true" : "false";
    return `"${String(v).replace(/"/g, "\"\"")}"`;
  }).join(","));
  writeFileSync("/tmp/segment-features-3mo.csv", [header.join(","), ...rows].join("\n"));
  console.log(`\nWrote /tmp/segment-features-3mo.csv (${features.length} rows)`);

  // ── 6) Summary stats ──
  console.log("\n═══ ARCHETYPE DISTRIBUTION ═══");
  const archetypeCounts = new Map<string, number>();
  for (const f of features) archetypeCounts.set(f.archetype, (archetypeCounts.get(f.archetype) || 0) + 1);
  for (const [a, c] of [...archetypeCounts.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`  ${a.padEnd(15)} ${c.toString().padStart(4)}  (${(100 * c / features.length).toFixed(1)}%)`);
  }

  console.log("\n═══ ARCHETYPE × CAMPAIGN TYPE ═══");
  const byType = new Map<string, Map<string, number>>();
  for (const f of features) {
    if (!byType.has(f.campaign_type)) byType.set(f.campaign_type, new Map());
    const m = byType.get(f.campaign_type)!;
    m.set(f.archetype, (m.get(f.archetype) || 0) + 1);
  }
  const types = [...byType.keys()];
  const archetypes = [...archetypeCounts.keys()];
  console.log("Archetype       " + types.map(t => t.padStart(10)).join(""));
  for (const a of archetypes) {
    const counts = types.map(t => byType.get(t)!.get(a) || 0);
    const pcts = types.map((t, i) => {
      const total = [...byType.get(t)!.values()].reduce((s, n) => s + n, 0);
      return total ? `${(100 * counts[i] / total).toFixed(0)}%` : "—";
    });
    console.log(`  ${a.padEnd(13)} ` + types.map((_, i) => `${counts[i].toString().padStart(4)} (${pcts[i].padStart(3)})`).join(" "));
  }

  console.log("\n═══ REPLENISHMENT RATIO BUCKETS (multi-order only) ═══");
  const buckets = [
    { label: "0-0.5 (just-ordered)", min: 0, max: 0.5 },
    { label: "0.5-1.0", min: 0.5, max: 1.0 },
    { label: "1.0-1.5 (at cycle)", min: 1.0, max: 1.5 },
    { label: "1.5-2.0", min: 1.5, max: 2.0 },
    { label: "2.0-3.0", min: 2.0, max: 3.0 },
    { label: "3.0+", min: 3.0, max: 999 },
  ];
  for (const b of buckets) {
    const inBucket = features.filter(f => f.replenishment_ratio !== null && f.replenishment_ratio >= b.min && f.replenishment_ratio < b.max);
    console.log(`  ${b.label.padEnd(22)} ${inBucket.length.toString().padStart(4)}  (${(100 * inBucket.length / features.length).toFixed(1)}%)`);
  }

  console.log("\n═══ ENGAGEMENT FEATURE PRESENCE ═══");
  const engCheck = (key: keyof ConverterFeatures, threshold: number) => {
    const present = features.filter(f => ((f[key] as number) || 0) >= threshold).length;
    return `${present}/${features.length}  (${(100 * present / features.length).toFixed(1)}%)`;
  };
  console.log(`  clicked_sms_60d >= 1     : ${engCheck("clicked_sms_60d", 1)}`);
  console.log(`  clicked_sms_60d >= 5     : ${engCheck("clicked_sms_60d", 5)}`);
  console.log(`  opened_email_60d >= 1    : ${engCheck("opened_email_60d", 1)}`);
  console.log(`  clicked_email_60d >= 1   : ${engCheck("clicked_email_60d", 1)}`);
  console.log(`  added_to_cart_30d >= 1   : ${engCheck("added_to_cart_30d", 1)}`);
  console.log(`  checkout_started_30d >= 1: ${engCheck("checkout_started_30d", 1)}`);
  console.log(`  viewed_product_30d >= 1  : ${engCheck("viewed_product_30d", 1)}`);
  console.log(`  active_on_site_90d >= 1  : ${engCheck("active_on_site_90d", 1)}`);

  console.log("\n═══ PRIOR ORDER COUNT ═══");
  const orderBuckets = [{ label: "0", min: 0, max: 0 }, { label: "1", min: 1, max: 1 }, { label: "2-4", min: 2, max: 4 }, { label: "5-9", min: 5, max: 9 }, { label: "10+", min: 10, max: 9999 }];
  for (const b of orderBuckets) {
    const n = features.filter(f => f.pre_send_orders >= b.min && f.pre_send_orders <= b.max).length;
    console.log(`  ${b.label.padEnd(8)} ${n.toString().padStart(4)}  (${(100 * n / features.length).toFixed(1)}%)`);
  }

  console.log(`\nTotal converters analyzed: ${features.length}`);
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
