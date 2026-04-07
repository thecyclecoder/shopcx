import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAndCompleteReplacement } from "@/lib/shopify-draft-orders";
import { appstleSubscriptionAction } from "@/lib/appstle";

// GET — single replacement with related data
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; replacementId: string }> },
) {
  const { id: workspaceId, replacementId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: replacement } = await admin
    .from("replacements")
    .select("*, customers(id, first_name, last_name, email, phone, shopify_customer_id)")
    .eq("id", replacementId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!replacement) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(replacement);
}

// PATCH — update replacement (status, address, items, etc.)
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; replacementId: string }> },
) {
  const { id: workspaceId, replacementId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const body = await request.json();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = { updated_at: new Date().toISOString() };

  if ("status" in body) updates.status = body.status;
  if ("items" in body) updates.items = body.items;
  if ("validated_address" in body) {
    updates.validated_address = body.validated_address;
    updates.address_validated = true;
  }
  if ("reason_detail" in body) updates.reason_detail = body.reason_detail;

  const { data: replacement, error } = await admin
    .from("replacements")
    .update(updates)
    .eq("id", replacementId)
    .eq("workspace_id", workspaceId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(replacement);
}

// POST — action: create-draft, adjust-subscription
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; replacementId: string }> },
) {
  const { id: workspaceId, replacementId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const body = await request.json();
  const action = body.action;

  // Load replacement
  const { data: replacement } = await admin
    .from("replacements")
    .select("*, customers(id, first_name, last_name, email, phone, shopify_customer_id)")
    .eq("id", replacementId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!replacement) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // ── Create draft order ──
  if (action === "create-draft") {
    if (!replacement.items?.length) {
      return NextResponse.json({ error: "No items specified for replacement" }, { status: 400 });
    }
    if (!replacement.validated_address && !replacement.address_validated) {
      return NextResponse.json({ error: "Address must be validated before creating replacement" }, { status: 400 });
    }

    const address = replacement.validated_address as {
      name?: string; firstName?: string; lastName?: string;
      street1: string; street2?: string; city: string; state: string; zip: string; country: string; phone?: string;
    };

    const customer = replacement.customers as { first_name: string; last_name: string; email: string } | null;
    const firstName = address.firstName || customer?.first_name || "";
    const lastName = address.lastName || customer?.last_name || "";

    try {
      const result = await createAndCompleteReplacement(workspaceId, {
        lineItems: (replacement.items as { variantId: string; title: string; quantity: number }[]).map((item) => ({
          variantId: item.variantId,
          title: item.title,
          quantity: item.quantity,
        })),
        shippingAddress: {
          firstName,
          lastName,
          address1: address.street1,
          address2: address.street2 || undefined,
          city: address.city,
          province: address.state,
          zip: address.zip,
          country: address.country,
          phone: address.phone || undefined,
        },
        customerEmail: customer?.email || "",
        originalOrderNumber: replacement.original_order_number || "",
        reason: replacement.reason,
      });

      // Update replacement record
      await admin.from("replacements").update({
        shopify_draft_order_id: result.draftOrderId,
        shopify_replacement_order_id: result.shopifyOrderId,
        shopify_replacement_order_name: result.orderName,
        status: "created",
        updated_at: new Date().toISOString(),
      }).eq("id", replacementId);

      return NextResponse.json({
        success: true,
        order_name: result.orderName,
        order_id: result.shopifyOrderId,
      });
    } catch (err) {
      console.error("[replacements] Draft order creation failed:", err);
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to create replacement order" }, { status: 500 });
    }
  }

  // ── Adjust subscription next billing date ──
  if (action === "adjust-subscription") {
    if (!replacement.subscription_id) {
      return NextResponse.json({ error: "No subscription linked to this replacement" }, { status: 400 });
    }

    const { data: sub } = await admin
      .from("subscriptions")
      .select("shopify_contract_id, status, billing_interval, billing_interval_type")
      .eq("id", replacement.subscription_id)
      .single();

    if (!sub || sub.status !== "active") {
      return NextResponse.json({ error: "Subscription not active" }, { status: 400 });
    }

    // Calculate new date based on billing interval
    const interval = sub.billing_interval || 4;
    const intervalType = (sub.billing_interval_type || "WEEK").toUpperCase();
    const now = new Date();
    let newDate: Date;

    if (intervalType === "MONTH") {
      newDate = new Date(now);
      newDate.setMonth(newDate.getMonth() + interval);
    } else if (intervalType === "DAY") {
      newDate = new Date(now.getTime() + interval * 24 * 60 * 60 * 1000);
    } else {
      // Default: weeks
      newDate = new Date(now.getTime() + interval * 7 * 24 * 60 * 60 * 1000);
    }

    const newDateStr = newDate.toISOString().split("T")[0];

    // Update via Appstle
    try {
      const { appstleUpdateNextBillingDate } = await import("@/lib/appstle");
      await appstleUpdateNextBillingDate(workspaceId, sub.shopify_contract_id, newDateStr);

      // Update local
      await admin.from("subscriptions").update({
        next_billing_date: newDate.toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", replacement.subscription_id);

      await admin.from("replacements").update({
        subscription_adjusted: true,
        new_next_billing_date: newDate.toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", replacementId);

      return NextResponse.json({ success: true, new_next_billing_date: newDateStr });
    } catch (err) {
      console.error("[replacements] Subscription adjustment failed:", err);
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to adjust subscription" }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
