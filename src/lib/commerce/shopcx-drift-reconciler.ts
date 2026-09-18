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
import {
  getSubscriptionContract,
  getBillingCycleForDate,
} from "@/lib/commerce/shopify-subscription-client";

export type DriftKind =
  | "status"          // our status disagrees with the contract's
  | "stranded"        // our date lands in a cycle Shopify already billed or skipped
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

        // ⭐ The expensive check, and the one that actually costs money. Ask Shopify which cycle
        // our billing date lands in; a BILLED or skipped cycle means the renewal worker will skip
        // this subscription every run from here on, silently and forever.
        const landing = await getBillingCycleForDate(
          workspaceId, sub.shopify_contract_id, sub.next_billing_date,
        );
        if (landing.success && landing.cycle && (landing.cycle.status === "BILLED" || landing.cycle.skipped)) {
          report.drift.push({
            subscriptionId: sub.id, contractId: sub.shopify_contract_id, kind: "stranded",
            ours: sub.next_billing_date, shopify: `cycle #${landing.cycle.index} ${landing.cycle.status}`,
            detail: `our date lands in cycle #${landing.cycle.index} (${landing.cycle.status}${landing.cycle.skipped ? ", skipped" : ""}) — the renewal worker WILL skip this subscription. Needs a re-pin (shopifyRetimeContract), not a date overwrite.`,
          });
          continue;
        }

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
