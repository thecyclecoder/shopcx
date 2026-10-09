/**
 * Compare every ShopCX-billed subscription against its live Shopify contract, and say where they
 * disagree.
 *
 * ⭐ Why. ShopCX bills `subscriptions`, but the thing that actually holds the money is the Shopify
 * contract. When the two disagree the failure is SILENT in both directions:
 *
 * - our row says `active`, the contract is `CANCELLED` → the renewal cron selects it forever and
 *   every attempt no-ops. The customer thinks they are subscribed; they are not, and nobody is
 *   told. Found live on 35945087149 on 2026-09-18.
 * - our row says `active`, the contract is `PAUSED` → same shape.
 * - our date sits inside a cycle Shopify has already marked `BILLED` → the worker resolves the
 *   cycle by date and skips spent ones, so the subscription is **never charged again**. Measured on
 *   the 2026-09-16 cohort: two of three subs that had just charged were already dead, one by eight
 *   minutes. This is the one that costs money.
 * - the Shopify-visible date differs from ours → display drift only (we bill by our own date), but
 *   it is what the customer and every Shopify surface see.
 *
 * At eight rows a person can eyeball this. At three hundred nobody can, which is precisely when a
 * migration wave makes it matter. So it runs daily and reports.
 *
 * READ-ONLY by default. `apply` fixes only the unambiguous case — our row disagreeing with the
 * contract's own status, where the contract is authoritative by definition. Dates are NOT auto-
 * fixed: a strand needs a re-pin decision, not a blind overwrite.
 *
 * See [[docs/brain/libraries/commerce__shopcx-drift-reconciler]].
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { getSubscriptionContract } from "@/lib/commerce/shopify-subscription-client";

export type DriftKind =
  | "status"          // our status disagrees with the contract's
  | "date"            // the Shopify-visible date differs from ours
  | "unreadable";     // the contract cannot be read at all

export interface DriftRow {
  subscriptionId: string;
  contractId: string;
  kind: DriftKind;
  ours: string | null;
  shopify: string | null;
  detail: string;
  /** Set when `apply` was on AND this row's drift was the auto-fixable kind. */
  repaired?: boolean;
}

export interface DriftReport {
  checked: number;
  drift: DriftRow[];
  repaired: number;
  errors: string[];
}

/** Dates within this of each other are the same date — clock time on a date-only field varies. */
const DATE_TOLERANCE_MS = 36 * 60 * 60 * 1000;

function mapStatus(shopify: string): string {
  switch (String(shopify).toUpperCase()) {
    case "ACTIVE": return "active";
    case "PAUSED": return "paused";
    default: return "cancelled";
  }
}

export async function reconcileShopcxDrift(
  workspaceId: string,
  opts: { apply?: boolean; limit?: number } = {},
): Promise<DriftReport> {
  const admin = createAdminClient();
  const report: DriftReport = { checked: 0, drift: [], repaired: 0, errors: [] };

  // ⚠️ Keyset-paginate. A bare select caps at the PostgREST 1000-row max and silently drops the
  // overflow — which on this cron would mean the newest migrated subs, the ones most likely to
  // have drifted, are exactly the ones never checked.
  let after = "";
  const pageSize = 200;
  for (;;) {
    let q = admin
      .from("subscriptions")
      .select("id, shopify_contract_id, status, next_billing_date")
      .eq("workspace_id", workspaceId)
      .eq("billing_source", "shopcx")
      .order("id")
      .limit(pageSize);
    if (after) q = q.gt("id", after);
    const { data: page, error } = await q;
    if (error) {
      report.errors.push(`select failed: ${error.message}`);
      break;
    }
    if (!page?.length) break;

    for (const sub of page) {
      if (opts.limit && report.checked >= opts.limit) return report;
      report.checked++;
      try {
        const live = await getSubscriptionContract(workspaceId, sub.shopify_contract_id);
        if (!live.success || !live.contract) {
          report.drift.push({
            subscriptionId: sub.id, contractId: sub.shopify_contract_id, kind: "unreadable",
            ours: sub.status, shopify: null, detail: live.error ?? "unreadable",
          });
          continue;
        }
        const c = live.contract;
        const expected = mapStatus(c.status);

        if (expected !== sub.status) {
          const row: DriftRow = {
            subscriptionId: sub.id, contractId: sub.shopify_contract_id, kind: "status",
            ours: sub.status, shopify: c.status,
            detail: `our row says ${sub.status}, the contract is ${c.status}`,
          };
          if (opts.apply) {
            // The contract holds the money, so it is authoritative on whether this is alive.
            const patch: Record<string, unknown> = { status: expected, updated_at: new Date().toISOString() };
            if (expected === "cancelled") {
              // Cancel-truth: a cancelled row cannot advertise a future charge date.
              patch.next_billing_date = null;
              const { data: prior } = await admin
                .from("subscriptions").select("cancelled_at").eq("id", sub.id).maybeSingle();
              patch.cancelled_at = (prior as { cancelled_at?: string } | null)?.cancelled_at
                ?? new Date().toISOString();
            }
            const { error: upErr } = await admin.from("subscriptions").update(patch).eq("id", sub.id);
            if (upErr) report.errors.push(`${sub.shopify_contract_id}: repair failed — ${upErr.message}`);
            else { row.repaired = true; report.repaired++; }
          }
          report.drift.push(row);
          // A cancelled contract has no meaningful schedule left to compare.
          if (expected === "cancelled") continue;
        }

        if (!sub.next_billing_date) continue;

        // ⚠️ A PAUSED sub is not a strand. Its date is frozen at its last charge, so it looks like
        // it lands in a spent cycle — but the renewal cron only selects `active`, and
        // `retimeAfterResume` ([[portal-auto-resume]]) rolls the date forward and re-pins when the
        // pause ends. Measured 2026-09-21: two customers took a 60-day pause hours after renewing,
        // and both were reported STRANDED — the loudest alert this module raises, on subscriptions
        // that were behaving perfectly. A false strand teaches people to ignore real ones.
        if (sub.status === "paused") continue;

        // Strand check retired: resolveChargeableCycle now bills the first UNBILLED cycle by index
        // (not by date), so a date landing in a spent cycle no longer strands a sub. See
        // [[docs/brain/libraries/commerce__shopify-subscription-client]].

        if (c.nextBillingDate) {
          const delta = Math.abs(new Date(c.nextBillingDate).getTime() - new Date(sub.next_billing_date).getTime());
          if (delta > DATE_TOLERANCE_MS) {
            report.drift.push({
              subscriptionId: sub.id, contractId: sub.shopify_contract_id, kind: "date",
              ours: sub.next_billing_date, shopify: c.nextBillingDate,
              detail: `${Math.round(delta / 86_400_000)} day(s) apart — we bill on ours, but this is what the customer sees. Re-pin with shopifyRetimeContract.`,
            });
          }
        }
      } catch (err) {
        report.errors.push(`${sub.shopify_contract_id}: ${errText(err)}`);
      }
    }

    if (page.length < pageSize) break;
    after = page[page.length - 1].id;
  }

  return report;
}


/** One subscription whose next charge is materially later than its own cadence allows. */
export interface LateSub {
  contractId: string;
  cadenceDays: number;
  extraDays: number;
  lastChargedAt: string;
  nextBillingDate: string;
  /** An OPEN dunning cycle holds the date on purpose — that lateness is intended, not a defect. */
  inDunning: boolean;
  /**
   * The last charge PREDATES the migration, so the subscription arrived already behind.
   *
   * ⚠️ This distinction is what makes the alert usable. 7 of the 13 late subs on 2026-09-30 were
   * inherited — last charged April to August, before we ever billed them. Escalating those daily
   * would train everyone to ignore the alert, and the one that mattered would go with it.
   */
  inheritedFromAppstle: boolean;
}

function cadenceDays(interval: string | null, count: number | null): number {
  const k = count ?? 1;
  switch (String(interval ?? "month").toLowerCase()) {
    case "week": return 7 * k;
    case "day": return k;
    case "year": return 365 * k;
    default: return 30 * k;
  }
}

/**
 * Find subs whose next charge is later than one cadence after their last one.
 *
 * ⭐ This catches what `reconcileShopcxDrift` structurally cannot. The strand check asks "is my date
 * in a spent cycle?" and the date check asks "does Shopify agree with me?" — **a subscription can
 * pass both and still be a month late**, sitting in a correct unbilled cycle but pinned to the far
 * end of its window. Measured 2026-09-28: 22 subs were late while both checks read green.
 *
 * The customer's own cadence is the only honest reference. Dunning-held subs are reported but
 * flagged `inDunning`, because holding the date is exactly what an open cycle is supposed to do.
 */
export async function findLateSubscriptions(
  workspaceId: string,
  opts: { toleranceFraction?: number } = {},
): Promise<LateSub[]> {
  const admin = createAdminClient();
  const tol = opts.toleranceFraction ?? 0.5;
  const out: LateSub[] = [];

  // ⚠️ Keyset-paginate: a bare select caps at the PostgREST 1000-row max.
  let after = "";
  for (;;) {
    let q = admin
      .from("subscriptions")
      .select("id, shopify_contract_id, next_billing_date, billing_interval, billing_interval_count")
      .eq("workspace_id", workspaceId).eq("billing_source", "shopcx").eq("status", "active")
      .order("id").limit(200);
    if (after) q = q.gt("id", after);
    const { data: page } = await q;
    if (!page?.length) break;

    for (const s of page) {
      if (!s.next_billing_date) continue;
      const { data: last } = await admin
        .from("orders").select("created_at")
        .eq("workspace_id", workspaceId).eq("subscription_id", s.id)
        .order("created_at", { ascending: false }).limit(1);
      if (!last?.[0]) continue;
      const cad = cadenceDays(s.billing_interval, s.billing_interval_count);
      const extra = Math.round(
        (new Date(s.next_billing_date).getTime() - new Date(last[0].created_at as string).getTime()) / 86_400_000,
      ) - cad;
      if (extra <= cad * tol) continue;
      const { count } = await admin
        .from("dunning_cycles").select("*", { count: "exact", head: true })
        .eq("workspace_id", workspaceId).eq("shopify_contract_id", s.shopify_contract_id)
        .in("status", ["active", "rotating", "retrying", "skipped", "paused"]);
      // Did WE schedule this, or did it arrive late? Compare the last charge to the moment the
      // migration completed for this contract.
      let inherited = false;
      const { data: row } = await admin.from("subscriptions")
        .select("migrated_from_contract_id").eq("id", s.id).maybeSingle();
      const oldId = (row as { migrated_from_contract_id?: string } | null)?.migrated_from_contract_id;
      if (oldId) {
        const { data: snap } = await admin.from("appstle_contract_snapshots")
          .select("migration_completed_at").eq("workspace_id", workspaceId)
          .eq("appstle_contract_id", oldId).maybeSingle();
        const at = (snap as { migration_completed_at?: string } | null)?.migration_completed_at;
        if (at && new Date(last[0].created_at as string) < new Date(at)) inherited = true;
      }
      out.push({
        contractId: s.shopify_contract_id, cadenceDays: cad, extraDays: extra,
        lastChargedAt: String(last[0].created_at), nextBillingDate: s.next_billing_date,
        inDunning: (count ?? 0) > 0,
        inheritedFromAppstle: inherited,
      });
    }
    if (page.length < 200) break;
    after = page[page.length - 1].id;
  }
  return out;
}
