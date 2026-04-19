import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { subSwapVariant, getLastOrderPrice, calcBasePrice, subUpdateLineItemPrice } from "@/lib/subscription-items";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; crisisId: string }> }
) {
  const { id: workspaceId, crisisId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin.from("workspace_members")
    .select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const honorGrandfathered = body.honor_grandfathered !== false; // default true

  // Load crisis
  const { data: crisis } = await admin.from("crisis_events").select("*").eq("id", crisisId).single();
  if (!crisis) return NextResponse.json({ error: "Crisis not found" }, { status: 404 });
  if (!crisis.default_swap_variant_id) return NextResponse.json({ error: "No default swap variant configured" }, { status: 400 });

  // Load all crisis customer actions that haven't been swapped yet
  const { data: actions } = await admin.from("crisis_customer_actions")
    .select("id, subscription_id, customer_id, segment, tier1_swapped_to")
    .eq("crisis_id", crisisId);

  // Load subscriptions for these actions
  const subIds = (actions || []).map(a => a.subscription_id).filter(Boolean);
  const { data: subs } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, items, status")
    .in("id", subIds)
    .in("status", ["active", "paused"]);

  const subMap = new Map((subs || []).map(s => [s.id, s]));

  let swapped = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const action of actions || []) {
    const sub = subMap.get(action.subscription_id);
    if (!sub) { skipped++; continue; }

    // Check if the affected variant is still on the sub
    const items = (sub.items as { variant_id?: string; sku?: string; quantity?: number }[]) || [];
    const affectedItem = items.find(i =>
      String(i.variant_id) === crisis.affected_variant_id ||
      (crisis.affected_sku && (i.sku || "").toUpperCase() === crisis.affected_sku.toUpperCase())
    );

    if (!affectedItem) {
      // Already swapped or item removed
      skipped++;
      continue;
    }

    try {
      // Swap the variant
      const result = await subSwapVariant(
        workspaceId,
        sub.shopify_contract_id,
        affectedItem.variant_id || crisis.affected_variant_id,
        crisis.default_swap_variant_id,
        affectedItem.quantity || 1,
      );

      if (!result.success) {
        failed++;
        errors.push(`${sub.shopify_contract_id}: ${result.error}`);
        continue;
      }

      // Preserve grandfathered pricing if enabled
      if (honorGrandfathered) {
        try {
          const lastPrice = await getLastOrderPrice(workspaceId, action.customer_id, affectedItem.sku || null, affectedItem.variant_id || null);
          if (lastPrice) {
            const basePriceCents = calcBasePrice(lastPrice, 25);
            // Check if it's actually grandfathered (below standard MSRP)
            const { data: products } = await admin.from("products").select("variants").eq("workspace_id", workspaceId);
            let standardPrice = 0;
            for (const p of products || []) {
              for (const v of (p.variants as { id?: string; price_cents?: number }[]) || []) {
                if (String(v.id) === crisis.default_swap_variant_id && v.price_cents) {
                  standardPrice = v.price_cents;
                }
              }
            }
            if (standardPrice && basePriceCents < standardPrice) {
              await subUpdateLineItemPrice(workspaceId, sub.shopify_contract_id, crisis.default_swap_variant_id, basePriceCents, result.newLineGid);
            }
          }
        } catch { /* price preservation is best-effort */ }
      }

      // Update crisis record — only set auto_readd, don't set tier1 fields (those are for journey responses)
      await admin.from("crisis_customer_actions").update({
        auto_readd: true,
        updated_at: new Date().toISOString(),
      }).eq("id", action.id);

      swapped++;
    } catch (e) {
      failed++;
      errors.push(`${sub.shopify_contract_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return NextResponse.json({
    success: true,
    swapped,
    skipped,
    failed,
    errors: errors.slice(0, 20),
    total: (actions || []).length,
  });
}
