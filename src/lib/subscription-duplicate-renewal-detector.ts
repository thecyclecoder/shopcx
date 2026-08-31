/**
 * subscription-duplicate-renewal-detector — Phase 2 of
 * docs/brain/specs/immediate-charge-renewal-paths-need-per-subscription-idempotency.md.
 *
 * Read-only observer: flags any subscription with MORE THAN ONE order of
 * `source_name='internal_subscription_renewal'` inside a single billing cycle (or, more
 * conservatively, within a short window). Phase 1's [[subscription-cycle-charge-claim]] is the
 * BELT — a unique index at the charge chokepoint that refuses the second Braintree sale. This
 * detector is the SUSPENDERS: if a future path bypasses the guard (a new immediate-charge caller
 * that skips the chokepoint, a schema drift that dodges the unique index), the pattern surfaces
 * immediately as a `dashboard_notifications` card instead of a customer email months later.
 *
 * Ground truth: on 2026-08-28 sub fd857ad9 produced SHOPCX273 (17:18:44) and SHOPCX274 (17:22:56)
 * — same subscription_id, same total_cents, minutes apart, both financial_status='paid',
 * source_name='internal_subscription_renewal'. Discovered only when the customer wrote in.
 *
 * The detector runs piggy-backed on the daily `internal-subscription-renewal-cron` — no new
 * Inngest function / cron registration overhead. Read-only against `public.orders`; the only
 * write is a `dashboard_notifications` card per group, deduplicated on
 * `dedupe_key = duplicate-renewal:<subscription_id>:<yyyy-mm-dd>`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type Admin = SupabaseClient;

export interface RenewalOrderLike {
  id: string;
  workspace_id: string | null;
  customer_id: string | null;
  subscription_id: string | null;
  order_number: string | null;
  total_cents: number | null;
  source_name: string | null;
  financial_status: string | null;
  created_at: string;
}

export interface DuplicateRenewalGroup {
  workspace_id: string;
  subscription_id: string;
  customer_id: string | null;
  cycle_day: string; // YYYY-MM-DD — the day the duplicates land on, keyed off `created_at`.
  orders: Array<{
    id: string;
    order_number: string | null;
    total_cents: number | null;
    created_at: string;
    financial_status: string | null;
  }>;
}

/**
 * Pure: bucket a set of `internal_subscription_renewal` orders into duplicate groups.
 *
 * A group is a set of >=2 orders on the SAME `subscription_id` whose `created_at` falls on the
 * SAME UTC day. The day bucket mirrors the Phase 1 `cycle_key` shape (YYYY-MM-DD) so a spike
 * visible in the ledger is visible here in the same coordinates.
 *
 * Same-day is a deliberate simplification over "same billing cycle": a legitimate cycle is
 * measured in weeks/months, so two renewals landing on the same UTC day cannot both be the
 * scheduled cycle. The Phase 1 evidence (SHOPCX273 + SHOPCX274, 4.2 min apart) is captured.
 *
 * Non-`internal_subscription_renewal` rows and rows missing subscription_id are ignored. Orders
 * are sorted by `created_at ASC` within each group so the earliest is first (the one that
 * "should have" won the cycle).
 */
export function detectDuplicateRenewalGroups(
  orders: RenewalOrderLike[],
): DuplicateRenewalGroup[] {
  const buckets = new Map<string, DuplicateRenewalGroup>();
  for (const o of orders) {
    if (o.source_name !== "internal_subscription_renewal") continue;
    if (!o.subscription_id || !o.workspace_id) continue;
    const d = new Date(o.created_at);
    if (!Number.isFinite(d.getTime())) continue;
    const cycle_day = d.toISOString().slice(0, 10);
    const key = `${o.subscription_id}|${cycle_day}`;
    let group = buckets.get(key);
    if (!group) {
      group = {
        workspace_id: o.workspace_id,
        subscription_id: o.subscription_id,
        customer_id: o.customer_id ?? null,
        cycle_day,
        orders: [],
      };
      buckets.set(key, group);
    }
    group.orders.push({
      id: o.id,
      order_number: o.order_number,
      total_cents: o.total_cents,
      created_at: o.created_at,
      financial_status: o.financial_status,
    });
  }
  const groups: DuplicateRenewalGroup[] = [];
  for (const g of buckets.values()) {
    if (g.orders.length < 2) continue;
    g.orders.sort((a, b) => a.created_at.localeCompare(b.created_at));
    groups.push(g);
  }
  return groups;
}

/**
 * Live scan: read every `internal_subscription_renewal` order whose `created_at >= sinceIso` for
 * `workspace_id`, run the pure detector, and return the duplicate groups. Read-only.
 *
 * `sinceIso` defaults to 26 hours ago — a hair over the daily renewal cron's cadence so a fresh
 * spike from the last run is always in the window. The caller can pass a wider window for
 * catch-up sweeps.
 */
export async function scanDuplicateRenewals(
  admin: Admin,
  workspace_id: string,
  sinceIso?: string,
): Promise<DuplicateRenewalGroup[]> {
  const since = sinceIso ?? new Date(Date.now() - 26 * 60 * 60_000).toISOString();
  const { data, error } = await admin
    .from("orders")
    .select("id, workspace_id, customer_id, subscription_id, order_number, total_cents, source_name, financial_status, created_at")
    .eq("workspace_id", workspace_id)
    .eq("source_name", "internal_subscription_renewal")
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(5000);
  if (error) {
    throw new Error(`scan_duplicate_renewals_failed: ${error.message}`);
  }
  return detectDuplicateRenewalGroups((data as RenewalOrderLike[]) ?? []);
}

/**
 * Surface: write a `dashboard_notifications` card per group. Idempotent via a stable
 * `dedupe_key = duplicate-renewal:<subscription_id>:<cycle_day>` — a repeated scan on the same
 * spike does NOT write a second card. Returns the number of NEW cards inserted (dedupe hits
 * skipped).
 *
 * The card's title/body cite the concrete evidence (SHOPCX273/SHOPCX274 shape — same sub,
 * same day, N orders, total $X.XX each) so a human seeing it knows exactly which subscription
 * to open. `type='billing_alert'`, `metadata` carries `subscription_id`, `cycle_day`, and the
 * order ids for the timeline lookup.
 */
export async function surfaceDuplicateRenewalAlert(
  admin: Admin,
  group: DuplicateRenewalGroup,
): Promise<{ inserted: boolean }> {
  const dedupe_key = `duplicate-renewal:${group.subscription_id}:${group.cycle_day}`;
  // Dedupe on `metadata->>dedupe_key` — the convention every other spend/policy escalation uses
  // (fleet-spend-governor.ts:300, ad-spend-governor.ts:241, cs-director-escalate-founder-card.ts:98).
  // `dashboard_notifications` has NO top-level `dedupe_key` column; the shared key lives inside
  // metadata and the partial UNIQUE index `dashboard_notifications_dedupe_key_open_uniq` enforces
  // one-open-card-per-key at the DB level.
  const { data: existing } = await admin
    .from("dashboard_notifications")
    .select("id")
    .eq("workspace_id", group.workspace_id)
    .contains("metadata", { dedupe_key })
    .limit(1)
    .maybeSingle();
  if (existing) return { inserted: false };

  const uniqueTotals = new Set(group.orders.map((o) => o.total_cents ?? 0));
  const sameTotalNote = uniqueTotals.size === 1
    ? ` (all ${(([...uniqueTotals][0] ?? 0) / 100).toFixed(2)} USD — matches the SHOPCX273/274 shape)`
    : "";
  const orderList = group.orders
    .map((o) => `${o.order_number ?? o.id.slice(0, 8)} @ ${o.created_at.slice(11, 19)}Z`)
    .join(", ");

  const { error } = await admin.from("dashboard_notifications").insert({
    workspace_id: group.workspace_id,
    type: "billing_alert",
    title: `Duplicate renewal detected — subscription ${group.subscription_id.slice(0, 8)} charged ${group.orders.length}x on ${group.cycle_day}`,
    body:
      `Subscription ${group.subscription_id} has ${group.orders.length} internal_subscription_renewal orders ` +
      `on ${group.cycle_day}${sameTotalNote}: ${orderList}. Phase 1's subscription_cycle_charges ` +
      `unique-index guard is the primary block; this alert means a path bypassed it — investigate ` +
      `and (if a real double-charge) refund the later order(s).`,
    metadata: {
      kind: "duplicate_internal_renewal",
      dedupe_key,
      subscription_id: group.subscription_id,
      customer_id: group.customer_id,
      cycle_day: group.cycle_day,
      order_ids: group.orders.map((o) => o.id),
      order_numbers: group.orders.map((o) => o.order_number).filter(Boolean),
      total_cents: group.orders.map((o) => o.total_cents),
    },
  });
  if (error) {
    throw new Error(`surface_duplicate_renewal_alert_failed: ${error.message}`);
  }
  return { inserted: true };
}

/**
 * Scan + surface in one call — the shape the daily internal-subscription-renewal-cron uses at
 * end-of-run. Returns the counts so the cron's heartbeat can carry the number of duplicate
 * groups found this run.
 */
export async function scanAndSurfaceDuplicateRenewals(
  admin: Admin,
  workspace_id: string,
  sinceIso?: string,
): Promise<{ groups_found: number; alerts_inserted: number }> {
  const groups = await scanDuplicateRenewals(admin, workspace_id, sinceIso);
  let alerts_inserted = 0;
  for (const g of groups) {
    const res = await surfaceDuplicateRenewalAlert(admin, g);
    if (res.inserted) alerts_inserted++;
  }
  return { groups_found: groups.length, alerts_inserted };
}

// ─── duplicateRenewal aliases ───────────────────────────────────────
// Semantic alias so the detector's PURPOSE is grep-able at every call site, not just the file
// name. The concept is `duplicateRenewal` detection — every caller should reach for these names
// first; the underscored primary names above are the storage/mechanics.
//
// Kept as `const` aliases (not wrappers) so a rename stays cheap and no runtime cost.

/** Alias — the pure duplicateRenewal grouping. */
export const duplicateRenewalGroups = detectDuplicateRenewalGroups;

/** Alias — the live duplicateRenewal scan. */
export const scanForDuplicateRenewals = scanDuplicateRenewals;

/** Alias — surface a duplicateRenewal group as a dashboard_notifications card. */
export const surfaceDuplicateRenewalGroup = surfaceDuplicateRenewalAlert;

/** Alias — scan + surface in one call. */
export const runDuplicateRenewalSweep = scanAndSurfaceDuplicateRenewals;
