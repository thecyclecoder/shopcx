import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 300;

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current); current = "";
    } else { current += char; }
  }
  result.push(current);
  return result;
}

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
  if (!file_path) return NextResponse.json({ error: "file_path required" }, { status: 400 });

  const { data: fileData, error: dlError } = await admin.storage.from("imports").download(file_path);
  if (dlError || !fileData) {
    return NextResponse.json({ error: "Failed to download file" }, { status: 500 });
  }

  const csvText = await fileData.text();
  const lines = csvText.split("\n");
  const headers = parseCSVLine(lines[0]);

  const col = (name: string) => headers.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const idIdx = col("ID");
  const statusIdx = col("Status");
  const emailIdx = col("Customer email");
  const intervalTypeIdx = col("Billing interval type");
  const intervalCountIdx = col("Billing interval count");
  const nextOrderIdx = col("Next order date");
  const lineTitleIdx = col("Line title");
  const lineSkuIdx = col("Line SKU");
  const lineQtyIdx = col("Line variant quantity");
  const linePriceIdx = col("Line variant price");
  const lineProductIdx = col("Line product ID");
  const lineVariantIdx = col("Line variant ID");
  const linePlanNameIdx = col("Line selling plan name");
  const shippingPriceIdx = col("Shipping Price");

  // Group rows by subscription ID
  const subsMap = new Map<string, string[][]>();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const row = parseCSVLine(lines[i]);
    const subId = row[idIdx];
    if (!subId) continue;
    if (!subsMap.has(subId)) subsMap.set(subId, []);
    subsMap.get(subId)!.push(row);
  }

  const allSubIds = [...subsMap.keys()];
  let imported = 0;
  let skipped = 0;

  for (let i = 0; i < allSubIds.length; i += 500) {
    const batchIds = allSubIds.slice(i, i + 500);

    const batchEmails = new Set<string>();
    for (const subId of batchIds) {
      const email = subsMap.get(subId)![0][emailIdx]?.toLowerCase()?.trim();
      if (email) batchEmails.add(email);
    }

    // Targeted customer lookup
    const custMap = new Map<string, string>();
    const emailArr = [...batchEmails];
    for (let e = 0; e < emailArr.length; e += 100) {
      const { data: custs } = await admin.from("customers")
        .select("id, email").eq("workspace_id", workspaceId)
        .in("email", emailArr.slice(e, e + 100));
      for (const c of custs || []) {
        if (c.email) custMap.set(c.email.toLowerCase(), c.id);
      }
    }

    for (const subId of batchIds) {
      const rows = subsMap.get(subId)!;
      const firstRow = rows[0];
      const email = firstRow[emailIdx]?.toLowerCase()?.trim();
      if (!email) { skipped++; continue; }

      const customerId = custMap.get(email) || null;
      const rawStatus = firstRow[statusIdx]?.toLowerCase()?.trim();
      const status = rawStatus === "active" ? "active" : rawStatus === "paused" ? "paused" : "cancelled";

      const items = rows.map((row) => ({
        title: row[lineTitleIdx]?.trim() || null,
        sku: row[lineSkuIdx]?.trim() || null,
        quantity: parseInt(row[lineQtyIdx]) || 1,
        price_cents: Math.round(parseFloat(row[linePriceIdx] || "0") * 100),
        product_id: row[lineProductIdx]?.trim() || null,
        variant_id: row[lineVariantIdx]?.trim() || null,
        selling_plan: row[linePlanNameIdx]?.trim() || null,
      })).filter((item) => item.title);

      const { error } = await admin.from("subscriptions").upsert({
        workspace_id: workspaceId,
        customer_id: customerId,
        shopify_contract_id: subId,
        status,
        billing_interval: firstRow[intervalTypeIdx]?.toLowerCase()?.trim() || null,
        billing_interval_count: parseInt(firstRow[intervalCountIdx]) || null,
        next_billing_date: firstRow[nextOrderIdx]?.trim() || null,
        last_payment_status: status === "active" ? "succeeded" : null,
        items,
        delivery_price_cents: Math.round(parseFloat(firstRow[shippingPriceIdx] || "0") * 100),
        updated_at: new Date().toISOString(),
      }, { onConflict: "workspace_id,shopify_contract_id" });

      if (!error) imported++;
      else skipped++;
    }

    // Update customer subscription statuses
    for (const email of batchEmails) {
      const cid = custMap.get(email);
      if (!cid) continue;
      const { data: allSubs } = await admin.from("subscriptions").select("status").eq("customer_id", cid);
      const hasActive = allSubs?.some((s) => s.status === "active");
      const hasPaused = allSubs?.some((s) => s.status === "paused");
      await admin.from("customers").update({
        subscription_status: hasActive ? "active" : hasPaused ? "paused" : "cancelled",
      }).eq("id", cid);
    }
  }

  // Cleanup
  await admin.storage.from("imports").remove([file_path]);

  return NextResponse.json({ imported, skipped, total: allSubIds.length });
}
