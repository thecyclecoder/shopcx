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
import type {
  LoyaltyView,
  LoyaltyRedemptionTierView,
  LoyaltyLedgerEntryView,
} from "./types";

export type { LoyaltyView, LoyaltyRedemptionTierView, LoyaltyLedgerEntryView } from "./types";

interface RawMemberRow {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  points_balance: number | null;
  points_earned: number | null;
  points_spent: number | null;
  source: string | null;
  needs_points_backfill: boolean | null;
}

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
 */
export async function getLoyaltyBalance(
  workspaceId: string,
  customerId: string,
): Promise<LoyaltyView> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("loyalty_members")
    .select(
      "id, workspace_id, customer_id, points_balance, points_earned, points_spent, source, needs_points_backfill",
    )
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
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
  const row = data as RawMemberRow;
  const balance = Number(row.points_balance ?? 0);
  return {
    member_id: row.id,
    workspace_id: row.workspace_id,
    customer_id: row.customer_id,
    points_balance: balance,
    points_earned: Number(row.points_earned ?? 0),
    points_spent: Number(row.points_spent ?? 0),
    dollar_value_cents: dollarValueFor(balance),
    redemption_tiers: tiersFor(balance),
    needs_points_backfill: Boolean(row.needs_points_backfill),
    source: (row.source ?? "native") as LoyaltyView["source"],
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
 * `(created_at DESC, id DESC)`. Direct match on the customer's member row —
 * the caller supplies either a member id (fast) or a customer id (extra
 * round-trip to look up the member).
 */
export async function listLoyaltyLedger(
  workspaceId: string,
  filters: LoyaltyLedgerFilters = {},
): Promise<LoyaltyLedgerEntryView[]> {
  const admin = createAdminClient();
  let memberId: string | undefined = filters.member_id;
  if (!memberId && filters.customer_id) {
    const { data: mem } = await admin
      .from("loyalty_members")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", filters.customer_id)
      .maybeSingle();
    memberId = (mem?.id as string | undefined) ?? undefined;
    if (!memberId) return [];
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
    if (memberId) q = q.eq("member_id", memberId);
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
