/**
 * commerce/loyalty.ts — Display ops for loyalty.
 *
 * `getLoyaltyBalance` reads the [[../../docs/brain/tables/loyalty_members]]
 * row (with an implicit dollar-value roll-up + redemption tiers);
 * `listLoyaltyLedger` walks the append-only
 * [[../../docs/brain/tables/loyalty_transactions]] ledger, cursor-paginated
 * past the 1000-row cap. See [[../../docs/brain/libraries/loyalty]].
 *
 * Ships with zero call-site consumers — the M3 harness compares parity before
 * any surface migrates.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getMemberByCustomerId, getMembersInLinkGroup } from "@/lib/loyalty";
import type {
  LoyaltyView,
  LoyaltyRedemptionTierView,
  LoyaltyLedgerEntryView,
} from "./types";

export type { LoyaltyView, LoyaltyRedemptionTierView, LoyaltyLedgerEntryView } from "./types";

interface RawLedgerRow {
  id: string;
  member_id: string;
  workspace_id: string;
  points_change: number | null;
  type: string | null;
  description: string | null;
  order_id: string | null;
  shopify_discount_id: string | null;
  created_at: string;
}

const DEFAULT_REDEMPTION_TIERS: LoyaltyRedemptionTierView[] = [
  { points: 500, value_cents: 500, label: "$5 off" },
  { points: 1000, value_cents: 1000, label: "$10 off" },
  { points: 2500, value_cents: 2500, label: "$25 off" },
];

function tiersFor(points: number): LoyaltyRedemptionTierView[] {
  return DEFAULT_REDEMPTION_TIERS.filter((t) => t.points <= points);
}

/** Convert a per-customer balance to its dollar value at 100 pts = $1. */
function dollarValueFor(points: number): number {
  return points;
}

/**
 * Fetch the loyalty balance for one customer, hydrated with redemption tiers
 * they qualify for and their dollar value. Returns an empty (zero-balance)
 * view when the customer is not enrolled.
 *
 * Routes through the [[../../docs/brain/libraries/loyalty]] SDK chokepoint —
 * `getMemberByCustomerId` expands the link group and SUMS `points_balance`
 * across every sibling member row (spec: loyalty-coupon-apply-resolves-
 * contract-owning-member-no-doomed-regen Phase 3). The prior raw
 * `.eq('customer_id', customerId).maybeSingle()` bypassed the aggregation
 * and reported zero for a profile whose sibling held the balance —
 * Sandra's fingerprint (ticket 2b7ea029).
 */
export async function getLoyaltyBalance(
  workspaceId: string,
  customerId: string,
): Promise<LoyaltyView> {
  const member = await getMemberByCustomerId(workspaceId, customerId);
  if (!member) {
    return {
      member_id: "",
      workspace_id: workspaceId,
      customer_id: customerId,
      points_balance: 0,
      points_earned: 0,
      points_spent: 0,
      dollar_value_cents: 0,
      redemption_tiers: [],
      needs_points_backfill: false,
      source: "native",
    };
  }
  // The SDK's SELECT * returns `needs_points_backfill` even though the typed
  // shape omits it — read defensively.
  const needsBackfill = Boolean(
    (member as { needs_points_backfill?: boolean | null }).needs_points_backfill,
  );
  const balance = Number(member.points_balance ?? 0);
  return {
    member_id: member.id,
    workspace_id: member.workspace_id,
    customer_id: member.customer_id,
    points_balance: balance,
    points_earned: Number(member.points_earned ?? 0),
    points_spent: Number(member.points_spent ?? 0),
    dollar_value_cents: dollarValueFor(balance),
    redemption_tiers: tiersFor(balance),
    needs_points_backfill: needsBackfill,
    source: (member.source ?? "native") as LoyaltyView["source"],
  };
}

export interface LoyaltyLedgerFilters {
  member_id?: string;
  customer_id?: string;
  type?: string;
  page_size?: number;
  max_rows?: number;
}

/**
 * Walk one customer's loyalty ledger, cursor-paginated on
 * `(created_at DESC, id DESC)`. When the caller supplies a `member_id` the
 * walk is scoped to that single row; a `customer_id` expands via the
 * [[../../docs/brain/libraries/loyalty]] SDK chokepoint `getMembersInLinkGroup`
 * so transactions on sibling member rows are included (spec:
 * loyalty-coupon-apply-resolves-contract-owning-member-no-doomed-regen
 * Phase 3). The prior raw `.eq('customer_id', customerId).maybeSingle()`
 * missed the linked-siblings walk entirely — a linked customer whose
 * transactions lived on a sibling row saw an empty ledger.
 */
export async function listLoyaltyLedger(
  workspaceId: string,
  filters: LoyaltyLedgerFilters = {},
): Promise<LoyaltyLedgerEntryView[]> {
  const admin = createAdminClient();
  let memberIds: string[] | undefined;
  if (filters.member_id) {
    memberIds = [filters.member_id];
  } else if (filters.customer_id) {
    const members = await getMembersInLinkGroup(workspaceId, filters.customer_id);
    memberIds = members.map((m) => m.id).filter((id): id is string => Boolean(id));
    if (memberIds.length === 0) return [];
  }

  const pageSize = Math.max(1, Math.min(1000, filters.page_size ?? 500));
  const maxRows = filters.max_rows ?? Number.POSITIVE_INFINITY;

  const out: LoyaltyLedgerEntryView[] = [];
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;

  while (out.length < maxRows) {
    let q = admin
      .from("loyalty_transactions")
      .select(
        "id, member_id, workspace_id, points_change, type, description, order_id, shopify_discount_id, created_at",
      )
      .eq("workspace_id", workspaceId);
    if (memberIds && memberIds.length === 1) {
      q = q.eq("member_id", memberIds[0]);
    } else if (memberIds && memberIds.length > 1) {
      q = q.in("member_id", memberIds);
    }
    if (filters.type) q = q.eq("type", filters.type);
    if (cursorCreatedAt && cursorId) {
      q = q.or(
        `created_at.lt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.lt.${cursorId})`,
      );
    }
    q = q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(pageSize);

    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as RawLedgerRow[];
    if (rows.length === 0) break;
    for (const r of rows) {
      if (out.length >= maxRows) break;
      out.push({
        id: r.id,
        member_id: r.member_id,
        workspace_id: r.workspace_id,
        points_change: Number(r.points_change ?? 0),
        type: r.type ?? "",
        description: r.description,
        order_id: r.order_id,
        shopify_discount_id: r.shopify_discount_id,
        created_at: r.created_at,
      });
    }
    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1];
    cursorCreatedAt = last.created_at;
    cursorId = last.id;
  }

  return out;
}
