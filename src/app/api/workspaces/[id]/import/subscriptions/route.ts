import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 300; // 5 min for large CSVs

// POST: process an uploaded subscription CSV from Supabase Storage
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { file_path } = body;

  if (!file_path) {
    return NextResponse.json({ error: "file_path required" }, { status: 400 });
  }

  // Download file from Supabase Storage
  const { data: fileData, error: downloadError } = await admin.storage
    .from("imports")
    .download(file_path);

  if (downloadError || !fileData) {
    return NextResponse.json({ error: "Failed to download file" }, { status: 500 });
  }

  const csvText = await fileData.text();
  const lines = csvText.split("\n");
  const headers = parseCSVLine(lines[0]);

  // Find column indices
  const col = (name: string) => headers.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());

  const idIdx = col("ID");
  const statusIdx = col("Status");
  const emailIdx = col("Customer email");
  const nameIdx = col("Customer name");
  const phoneIdx = col("Customer phone");
  const createdIdx = col("Created at");
  const nextOrderIdx = col("Next order date");
  const intervalTypeIdx = col("Billing interval type");
  const intervalCountIdx = col("Billing interval count");
  const lineTitleIdx = col("Line title");
  const lineSkuIdx = col("Line SKU");
  const lineQtyIdx = col("Line variant quantity");
  const linePriceIdx = col("Line variant price");
  const lineProductIdx = col("Line product ID");
  const lineVariantIdx = col("Line variant ID");
  const linePlanNameIdx = col("Line selling plan name");
  const totalOrdersIdx = col("Total orders till date / Current Billing cycle");
  const totalRevenueIdx = headers.findIndex((h) => h.trim().startsWith("Total revenue generated"));
  const cancellationDateIdx = col("Cancellation date");
  const cancellationReasonIdx = col("Cancellation reason");
  const pausedOnIdx = col("Paused on date");
  const paymentMethodIdx = col("Payment method");
  const paymentBrandIdx = col("Payment method brand");
  const paymentLastDigitsIdx = col("Payment method last digits");
  const shippingPriceIdx = col("Shipping Price");

  // Group rows by subscription ID (multi-line items)
  const subsMap = new Map<string, { rows: string[][]; }>();

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    const subId = row[idIdx];
    if (!subId) continue;

    if (!subsMap.has(subId)) {
      subsMap.set(subId, { rows: [] });
    }
    subsMap.get(subId)!.rows.push(row);
  }

  // Preload customer lookup (paginated at 1000)
  const emailToCustomerId = new Map<string, string>();
  let custOffset = 0;
  while (true) {
    const { data: batch } = await admin
      .from("customers")
      .select("id, email")
      .eq("workspace_id", workspaceId)
      .range(custOffset, custOffset + 999);
    if (!batch || batch.length === 0) break;
    for (const c of batch) {
      if (c.email) emailToCustomerId.set(c.email.toLowerCase(), c.id);
    }
    custOffset += batch.length;
    if (batch.length < 1000) break;
  }

  // Process each subscription
  let imported = 0;
  let skipped = 0;

  for (const [subId, sub] of subsMap) {
    const firstRow = sub.rows[0];
    const email = firstRow[emailIdx]?.toLowerCase()?.trim();
    if (!email) { skipped++; continue; }

    const customerId = emailToCustomerId.get(email) || null;

    // Map status
    const rawStatus = firstRow[statusIdx]?.toLowerCase()?.trim();
    const status = rawStatus === "active" ? "active"
      : rawStatus === "paused" ? "paused"
      : rawStatus === "cancelled" ? "cancelled"
      : rawStatus === "expired" ? "expired"
      : "cancelled";

    // Collect line items from all rows
    const items = sub.rows.map((row) => ({
      title: row[lineTitleIdx]?.trim() || null,
      sku: row[lineSkuIdx]?.trim() || null,
      quantity: parseInt(row[lineQtyIdx]) || 1,
      price_cents: Math.round(parseFloat(row[linePriceIdx] || "0") * 100),
      product_id: row[lineProductIdx]?.trim() || null,
      variant_id: row[lineVariantIdx]?.trim() || null,
      selling_plan: row[linePlanNameIdx]?.trim() || null,
    })).filter((item) => item.title);

    const deliveryPriceCents = Math.round(parseFloat(firstRow[shippingPriceIdx] || "0") * 100);

    const { error } = await admin.from("subscriptions").upsert(
      {
        workspace_id: workspaceId,
        customer_id: customerId,
        shopify_contract_id: subId,
        shopify_customer_id: null,
        status,
        billing_interval: firstRow[intervalTypeIdx]?.toLowerCase()?.trim() || null,
        billing_interval_count: parseInt(firstRow[intervalCountIdx]) || null,
        next_billing_date: firstRow[nextOrderIdx]?.trim() || null,
        last_payment_status: status === "active" ? "succeeded" : null,
        items,
        delivery_price_cents: deliveryPriceCents,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,shopify_contract_id" }
    );

    if (!error) {
      imported++;
    } else {
      console.error("Subscription upsert error:", error.message);
      skipped++;
    }

    // Update customer subscription_status
    if (customerId) {
      const { data: allSubs } = await admin
        .from("subscriptions")
        .select("status")
        .eq("customer_id", customerId);

      const hasActive = allSubs?.some((s) => s.status === "active");
      const hasPaused = allSubs?.some((s) => s.status === "paused");
      const overallStatus = hasActive ? "active" : hasPaused ? "paused" : "cancelled";

      await admin.from("customers").update({
        subscription_status: overallStatus,
        updated_at: new Date().toISOString(),
      }).eq("id", customerId);
    }
  }

  // Clean up uploaded file
  await admin.storage.from("imports").remove([file_path]);

  return NextResponse.json({
    imported,
    skipped,
    total_subscriptions: subsMap.size,
    total_rows: lines.length - 1,
  });
}

// Parse a CSV line handling quoted fields with commas
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}
