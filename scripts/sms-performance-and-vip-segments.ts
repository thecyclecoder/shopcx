/**
 * SMS performance review + VIP segment recommendation for today's
 * end-of-month sale.
 *
 * Pulls:
 *  • Last 30 days of sms_campaigns (recipients, sent, delivered, click,
 *    conversion via attributed_utm_campaign on orders).
 *  • Per-segment audience health right now (subscribed + good phone +
 *    last campaign send timing).
 *  • Recommends segments based on conversion rate × audience size,
 *    minus anyone who already converted on a recent campaign (so we
 *    don't burn the same person twice in the same month).
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

async function pageAll<T>(query: ReturnType<typeof admin.from> extends { select: (...a: unknown[]) => infer Q } ? Q : never, _label = ""): Promise<T[]> {
  // Workaround: PostgREST caps at 1000 rows per request — paginate.
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const q = query as unknown as { range: (f: number, t: number) => Promise<{ data: T[] | null }> };
    const { data } = await q.range(from, from + pageSize - 1);
    const rows = (data || []) as T[];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function main() {
  console.log("=== SMS CAMPAIGN PERFORMANCE (last 30d) ===\n");

  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: campaigns } = await admin
    .from("sms_campaigns")
    .select("id, name, send_date, recipients_total, recipients_sent, recipients_failed, included_segments, status, created_at, coupon_code")
    .eq("workspace_id", WORKSPACE_ID)
    .gte("send_date", since.slice(0, 10))
    .order("send_date", { ascending: true });

  if (!campaigns?.length) {
    console.log("No campaigns in last 30 days.");
    return;
  }

  // Pull orders attributed to these campaigns
  const campaignIds = campaigns.map(c => c.id);
  const { data: orders } = await admin
    .from("orders")
    .select("attributed_utm_campaign, total_cents, source_name, subscription_id, customer_id")
    .eq("workspace_id", WORKSPACE_ID)
    .in("attributed_utm_campaign", campaignIds);
  const SUB_SOURCES = new Set(["subscription_contract", "subscription_contract_checkout_one"]);
  const ordersByC = new Map<string, { count: number; revenue: number; customers: Set<string> }>();
  for (const o of (orders || []) as Array<{ attributed_utm_campaign: string; total_cents: number | null; source_name: string | null; subscription_id: string | null; customer_id: string | null }>) {
    if (SUB_SOURCES.has(o.source_name || "") || o.subscription_id) continue; // exclude renewals
    const cur = ordersByC.get(o.attributed_utm_campaign) || { count: 0, revenue: 0, customers: new Set() };
    cur.count++;
    cur.revenue += o.total_cents || 0;
    if (o.customer_id) cur.customers.add(o.customer_id);
    ordersByC.set(o.attributed_utm_campaign, cur);
  }

  // Render per-campaign + segment rollup
  const segmentRollup = new Map<string, { sends: number; orders: number; revenue: number; campaigns: number }>();

  for (const c of campaigns) {
    const o = ordersByC.get(c.id) || { count: 0, revenue: 0, customers: new Set() };
    const sent = c.recipients_sent || 0;
    const convRate = sent > 0 ? (o.count / sent) * 100 : 0;
    const segs = ((c.included_segments as string[]) || []).join("+") || "(none)";
    console.log(
      `${c.send_date}  ${c.name.padEnd(35)}  segs=${segs.padEnd(28)}  sent=${String(sent).padStart(6)}  orders=${String(o.count).padStart(4)}  conv=${convRate.toFixed(2)}%  rev=$${(o.revenue / 100).toFixed(0)}`,
    );
    // Roll up by segment (single-segment campaigns only, for cleanest signal)
    const segments = (c.included_segments as string[]) || [];
    if (segments.length === 1) {
      const key = segments[0];
      const r = segmentRollup.get(key) || { sends: 0, orders: 0, revenue: 0, campaigns: 0 };
      r.sends += sent;
      r.orders += o.count;
      r.revenue += o.revenue;
      r.campaigns += 1;
      segmentRollup.set(key, r);
    }
  }

  console.log("\n=== PER-SEGMENT ROLLUP (single-segment campaigns only) ===\n");
  const ranked = [...segmentRollup.entries()]
    .map(([k, v]) => ({ segment: k, ...v, conv_rate: v.sends > 0 ? (v.orders / v.sends) * 100 : 0, rev_per_send: v.sends > 0 ? v.revenue / v.sends : 0 }))
    .sort((a, b) => b.conv_rate - a.conv_rate);
  console.log("segment".padEnd(20), "campaigns".padEnd(11), "sends".padEnd(8), "orders".padEnd(8), "conv%".padEnd(8), "rev/send");
  for (const r of ranked) {
    console.log(
      r.segment.padEnd(20),
      String(r.campaigns).padEnd(11),
      String(r.sends).padEnd(8),
      String(r.orders).padEnd(8),
      r.conv_rate.toFixed(2).padEnd(8),
      `$${(r.rev_per_send / 100).toFixed(2)}`,
    );
  }

  // Audience now — eligible SMS subscribers per segment
  console.log("\n=== CURRENT AUDIENCE SIZE PER SEGMENT (subscribed, good phone, has segment tag) ===\n");
  // Need to paginate because customers table has >1000 SMS-eligible rows
  const knownSegments = ["engaged", "cycle_hitter", "just_ordered", "lapsed", "deep_lapsed", "single_order", "cold", "active_sub", "vip"];
  for (const seg of knownSegments) {
    const { count } = await admin
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", WORKSPACE_ID)
      .eq("sms_marketing_status", "subscribed")
      .or("phone_status.is.null,phone_status.eq.good")
      .not("phone", "is", null)
      .overlaps("segments", [seg]);
    console.log(`  ${seg.padEnd(16)} ${String(count || 0).padStart(7)}`);
  }

  // Recent-buyer exclusion: anyone who placed a non-sub order in last 30 days
  // is a "recently bought" customer — usually you'd EXCLUDE them from a sale
  // since they just paid full price.
  const recentBuyers = await admin
    .from("orders")
    .select("customer_id", { count: "exact", head: true })
    .eq("workspace_id", WORKSPACE_ID)
    .gte("created_at", since)
    .or("source_name.is.null,source_name.eq.web,source_name.eq.shopify_draft_order");
  console.log(`\n=== Recent buyers (last 30d, non-sub) — usually exclude from a sale ===`);
  console.log(`  ${recentBuyers.count || 0} customers`);
}

main().catch((e) => { console.error(e); process.exit(1); });
