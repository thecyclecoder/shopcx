/**
 * Recompute customers.segments from current order history + engagement.
 *
 * Segments are independent boolean tags (a customer can be in many).
 * Priority cascading happens at campaign-send time via excluded_segments,
 * not by mutual exclusion here.
 *
 * Predicates (mirrors scripts/segment-analysis-casecontrol.ts):
 *   cold          orders == 0
 *   single_order  orders == 1
 *   just_ordered  orders >= 2 AND ratio < 0.5
 *   cycle_hitter  orders >= 2 AND 0.5 <= ratio <= 1.5
 *   lapsed        orders >= 2 AND 1.5 < ratio <= 3.0
 *   deep_lapsed   orders >= 2 AND ratio > 3.0
 *   engaged       orders >= 1 AND (clicked_email_60d>=1 OR ATC>=1
 *                                  OR checkout>=1 OR views>=2)
 *                 NOTE: explicitly excludes clicked_sms_60d. Lift
 *                 analysis (2026-05-16) showed it's the WEAKEST
 *                 signal — only 2.1× lift, and 11+ bucket converts
 *                 WORSE than baseline (habit-clickers/coupon-hunters).
 *                 Also excludes opened_email (non-monotonic dose
 *                 response) and active_on_site (weaker proxy).
 *   active_sub    has any subscription with status='active'
 *
 * Ratio = days_since_last_order / mean_reorder_gap_days, computed at NOW().
 * Engagement counts are over the 30/60d window ending at NOW().
 *
 * Scope: SMS-subscribed customers only (others have no campaign-send
 * use). Pass --all to recompute everyone.
 *
 * Usage:
 *   npx tsx scripts/refresh-customer-segments.ts          # SMS-subscribed only
 *   npx tsx scripts/refresh-customer-segments.ts --all    # everyone
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

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ALL = process.argv.includes("--all");
const CUSTOMER_BATCH = 500;
const ENGAGEMENT_BATCH = 100; // GET URL length cap
const UPDATE_BATCH = 200;

const NOW = Date.now();
const SINCE_30D = new Date(NOW - 30 * 86_400_000).toISOString();
const SINCE_60D = new Date(NOW - 60 * 86_400_000).toISOString();

interface CustomerRow {
  id: string;
}

interface OrderRow {
  customer_id: string;
  created_at: string;
}

function computeSegments(opts: {
  orderDates: number[];
  hasActiveSub: boolean;
  clickedEmail60d: number;
  atc30d: number;
  checkout30d: number;
  viewedProduct30d: number;
}): string[] {
  const out: string[] = [];
  const orders = opts.orderDates.length;

  // Archetype-style segments
  if (orders === 0) out.push("cold");
  else if (orders === 1) out.push("single_order");
  else {
    // orders >= 2 — compute replenishment ratio
    const sorted = [...opts.orderDates].sort((a, b) => a - b);
    const lastOrder = sorted[sorted.length - 1];
    const daysSinceLast = (NOW - lastOrder) / 86_400_000;
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((sorted[i] - sorted[i - 1]) / 86_400_000);
    }
    const meanGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const ratio = meanGap > 0 ? daysSinceLast / meanGap : null;

    if (ratio === null) {
      out.push("cycle_hitter"); // same-day orders fall here
    } else if (ratio < 0.5) {
      out.push("just_ordered");
    } else if (ratio <= 1.5) {
      out.push("cycle_hitter");
    } else if (ratio <= 3.0) {
      out.push("lapsed");
    } else {
      out.push("deep_lapsed");
    }
  }

  // Engaged — orthogonal, can stack with any archetype
  if (
    orders >= 1 &&
    (opts.clickedEmail60d >= 1 ||
      opts.atc30d >= 1 ||
      opts.checkout30d >= 1 ||
      opts.viewedProduct30d >= 2)
  ) {
    out.push("engaged");
  }

  // Flag — subscription state
  if (opts.hasActiveSub) out.push("active_sub");

  return out;
}

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // ── Load target customer set ──
  console.log(`Loading customers (scope: ${ALL ? "all" : "SMS-subscribed"})...`);
  const customers: CustomerRow[] = [];
  let lastId: string | null = null;
  while (true) {
    let q = sb
      .from("customers")
      .select("id")
      .eq("workspace_id", WS)
      .order("id", { ascending: true })
      .limit(1000);
    if (!ALL) q = q.eq("sms_marketing_status", "subscribed");
    if (lastId) q = q.gt("id", lastId);
    const { data, error } = await q;
    if (error) throw new Error(`customers fetch: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) customers.push(r as CustomerRow);
    lastId = data[data.length - 1].id;
    if (data.length < 1000) break;
  }
  console.log(`Loaded ${customers.length} customers`);

  // Stats
  const segCounts = new Map<string, number>();
  let processed = 0;
  let updated = 0;
  let errors = 0;
  const t0 = Date.now();

  // Process customers in batches — minimize round trips.
  for (let i = 0; i < customers.length; i += CUSTOMER_BATCH) {
    const batch = customers.slice(i, i + CUSTOMER_BATCH);
    const customerIds = batch.map((c) => c.id);

    // ── Bulk-load orders (paginate by 100 to stay under URL limit) ──
    const ordersByCustomer = new Map<string, number[]>();
    for (let j = 0; j < customerIds.length; j += 100) {
      const chunk = customerIds.slice(j, j + 100);
      const { data } = await sb
        .from("orders")
        .select("customer_id, created_at")
        .in("customer_id", chunk);
      for (const o of (data || []) as OrderRow[]) {
        if (!ordersByCustomer.has(o.customer_id)) ordersByCustomer.set(o.customer_id, []);
        ordersByCustomer.get(o.customer_id)!.push(Date.parse(o.created_at));
      }
    }

    // ── Bulk-load active subs (lowercase 'active') ──
    const activeSubCustomers = new Set<string>();
    for (let j = 0; j < customerIds.length; j += 100) {
      const chunk = customerIds.slice(j, j + 100);
      const { data } = await sb
        .from("subscriptions")
        .select("customer_id")
        .in("customer_id", chunk)
        .eq("status", "active");
      for (const s of data || []) activeSubCustomers.add(s.customer_id);
    }

    // ── Bulk-load engagement events (by customer_id, populated by
    // the Phase 1c backfill — Klaviyo profile_id → customer_id) ──
    // Pull only the metric types we use, in the largest of the 3 windows.
    const engByCustomer = new Map<string, { clicked_email_60d: number; atc_30d: number; checkout_30d: number; viewed_product_30d: number }>();
    for (let j = 0; j < customerIds.length; j += ENGAGEMENT_BATCH) {
      const chunk = customerIds.slice(j, j + ENGAGEMENT_BATCH);
      const { data } = await sb
        .from("klaviyo_profile_events")
        .select("customer_id, metric_name, datetime")
        .eq("workspace_id", WS)
        .in("customer_id", chunk)
        .in("metric_name", ["Clicked Email", "Added to Cart", "Checkout Started", "Viewed Product"])
        .gte("datetime", SINCE_60D);
      for (const e of data || []) {
        if (!e.customer_id) continue;
        if (!engByCustomer.has(e.customer_id)) {
          engByCustomer.set(e.customer_id, {
            clicked_email_60d: 0, atc_30d: 0, checkout_30d: 0, viewed_product_30d: 0,
          });
        }
        const f = engByCustomer.get(e.customer_id)!;
        const isWithin30 = e.datetime >= SINCE_30D;
        switch (e.metric_name) {
          case "Clicked Email":
            f.clicked_email_60d++;
            break;
          case "Added to Cart":
            if (isWithin30) f.atc_30d++;
            break;
          case "Checkout Started":
            if (isWithin30) f.checkout_30d++;
            break;
          case "Viewed Product":
            if (isWithin30) f.viewed_product_30d++;
            break;
        }
      }
    }

    // ── Compute segments + write back ──
    const updates: Array<{ id: string; segments: string[] }> = [];
    for (const c of batch) {
      const eng = engByCustomer.get(c.id) || {
        clicked_email_60d: 0, atc_30d: 0, checkout_30d: 0, viewed_product_30d: 0,
      };
      const segments = computeSegments({
        orderDates: ordersByCustomer.get(c.id) || [],
        hasActiveSub: activeSubCustomers.has(c.id),
        clickedEmail60d: eng.clicked_email_60d,
        atc30d: eng.atc_30d,
        checkout30d: eng.checkout_30d,
        viewedProduct30d: eng.viewed_product_30d,
      });
      for (const s of segments) segCounts.set(s, (segCounts.get(s) || 0) + 1);
      updates.push({ id: c.id, segments });
      processed++;
    }

    // Batch update — one query per UPDATE_BATCH chunk.
    // Supabase doesn't support multi-row column updates well, so we
    // issue individual updates concurrently within the chunk.
    const refreshedAt = new Date().toISOString();
    for (let j = 0; j < updates.length; j += UPDATE_BATCH) {
      const chunk = updates.slice(j, j + UPDATE_BATCH);
      const results = await Promise.allSettled(
        chunk.map((u) =>
          sb
            .from("customers")
            .update({ segments: u.segments, segments_refreshed_at: refreshedAt })
            .eq("id", u.id),
        ),
      );
      for (const r of results) {
        if (r.status === "fulfilled") updated++;
        else errors++;
      }
    }

    if (processed % 2000 === 0 || processed === customers.length) {
      const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
      const rate = (processed / ((Date.now() - t0) / 1000)).toFixed(1);
      console.log(`  ${processed}/${customers.length} | updated=${updated} errors=${errors} | ${elapsedMin}min @ ${rate}/sec`);
    }
  }

  console.log(`\n✓ DONE — processed=${processed} updated=${updated} errors=${errors} time=${((Date.now() - t0) / 60_000).toFixed(1)}min`);
  console.log(`\nSegment counts (customers can be in multiple):`);
  const sorted = [...segCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [seg, n] of sorted) {
    console.log(`  ${seg.padEnd(15)} ${n}`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
