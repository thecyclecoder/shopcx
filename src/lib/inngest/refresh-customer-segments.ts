/**
 * Daily recompute of customers.segments for every SMS-subscribed customer
 * in every workspace. Mirrors the logic in scripts/refresh-customer-segments.ts
 * (the manual --all escape hatch), wired as Inngest so it runs unattended.
 *
 * Why this matters: campaigns target customers by `segments` overlap. Without
 * a refresh the tags drift — a customer who placed a new order last week still
 * shows as `lapsed`, the engagement-derived `engaged` tag is missing the past
 * 7 days, `active_sub` doesn't reflect recent cancels/resumes.
 *
 * FAN-OUT ARCHITECTURE (2026-06-14): the previous single-invocation design
 * processed all ~138K subscribers in one Inngest run and hit the Vercel
 * maxDuration ceiling at ~71K customers, then restarted from the lowest id
 * each day — so the back half of the book never refreshed (stuck ~29 days
 * stale). Fixed by fanning out:
 *   1. `refresh-customer-segments-cron` (cron) sends one
 *      `segments/refresh-workspace` event per workspace — trivial, fast.
 *   2. `refresh-workspace-segments` (per workspace) keyset-paginates its
 *      subscribers and processes each STEP_BATCH-sized page inside its own
 *      `step.run`. Inngest runs each step as a separate short HTTP invocation
 *      (completed steps replay from memo), so NO single invocation can time
 *      out regardless of how many customers a workspace has.
 *
 * Predicates (identical to the script for parity):
 *   cold          orders == 0
 *   single_order  orders == 1
 *   just_ordered  orders >= 2 AND ratio < 0.5
 *   cycle_hitter  orders >= 2 AND 0.5 <= ratio <= 1.5
 *   lapsed        orders >= 2 AND 1.5 < ratio <= 3.0
 *   deep_lapsed   orders >= 2 AND ratio > 3.0
 *   engaged       orders >= 1 AND (clicked_email_60d>=1 OR ATC_30d>=1
 *                                  OR checkout_30d>=1 OR viewed_product_30d>=2)
 *   active_sub    has any subscription with status='active'
 *   storefront_signup  customer_id appears in storefront_leads
 *
 * ratio = days_since_last_order / mean_reorder_gap_days
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

// Customers per keyset page = one step.run = one HTTP invocation. MUST be ≤
// the PostgREST/Supabase server-side `max-rows` cap (1000 by default) — a
// `.limit(N)` above the cap is silently truncated to the cap, and processBatch
// decides "done" from `batch.length < limit` (line ~198). If STEP_BATCH is
// above 1000 the first full page returns 1000, batch.length < limit → cursor
// nulls → the loop breaks after ONE page and the back half of the book never
// refreshes (the 2026-07 whole-book-coverage bug: 1000/138K subscribers stayed
// stale). Mirrored in scripts/refresh-customer-segments.ts. ~138 pages cover
// 138K subscribers, each still well under maxDuration.
const STEP_BATCH = 1000;
const ENGAGEMENT_BATCH = 100;
const UPDATE_BATCH = 200;
// Backstop against an unbounded cursor loop (STEP_BATCH * this = ceiling).
const MAX_PAGES = 1000;

function computeSegments(opts: {
  orderDates: number[];
  hasActiveSub: boolean;
  clickedEmail60d: number;
  atc30d: number;
  checkout30d: number;
  viewedProduct30d: number;
  now: number;
}): string[] {
  const out: string[] = [];
  const orders = opts.orderDates.length;
  if (orders === 0) out.push("cold");
  else if (orders === 1) out.push("single_order");
  else {
    const sorted = [...opts.orderDates].sort((a, b) => a - b);
    const lastOrder = sorted[sorted.length - 1];
    const daysSinceLast = (opts.now - lastOrder) / 86_400_000;
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i] - sorted[i - 1]) / 86_400_000);
    const meanGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const ratio = meanGap > 0 ? daysSinceLast / meanGap : null;
    if (ratio === null) out.push("cycle_hitter");
    else if (ratio < 0.5) out.push("just_ordered");
    else if (ratio <= 1.5) out.push("cycle_hitter");
    else if (ratio <= 3.0) out.push("lapsed");
    else out.push("deep_lapsed");
  }
  if (orders >= 1 && (opts.clickedEmail60d >= 1 || opts.atc30d >= 1 || opts.checkout30d >= 1 || opts.viewedProduct30d >= 2)) {
    out.push("engaged");
  }
  if (opts.hasActiveSub) out.push("active_sub");
  return out;
}

/**
 * Process ONE keyset page of SMS-subscribed customers (ids > afterId, ordered
 * by id, up to STEP_BATCH). Computes + writes their segments. Returns counts +
 * the next cursor (null when this was the final page). Designed to run inside a
 * single step.run so each page is its own short invocation.
 */
async function processBatch(
  workspaceId: string,
  afterId: string | null,
  limit: number,
): Promise<{ processed: number; updated: number; errors: number; nextCursor: string | null }> {
  const sb = createAdminClient();
  const now = Date.now();
  const since30 = new Date(now - 30 * 86_400_000).toISOString();
  const since60 = new Date(now - 60 * 86_400_000).toISOString();

  let q = sb
    .from("customers")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("sms_marketing_status", "subscribed")
    .order("id", { ascending: true })
    .limit(limit);
  if (afterId) q = q.gt("id", afterId);
  const { data: idRows, error: idErr } = await q;
  if (idErr) throw new Error(`customers fetch: ${idErr.message}`);
  if (!idRows?.length) return { processed: 0, updated: 0, errors: 0, nextCursor: null };
  const batch = idRows.map((r) => r.id as string);

  const ordersByCustomer = new Map<string, number[]>();
  for (let j = 0; j < batch.length; j += 100) {
    const chunk = batch.slice(j, j + 100);
    const { data } = await sb.from("orders").select("customer_id, created_at").in("customer_id", chunk);
    for (const o of (data || []) as Array<{ customer_id: string; created_at: string }>) {
      if (!ordersByCustomer.has(o.customer_id)) ordersByCustomer.set(o.customer_id, []);
      ordersByCustomer.get(o.customer_id)!.push(Date.parse(o.created_at));
    }
  }

  const activeSubCustomers = new Set<string>();
  for (let j = 0; j < batch.length; j += 100) {
    const chunk = batch.slice(j, j + 100);
    const { data } = await sb.from("subscriptions").select("customer_id").in("customer_id", chunk).eq("status", "active");
    for (const s of data || []) activeSubCustomers.add(s.customer_id);
  }

  // Customers captured via the new storefront's signup surfaces (any
  // storefront_leads row) → tagged `storefront_signup` so SMS campaigns can
  // target net-new signups precisely instead of the huge `cold` pool.
  const storefrontSignups = new Set<string>();
  for (let j = 0; j < batch.length; j += 100) {
    const chunk = batch.slice(j, j + 100);
    const { data } = await sb.from("storefront_leads").select("customer_id").eq("workspace_id", workspaceId).in("customer_id", chunk);
    for (const s of data || []) if (s.customer_id) storefrontSignups.add(s.customer_id as string);
  }

  const engByCustomer = new Map<string, { clicked_email_60d: number; atc_30d: number; checkout_30d: number; viewed_product_30d: number }>();
  for (let j = 0; j < batch.length; j += ENGAGEMENT_BATCH) {
    const chunk = batch.slice(j, j + ENGAGEMENT_BATCH);
    const { data } = await sb
      .from("profile_events")
      .select("customer_id, metric_name, datetime")
      .eq("workspace_id", workspaceId)
      .in("customer_id", chunk)
      .in("metric_name", ["Clicked Email", "Added to Cart", "Checkout Started", "Viewed Product"])
      .gte("datetime", since60);
    for (const e of data || []) {
      if (!e.customer_id) continue;
      if (!engByCustomer.has(e.customer_id)) {
        engByCustomer.set(e.customer_id, { clicked_email_60d: 0, atc_30d: 0, checkout_30d: 0, viewed_product_30d: 0 });
      }
      const f = engByCustomer.get(e.customer_id)!;
      const isWithin30 = e.datetime >= since30;
      switch (e.metric_name) {
        case "Clicked Email": f.clicked_email_60d++; break;
        case "Added to Cart": if (isWithin30) f.atc_30d++; break;
        case "Checkout Started": if (isWithin30) f.checkout_30d++; break;
        case "Viewed Product": if (isWithin30) f.viewed_product_30d++; break;
      }
    }
  }

  const updates: Array<{ id: string; segments: string[] }> = [];
  for (const id of batch) {
    const eng = engByCustomer.get(id) || { clicked_email_60d: 0, atc_30d: 0, checkout_30d: 0, viewed_product_30d: 0 };
    const segments = computeSegments({
      orderDates: ordersByCustomer.get(id) || [],
      hasActiveSub: activeSubCustomers.has(id),
      clickedEmail60d: eng.clicked_email_60d,
      atc30d: eng.atc_30d,
      checkout30d: eng.checkout_30d,
      viewedProduct30d: eng.viewed_product_30d,
      now,
    });
    if (storefrontSignups.has(id)) segments.push("storefront_signup");
    updates.push({ id, segments });
  }

  let updated = 0;
  let errors = 0;
  const refreshedAt = new Date().toISOString();
  for (let j = 0; j < updates.length; j += UPDATE_BATCH) {
    const chunk = updates.slice(j, j + UPDATE_BATCH);
    const results = await Promise.allSettled(
      chunk.map((u) => sb.from("customers").update({ segments: u.segments, segments_refreshed_at: refreshedAt }).eq("id", u.id)),
    );
    for (const r of results) {
      if (r.status === "fulfilled") updated++;
      else errors++;
    }
  }

  // Full page ⇒ more may remain; short page ⇒ done.
  const nextCursor = batch.length < limit ? null : batch[batch.length - 1];
  return { processed: batch.length, updated, errors, nextCursor };
}

/**
 * Per-workspace refresh. Keyset-paginates the workspace's SMS-subscribed
 * customers, processing each page inside its own step.run so each runs as a
 * separate short invocation (the cursor loop deterministically replays from
 * memoized step results, so it resumes exactly where it left off).
 */
export const refreshWorkspaceSegments = inngest.createFunction(
  {
    id: "refresh-workspace-segments",
    name: "Refresh customer.segments for one workspace (paginated)",
    concurrency: [{ limit: 4 }],
    retries: 2,
    triggers: [{ event: "segments/refresh-workspace" }],
  },
  async ({ event, step }) => {
    const { workspace_id } = event.data as { workspace_id: string };
    let cursor: string | null = null;
    let page = 0;
    const totals = { processed: 0, updated: 0, errors: 0 };
    while (page < MAX_PAGES) {
      const res = await step.run(`page-${page}`, () => processBatch(workspace_id, cursor, STEP_BATCH));
      totals.processed += res.processed;
      totals.updated += res.updated;
      totals.errors += res.errors;
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
      page++;
    }
    return { workspace_id, pages: page + 1, ...totals };
  },
);

export const refreshCustomerSegmentsCron = inngest.createFunction(
  {
    id: "refresh-customer-segments-cron",
    name: "Refresh customer.segments daily (fan out per workspace)",
    concurrency: [{ limit: 1 }],
    retries: 2,
    // 11:00 UTC = 6 AM Central daily. Runs before the marketing-text send-tick
    // processes recipients (campaigns schedule audience-resolve before the
    // configured send time, so today's audience uses today's refreshed tags).
    triggers: [{ cron: "0 11 * * *" }],
  },
  async ({ step }) => {
    const sb = createAdminClient();
    // Fan out one event per workspace — each handled by refreshWorkspaceSegments
    // in its own run, so a large workspace can't starve or time out the others.
    const { data: workspaces } = await sb.from("workspaces").select("id");
    const events = (workspaces || []).map((w) => ({
      name: "segments/refresh-workspace",
      data: { workspace_id: w.id as string },
    }));
    if (events.length) await step.sendEvent("fan-out-workspaces", events);

    // Coverage probe (fix-segment-refresh-coverage Phase 2): count SMS-subscribed
    // customers vs the count refreshed within 26h + oldest refresh across the
    // subscribed set. Rides `produced` so the Control Tower tile surfaces the
    // number, and the `segment-coverage` output assertion (registry) reads the
    // LIVE customers table each tick to red on <95% coverage or a >48h tail —
    // the alarm that would have caught the 1000/138K state.
    //
    // Fanout is async: the per-workspace runs kicked off above haven't executed
    // yet, so the reported numbers reflect the state BEFORE today's refresh.
    // That's still exactly what we want for a staleness alarm — a red tile at
    // 11:00 UTC means yesterday's book stayed stale, and the assertion polls
    // the same signal every ~15 min so the tile clears once the fanout lands.
    const coverage = await step.run("probe-coverage", async () => {
      const cutoff26h = new Date(Date.now() - 26 * 60 * 60_000).toISOString();
      const [totalRes, freshRes] = await Promise.all([
        sb.from("customers").select("id", { count: "exact", head: true }).eq("sms_marketing_status", "subscribed"),
        sb
          .from("customers")
          .select("id", { count: "exact", head: true })
          .eq("sms_marketing_status", "subscribed")
          .gte("segments_refreshed_at", cutoff26h),
      ]);
      const total = totalRes.count ?? 0;
      const fresh = freshRes.count ?? 0;
      return {
        sms_subscribed_total: total,
        sms_subscribed_fresh_26h: fresh,
        coverage_ratio: total > 0 ? Math.round((fresh / total) * 10_000) / 10_000 : null,
      };
    });

    const result = { fanned_out: events.length, ...coverage };

    // Control Tower: end-of-run heartbeat (control-tower-complete-coverage spec, Phase 1).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("refresh-customer-segments-cron", { ok: true, produced: result });
    });

    return result;
  },
);
