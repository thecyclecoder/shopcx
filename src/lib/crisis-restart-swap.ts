/**
 * crisis-restart-swap — keep a RESTARTED subscription off an out-of-stock flavor.
 *
 * WHY (CEO 2026-11-22): the win-back email went to 657 cancelled subscribers and 241 of them would
 * restart a sub carrying a flavor under an ACTIVE crisis (Strawberry Lemonade tabs, Cocoa instant
 * coffee). A restart brings the sub back exactly as it was, and neither the restart nor the renewal
 * engine checks stock, so the first order would bill the missing flavor. The crisis auto-swap only
 * runs when an admin presses "Start Auto-Swap", so a sub restarted after the last press slipped
 * through.
 *
 * WHAT
 *   - `crisisSwapsForItems` (read-only): which lines on a sub sit under an active crisis with a
 *     default swap, and what they become. The restart page uses it to tell the customer up front:
 *     "Strawberry Lemonade is out of stock right now, so we'll send Mixed Berry and switch you back
 *     as soon as it's restocked."
 *   - `applyCrisisSwapsAfterRestart`: called by `reactivateSubscription` (commerce SDK) after every
 *     successful restart, so the portal AND the journey mini-site behave the same (CEO rule
 *     2026-11-16: account management on both surfaces stays in sync). Swaps each affected line to
 *     the crisis's default swap through `subSwapVariant` (carries the locked price; a $0 line is
 *     re-applied), and records a `crisis_customer_actions` row with the original item and
 *     `auto_swap_back=true`.
 *   - Resolving the crisis (`POST /api/workspaces/[id]/crisis/[crisisId]` action=resolve) swaps every
 *     `auto_swap_back` row back to its original flavor — the promise the page made.
 *
 * The row is stamped `tier1_sent_at` + `current_tier=1` + `tier1_response='accepted_on_restart'` so
 * the daily crisis cron does not send a second "your flavor is out of stock" email: the customer
 * already saw the notice on the restart page.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";

type Admin = ReturnType<typeof createAdminClient>;

export type CrisisLineItem = {
  variant_id?: string | number;
  sku?: string;
  quantity?: number;
  title?: string;
  variant_title?: string;
  price_cents?: number;
  price_override_cents?: number;
};

export type CrisisRow = {
  id: string;
  name?: string | null;
  affected_variant_id: string;
  affected_sku: string | null;
  affected_product_title: string | null;
  default_swap_variant_id: string | null;
  default_swap_title: string | null;
  expected_restock_date: string | null;
};

export type CrisisSwapPlan = {
  crisisId: string;
  item: CrisisLineItem;
  /**
   * `swap` → replace the out-of-stock line with the crisis default swap (the historic behavior).
   * `hold` → the customer already told us they will NOT take the substitute and are waiting for
   * their original flavor, so the restart holds (pauses) the sub instead of swapping + charging.
   */
  action: "swap" | "hold";
  /** What the customer had, e.g. "Superfood Tabs — Strawberry Lemonade". */
  fromLabel: string;
  /** Crisis default swap (Shopify variant id as stored on crisis_events). */
  toVariantId: string;
  toLabel: string;
  /** Only set when the crisis's restock date is still in the future. */
  expectedRestock: string | null;
};

export type CrisisSwapResult = CrisisSwapPlan & { ok: boolean; error?: string };

/** The crisis_customer_actions fields that signal a customer is waiting for restock. */
export type CrisisWaitRow = {
  hold_for_restock?: boolean | null;
  tier1_response?: string | null;
  tier2_response?: string | null;
  tier3_response?: string | null;
};

/**
 * True when the customer declined the substitute and is waiting for their original flavor —
 * an explicit `hold_for_restock` flag (Phase 1), a `rejected` tier 1/2 response, or a tier 3
 * pause/remove. Such a customer must NOT be auto-swapped + charged on restart; the sub is held.
 */
export function customerIsWaitingForRestock(row: CrisisWaitRow | null | undefined): boolean {
  if (!row) return false;
  return row.hold_for_restock === true
    || row.tier1_response === "rejected"
    || row.tier2_response === "rejected"
    || row.tier3_response === "accepted_pause"
    || row.tier3_response === "accepted_remove";
}

/** Keys a crisis line can be matched by: the stored Shopify variant id, its UUID, and its SKU. */
export type CrisisMatchKeys = { variantKeys: Set<string>; sku: string };

/** Pure matcher (shared with the crisis Auto-Swap route's rule). */
export function findCrisisLine<T extends CrisisLineItem>(items: T[], keys: CrisisMatchKeys): T | undefined {
  return items.find((i) =>
    keys.variantKeys.has(String(i.variant_id ?? ""))
    || (!!keys.sku && String(i.sku ?? "").toUpperCase() === keys.sku));
}

function itemLabel(i: CrisisLineItem, crisis: CrisisRow): string {
  if (i.title && i.variant_title) return `${i.title} — ${i.variant_title}`;
  return i.title || crisis.affected_product_title || "that flavor";
}

/** A restock date worth telling the customer: only one that hasn't passed. */
export function futureRestock(date: string | null | undefined, now: Date = new Date()): string | null {
  if (!date) return null;
  // Stored as a date ("2027-01-15") or a timestamp ("2027-01-15T06:00:00+00:00", midnight Central).
  const day = String(date).slice(0, 10);
  const t = Date.parse(`${day}T23:59:59Z`);
  return Number.isNaN(t) || t < now.getTime() ? null : day;
}

async function activeCrisesWithKeys(admin: Admin, workspaceId: string) {
  const { data } = await admin.from("crisis_events")
    .select("id, name, affected_variant_id, affected_sku, affected_product_title, default_swap_variant_id, default_swap_title, expected_restock_date")
    .eq("workspace_id", workspaceId)
    .eq("status", "active");
  const crises = ((data || []) as CrisisRow[]).filter((c) => !!c.default_swap_variant_id);
  if (!crises.length) return [];
  const { resolveVariant } = await import("@/lib/internal-subscription");
  return Promise.all(crises.map(async (c) => {
    const resolved = await resolveVariant(workspaceId, String(c.affected_variant_id));
    const keys: CrisisMatchKeys = {
      variantKeys: new Set([String(c.affected_variant_id), resolved?.id].filter(Boolean) as string[]),
      sku: String(c.affected_sku || resolved?.sku || "").toUpperCase(),
    };
    return { crisis: c, keys };
  }));
}

/**
 * Read-only: the swaps a restart of a sub with these items would make.
 * When `subscriptionId` is supplied, the existing crisis_customer_actions row for each
 * (crisis, subscription) is consulted: a customer who chose to wait (customerIsWaitingForRestock)
 * is given a `hold` plan instead of a `swap`, so the restart never charges them for the substitute.
 */
export async function crisisSwapsForItems(
  admin: Admin, workspaceId: string, items: unknown, subscriptionId?: string | null,
): Promise<CrisisSwapPlan[]> {
  const list = ((items as CrisisLineItem[] | null) || []);
  if (!list.length) return [];
  const plans: CrisisSwapPlan[] = [];
  for (const { crisis, keys } of await activeCrisesWithKeys(admin, workspaceId)) {
    const item = findCrisisLine(list, keys);
    if (!item) continue;
    let waiting = false;
    if (subscriptionId) {
      const { data: row } = await admin.from("crisis_customer_actions")
        .select("hold_for_restock, tier1_response, tier2_response, tier3_response")
        .eq("crisis_id", crisis.id).eq("subscription_id", subscriptionId).maybeSingle();
      waiting = customerIsWaitingForRestock(row as CrisisWaitRow | null);
    }
    plans.push({
      crisisId: crisis.id,
      item,
      action: waiting ? "hold" : "swap",
      fromLabel: itemLabel(item, crisis),
      toVariantId: String(crisis.default_swap_variant_id),
      toLabel: crisis.default_swap_title || "a similar flavor",
      expectedRestock: futureRestock(crisis.expected_restock_date),
    });
  }
  return plans;
}

/** Customer-facing sentence for the restart page, or null when nothing is out of stock. */
export function crisisNotice(plans: CrisisSwapPlan[]): string | null {
  if (!plans.length) return null;
  const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  return plans.map((p) =>
    p.action === "hold"
      ? `${p.fromLabel} is out of stock right now. As you asked, we'll hold your subscription and ship ${p.fromLabel} as soon as it's back`
        + (p.expectedRestock ? ` (expected ${fmt(p.expectedRestock)}).` : ".")
        + " You won't be charged until then."
      : `Heads up: ${p.fromLabel} is out of stock right now, so we'll send ${p.toLabel} instead and switch you back as soon as it's restocked`
        + (p.expectedRestock ? ` (expected ${fmt(p.expectedRestock)}).` : ".")).join(" ");
}

/**
 * After a successful restart: swap every crisis-affected line to its default swap and record the
 * crisis row with auto_swap_back=true. Never throws; each swap's outcome is returned so the caller
 * can note a failure for follow-up.
 */
export async function applyCrisisSwapsAfterRestart(
  workspaceId: string, contractId: string,
): Promise<CrisisSwapResult[]> {
  const admin = createAdminClient();
  const { data: sub } = await admin.from("subscriptions")
    .select("id, customer_id, items")
    .eq("workspace_id", workspaceId).eq("shopify_contract_id", contractId).maybeSingle();
  if (!sub) return [];
  const items = ((sub.items as CrisisLineItem[] | null) || []);
  const plans = await crisisSwapsForItems(admin, workspaceId, items, sub.id);
  if (!plans.length) return [];

  const { subSwapVariant, subUpdateLineItemPrice } = await import("@/lib/subscription-items");
  const { subscriptionAction } = await import("@/lib/commerce/subscription");
  const results: CrisisSwapResult[] = [];
  let paused = false; // a single hold pauses the whole sub; don't re-pause for each held line
  for (const plan of plans) {
    try {
      // ── Hold: the customer chose to wait. Never swap + charge; pause the sub and let the
      // crisis Resolve rail (which resumes paused_at + auto_resume rows) bring it back with
      // the original flavor. The existing row's tier responses / original_item / hold_for_restock
      // are preserved — we only stamp the pause.
      if (plan.action === "hold") {
        const pauseRes = paused
          ? { success: true as const }
          : await subscriptionAction(workspaceId, contractId, "pause", "Crisis — customer chose to wait for restock");
        if (!pauseRes.success) {
          results.push({ ...plan, ok: false, error: pauseRes.error || "pause failed" });
          continue;
        }
        paused = true;
        const now = new Date().toISOString();
        const { data: existing } = await admin.from("crisis_customer_actions")
          .select("id").eq("crisis_id", plan.crisisId).eq("subscription_id", sub.id).maybeSingle();
        if (existing) {
          const { error } = await admin.from("crisis_customer_actions")
            .update({ paused_at: now, auto_resume: true, updated_at: now })
            .eq("id", existing.id);
          results.push(error
            ? { ...plan, ok: true, error: `held, but crisis row not updated: ${error.message}` }
            : { ...plan, ok: true });
        } else {
          // Defensive: a hold plan is derived from an existing row, so this is unexpected.
          results.push({ ...plan, ok: true, error: "held, but no crisis row found to stamp paused_at/auto_resume" });
        }
        continue;
      }

      const qty = Math.max(1, Number(plan.item.quantity ?? 1));
      const swap = await subSwapVariant(workspaceId, contractId, String(plan.item.variant_id), plan.toVariantId, qty);
      if (!swap.success) {
        results.push({ ...plan, ok: false, error: swap.error || "swap failed" });
        continue;
      }
      // The swap only carries positive price locks; a $0 line is re-applied (same as Auto-Swap).
      if (plan.item.price_override_cents === 0) {
        await subUpdateLineItemPrice(workspaceId, contractId, plan.toVariantId, 0, swap.newLineGid);
      }

      const others = items.filter((i) => i !== plan.item
        && !/shipping protection|insure/i.test(`${i.title ?? ""} ${i.sku ?? ""}`));
      const now = new Date().toISOString();
      // A prior crisis row for this sub (e.g. it was enrolled, then cancelled) is re-used — but
      // only the swap-tracking fields are touched; existing tier responses / original_item are
      // never reset, so a row that recorded the customer's earlier choices stays intact.
      const { data: existing } = await admin.from("crisis_customer_actions")
        .select("id").eq("crisis_id", plan.crisisId).eq("subscription_id", sub.id).maybeSingle();
      const updateRow = {
        tier1_swapped_to: { variantId: plan.toVariantId, title: plan.toLabel },
        auto_swap_back: true,
        updated_at: now,
      };
      const insertRow = {
        segment: others.length === 0 ? "berry_only" : "berry_plus",
        original_item: plan.item,
        current_tier: 1,
        tier1_sent_at: now,
        tier1_response: "accepted_on_restart",
        ...updateRow,
        cancelled: false,
      };
      const save = (dropSwapBack: boolean) => {
        if (existing) {
          const { auto_swap_back: sb, ...restU } = updateRow;
          return admin.from("crisis_customer_actions")
            .update(dropSwapBack ? restU : { ...restU, auto_swap_back: sb }).eq("id", existing.id);
        }
        const { auto_swap_back: sb, ...restI } = insertRow;
        return admin.from("crisis_customer_actions").insert({
          ...(dropSwapBack ? restI : { ...restI, auto_swap_back: sb }),
          crisis_id: plan.crisisId,
          workspace_id: workspaceId,
          subscription_id: sub.id,
          customer_id: sub.customer_id,
        });
      };
      let write = await save(false);
      if (write.error && /auto_swap_back/.test(write.error.message)) {
        // Code can deploy before the 30-min migration timer adds the column: keep the crisis row
        // (no second OOS email, original item kept) and flag the missing swap-back for follow-up.
        const retry = await save(true);
        write = retry.error ? retry : { ...retry, error: { message: "auto_swap_back column not live yet — set it on this row" } as never };
      }
      results.push(write.error
        ? { ...plan, ok: true, error: `swapped, but crisis row not recorded: ${write.error.message}` }
        : { ...plan, ok: true });
    } catch (e) {
      results.push({ ...plan, ok: false, error: errText(e) });
    }
  }
  return results;
}

/** One-line internal note for a ticket / portal log. */
export function crisisSwapNote(results: CrisisSwapResult[]): string | null {
  if (!results.length) return null;
  return results.map((r) => {
    if (r.action === "hold") {
      return r.ok && !r.error
        ? `Held for restock (customer chose to wait): ${r.fromLabel}; resumes automatically when the crisis is resolved.`
        : r.ok
          ? `Held for restock (customer chose to wait): ${r.fromLabel}, ⚠ ${r.error}`
          : `⚠ Could NOT hold ${r.fromLabel} for restock (${r.error}) — pause it by hand so the customer isn't charged for the substitute.`;
    }
    return r.ok && !r.error
      ? `Out of stock: swapped ${r.fromLabel} → ${r.toLabel}; switches back automatically when the crisis is resolved.`
      : r.ok
        ? `Out of stock: swapped ${r.fromLabel} → ${r.toLabel}, ⚠ ${r.error} — add the crisis row by hand so it switches back.`
        : `⚠ Out of stock: ${r.fromLabel} could NOT be swapped to ${r.toLabel} (${r.error}). It will bill as-is — swap it by hand.`;
  }).join(" ");
}
