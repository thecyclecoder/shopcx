import { NextResponse } from "next/server";
import { errText } from "@/lib/error-text";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { subSwapVariant, subUpdateLineItemPrice } from "@/lib/subscription-items";
import { resolveVariant } from "@/lib/internal-subscription";

export const maxDuration = 300;

type Item = {
  variant_id?: string;
  sku?: string;
  quantity?: number;
  title?: string;
  variant_title?: string;
  product_id?: string;
  price_cents?: number;
  price_override_cents?: number;
};

const SCAN_PAGE = 500;
const DEFAULT_BATCH = 15;

/**
 * Start Auto-Swap — enrol + swap every live subscription carrying the crisis item, in batches.
 *
 * The dashboard calls this repeatedly, passing back `next_cursor`, until `done` is true. Each call
 * scans active/paused subs ordered by id after the cursor, and for up to `batch_size` of them that
 * still carry the affected item:
 *   1. ENROL: create the crisis_customer_actions row if missing (original_item = the affected line,
 *      tier1_sent_at left null so the daily campaign emails them inside the lead window).
 *   2. SWAP: subSwapVariant to the default swap. The swap itself carries the line's locked price
 *      across (internal + Appstle rails both capture the outgoing realized price). A $0 free line is
 *      the one case the swap does not carry (it only preserves positive locks), so we re-apply 0.
 *
 * Previously this only walked EXISTING action rows (nothing enrolled the affected subs, so it swapped
 * ~nothing) and re-priced from "last order price ÷ 0.75", which could overwrite the price the swap
 * had already preserved — the July 2026 Strawberry Lemonade mispricing class. Both removed.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; crisisId: string }> }
) {
  const { id: workspaceId, crisisId } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin.from("workspace_members")
    .select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const cursor: string | null = typeof body.cursor === "string" ? body.cursor : null;
  const batchSize = Math.min(Math.max(Number(body.batch_size) || DEFAULT_BATCH, 1), 50);

  const { data: crisis } = await admin.from("crisis_events")
    .select("*").eq("id", crisisId).eq("workspace_id", workspaceId).single();
  if (!crisis) return NextResponse.json({ error: "Crisis not found" }, { status: 404 });
  if (crisis.status !== "active") return NextResponse.json({ error: "Crisis must be active" }, { status: 400 });
  if (!crisis.default_swap_variant_id) return NextResponse.json({ error: "No default swap variant configured" }, { status: 400 });

  // The crisis stores the Shopify variant id; internal subs store the canonical UUID. Match either.
  const resolvedAffected = await resolveVariant(workspaceId, String(crisis.affected_variant_id));
  const affectedKeys = new Set([String(crisis.affected_variant_id), resolvedAffected?.id].filter(Boolean) as string[]);
  const affectedSku = (crisis.affected_sku || resolvedAffected?.sku || "").toUpperCase();
  const findAffected = (items: Item[]) => items.find(i =>
    affectedKeys.has(String(i.variant_id)) || (!!affectedSku && (i.sku || "").toUpperCase() === affectedSku));

  // Collect up to batchSize affected subs after the cursor.
  const batch: { id: string; customer_id: string; shopify_contract_id: string; items: Item[] }[] = [];
  let scanCursor = cursor;
  let exhausted = false;
  while (batch.length < batchSize) {
    let q = admin.from("subscriptions")
      .select("id, customer_id, shopify_contract_id, items")
      .eq("workspace_id", workspaceId)
      .in("status", ["active", "paused"])
      .order("id")
      .limit(SCAN_PAGE);
    if (scanCursor) q = q.gt("id", scanCursor);
    const { data: page, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const rows = page || [];
    let consumed = 0;
    for (const s of rows) {
      scanCursor = s.id;
      consumed++;
      if (findAffected((s.items as Item[]) || [])) {
        batch.push(s as typeof batch[number]);
        if (batch.length >= batchSize) break;
      }
    }
    // The last page, fully read: nothing left after the cursor.
    if (rows.length < SCAN_PAGE && consumed === rows.length) { exhausted = true; break; }
  }

  let swapped = 0;
  let enrolled = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const sub of batch) {
    const items = sub.items || [];
    const affectedItem = findAffected(items)!;
    try {
      const { data: existing } = await admin.from("crisis_customer_actions")
        .select("id").eq("crisis_id", crisisId).eq("subscription_id", sub.id).maybeSingle();
      let actionId = existing?.id as string | undefined;
      if (!actionId) {
        // Shipping protection isn't a real item for segmenting (same rule as the test route).
        const otherItems = items.filter(i => i !== affectedItem
          && !(i.title || "").toLowerCase().includes("shipping protection")
          && !(i.title || "").toLowerCase().includes("insure"));
        const { data: inserted, error: insErr } = await admin.from("crisis_customer_actions").insert({
          crisis_id: crisisId,
          workspace_id: workspaceId,
          subscription_id: sub.id,
          customer_id: sub.customer_id,
          segment: otherItems.length === 0 ? "berry_only" : "berry_plus",
          original_item: affectedItem,
          current_tier: 0,
          tier1_swapped_to: { variantId: crisis.default_swap_variant_id, title: crisis.default_swap_title || "default swap" },
        }).select("id").single();
        if (insErr || !inserted) throw new Error(`enrol failed: ${insErr?.message || "no row"}`);
        actionId = inserted.id;
        enrolled++;
      }

      const result = await subSwapVariant(
        workspaceId,
        sub.shopify_contract_id,
        String(affectedItem.variant_id || crisis.affected_variant_id),
        String(crisis.default_swap_variant_id),
        affectedItem.quantity || 1,
      );
      if (!result.success) {
        failed++;
        errors.push(`${sub.shopify_contract_id}: ${result.error}`);
        continue;
      }

      // A free ($0) line isn't carried by the swap (it only preserves positive locks). Re-apply it.
      if (affectedItem.price_override_cents === 0) {
        await subUpdateLineItemPrice(workspaceId, sub.shopify_contract_id, String(crisis.default_swap_variant_id), 0, result.newLineGid);
      }

      await admin.from("crisis_customer_actions").update({
        auto_readd: true,
        updated_at: new Date().toISOString(),
      }).eq("id", actionId);
      swapped++;
    } catch (e) {
      failed++;
      errors.push(`${sub.shopify_contract_id}: ${errText(e)}`);
    }
  }

  return NextResponse.json({
    success: true,
    processed: batch.length,
    enrolled,
    swapped,
    failed,
    errors: errors.slice(0, 20),
    next_cursor: scanCursor,
    done: exhausted,
  });
}
