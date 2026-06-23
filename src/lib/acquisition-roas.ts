// Acquisition-ROAS — the core metric of the Growth director's measurement spine
// (docs/brain/specs/growth-acquisition-roas-spine.md Phase 3). It composes the two non-renewal
// revenue resolvers (on-site + Amazon) over a linked-product group's spend on its mapped Meta ad
// account(s):
//
//   AcqROAS(group, window) = Σ non-renewal sales {Shopify+internal, Amazon}  ÷  Σ mapped Meta spend
//
// This is the proxy/tool the Growth agent reasons on — NOT the objective. The agent owns profitable
// new-customer acquisition and supervises this metric (CLAUDE.md § North star). The mapping
// (product_ad_account_mappings) removes the old coffee → 'd6d619a5' hardcode and carries the versioned
// attribution assumptions + the shared-account spend split, surfaced on every result.
//
// Phase 4 (the CEO-mode report contract) consumes computeAcqROAS — this module stops at the metric.

import { createAdminClient } from "@/lib/supabase/admin";
import { getShopifyInternalNonRenewalRevenue } from "@/lib/shopify-internal-revenue";
import { getAmazonNonRenewalRevenue } from "@/lib/amazon/per-product-revenue";

// ── The mapping: linked-group → Meta ad account(s) ──────────────────────────────
export interface ProductAdAccountMapping {
  id: string;
  groupId: string;
  metaAdAccountRowId: string;   // meta_ad_accounts.id (UUID — internal join)
  metaAccountId: string | null; // meta_ad_accounts.meta_account_id (Meta's id, e.g. 'd6d619a5')
  metaAccountName: string | null;
  spendShare: number;           // 0 < share ≤ 1 — fraction of the account's spend charged to this group
  isSharedAccount: boolean;     // account serves >1 group; with share 1.0 the metric is a floor
  creditAmazonToMeta: boolean;  // include the Amazon halo in the numerator
  countAllNonRenewal: boolean;  // count every non-renewal on-site sale, not just utm_source=meta
  notes: string | null;
}

interface MappingRow {
  id: string;
  group_id: string;
  meta_ad_account_id: string;
  spend_share: number | string;
  is_shared_account: boolean;
  credit_amazon_to_meta: boolean;
  count_all_non_renewal: boolean;
  notes: string | null;
  meta_ad_accounts: { meta_account_id: string | null; meta_account_name: string | null } | null;
}

// Load the mapping rows for a linked-product group (joined to the ad-account identity).
export async function getProductAdAccountMapping(params: {
  workspaceId: string;
  groupId: string;
}): Promise<ProductAdAccountMapping[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("product_ad_account_mappings")
    .select(
      "id, group_id, meta_ad_account_id, spend_share, is_shared_account, credit_amazon_to_meta, count_all_non_renewal, notes, meta_ad_accounts(meta_account_id, meta_account_name)",
    )
    .eq("workspace_id", params.workspaceId)
    .eq("group_id", params.groupId);

  return ((data || []) as unknown as MappingRow[]).map((r) => ({
    id: r.id,
    groupId: r.group_id,
    metaAdAccountRowId: r.meta_ad_account_id,
    metaAccountId: r.meta_ad_accounts?.meta_account_id ?? null,
    metaAccountName: r.meta_ad_accounts?.meta_account_name ?? null,
    spendShare: Number(r.spend_share),
    isSharedAccount: r.is_shared_account,
    creditAmazonToMeta: r.credit_amazon_to_meta,
    countAllNonRenewal: r.count_all_non_renewal,
    notes: r.notes,
  }));
}

// ── The metric ──────────────────────────────────────────────────────────────────
export interface AcqRoasAccount {
  metaAdAccountRowId: string;
  metaAccountId: string | null;
  metaAccountName: string | null;
  rawSpendCents: number;        // the account's total Meta spend in the window
  spendShare: number;
  attributedSpendCents: number; // rawSpendCents × spendShare (the denominator contribution)
  isSharedAccount: boolean;
}

export interface AcqRoasResult {
  workspaceId: string;
  groupId: string;
  groupName: string | null;
  startDate: string;
  endDate: string;
  productIds: string[];
  /** (onsite + amazon) / spend. null when there is no mapped spend or no mapping. */
  acqRoas: number | null;
  numeratorCents: number;
  channelSplit: { onsiteCents: number; amazonCents: number; spendCents: number };
  /** Amazon ÷ on-site — how much the Amazon halo amplifies measured efficiency. null when onsite=0. */
  haloRatio: number | null;
  accounts: AcqRoasAccount[];
  assumptions: {
    creditAmazonToMeta: boolean;
    countAllNonRenewal: boolean;
    /** A mapped account is shared (serves >1 line) at spend_share 1.0 → AcqROAS is a conservative floor. */
    sharedAccountFloor: boolean;
  };
  /** Human-readable caveats to surface on the report (shared-account floor, no mapping, …). */
  flags: string[];
}

// Resolve the linked-group's product_ids from product_link_members.
async function getGroupProductIds(groupId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("product_link_members")
    .select("product_id")
    .eq("group_id", groupId);
  return (data || []).map((r) => r.product_id as string).filter(Boolean);
}

// Compute AcqROAS for a linked-product group over [startDate, endDate] (inclusive, Central-time
// YYYY-MM-DD — matching the ROAS dashboard's snapshot boundaries).
export async function computeAcqROAS(params: {
  workspaceId: string;
  groupId: string;
  startDate: string;
  endDate: string;
}): Promise<AcqRoasResult> {
  const admin = createAdminClient();
  const { workspaceId, groupId, startDate, endDate } = params;

  const [{ data: groupRow }, mapping, productIds] = await Promise.all([
    admin.from("product_link_groups").select("name").eq("id", groupId).maybeSingle(),
    getProductAdAccountMapping({ workspaceId, groupId }),
    getGroupProductIds(groupId),
  ]);

  const flags: string[] = [];
  // Group-level assumptions live on the mapping rows (uniform per group); default to the spec baseline.
  const creditAmazonToMeta = mapping.length ? mapping.every((m) => m.creditAmazonToMeta) : true;
  const countAllNonRenewal = mapping.length ? mapping.every((m) => m.countAllNonRenewal) : true;

  // ── Numerator: non-renewal revenue across channels ──
  const [onsite, amazon] = await Promise.all([
    getShopifyInternalNonRenewalRevenue({
      workspaceId, productIds, startDate, endDate, metaOnlyUtm: !countAllNonRenewal,
    }),
    creditAmazonToMeta
      ? getAmazonNonRenewalRevenue({ workspaceId, productIds, startDate, endDate })
      : Promise.resolve({ grossCents: 0, netCents: 0, orderCount: 0, units: 0, byProduct: {} }),
  ]);
  const onsiteCents = onsite.grossCents;
  const amazonCents = creditAmazonToMeta ? amazon.grossCents : 0;
  const numeratorCents = onsiteCents + amazonCents;

  // ── Denominator: mapped-account Meta spend, scaled by each account's spend_share ──
  const accounts: AcqRoasAccount[] = [];
  let spendCents = 0;
  for (const m of mapping) {
    const { data: spendRows } = await admin
      .from("daily_meta_ad_spend")
      .select("spend_cents")
      .eq("workspace_id", workspaceId)
      .eq("meta_ad_account_id", m.metaAdAccountRowId)
      .gte("snapshot_date", startDate)
      .lte("snapshot_date", endDate);
    const rawSpendCents = (spendRows || []).reduce((s, r) => s + (r.spend_cents || 0), 0);
    const attributedSpendCents = Math.round(rawSpendCents * m.spendShare);
    spendCents += attributedSpendCents;
    accounts.push({
      metaAdAccountRowId: m.metaAdAccountRowId,
      metaAccountId: m.metaAccountId,
      metaAccountName: m.metaAccountName,
      rawSpendCents,
      spendShare: m.spendShare,
      attributedSpendCents,
      isSharedAccount: m.isSharedAccount,
    });
  }

  if (!mapping.length) flags.push("no ad-account mapping for this group — AcqROAS cannot be computed");
  const sharedAccountFloor = mapping.some((m) => m.isSharedAccount && m.spendShare >= 1);
  if (sharedAccountFloor) {
    flags.push("shared account — AcqROAS is a conservative floor (denominator carries another product line's spend)");
  }
  if (mapping.length && spendCents === 0) flags.push("zero mapped Meta spend in window — AcqROAS undefined");

  const acqRoas = spendCents > 0 ? numeratorCents / spendCents : null;
  const haloRatio = onsiteCents > 0 ? amazonCents / onsiteCents : null;

  return {
    workspaceId,
    groupId,
    groupName: (groupRow?.name as string | undefined) ?? null,
    startDate,
    endDate,
    productIds,
    acqRoas,
    numeratorCents,
    channelSplit: { onsiteCents, amazonCents, spendCents },
    haloRatio,
    accounts,
    assumptions: { creditAmazonToMeta, countAllNonRenewal, sharedAccountFloor },
    flags,
  };
}
