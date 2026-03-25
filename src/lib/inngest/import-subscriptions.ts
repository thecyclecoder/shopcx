import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";

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

const BATCH_SIZE = 1000;

export const importSubscriptions = inngest.createFunction(
  {
    id: "import-subscriptions",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "import/subscriptions" }],
  },
  async ({ event, step }) => {
    const { workspace_id, job_id, file_path } = event.data as {
      workspace_id: string; job_id: string; file_path: string;
    };
    const admin = createAdminClient();

    async function updateJob(updates: Record<string, unknown>) {
      await admin.from("sync_jobs").update(updates).eq("id", job_id);
    }

    // Step 1: Count total subs (tiny return value)
    const totalSubs: number = await step.run("count", async () => {
      await updateJob({ status: "running", phase: "customers" });
      const { data: fileData } = await admin.storage.from("imports").download(file_path);
      if (!fileData) throw new Error("File not found");
      const text = await fileData.text();
      const lines = text.split("\n");
      const headers = parseCSVLine(lines[0]);
      const idIdx = headers.findIndex(h => h.trim().toLowerCase() === "id");
      const ids = new Set<string>();
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const row = parseCSVLine(lines[i]);
        if (row[idIdx]) ids.add(row[idIdx]);
      }
      await updateJob({ total_customers: ids.size });
      return ids.size;
    });

    // Step 2+: Process batches — each step re-downloads CSV, processes its slice
    const totalBatches = Math.ceil(totalSubs / BATCH_SIZE);
    let totalImported = 0;

    for (let bi = 0; bi < totalBatches; bi++) {
      const batchIdx = bi;

      const imported: number = await step.run(`batch-${batchIdx}`, async () => {
        const { data: fileData } = await admin.storage.from("imports").download(file_path);
        if (!fileData) return 0;
        const text = await fileData.text();
        const lines = text.split("\n");
        const headers = parseCSVLine(lines[0]);

        const col = (n: string) => headers.findIndex(h => h.trim().toLowerCase() === n.toLowerCase());
        const idIdx = col("ID"), statusIdx = col("Status"), emailIdx = col("Customer email");
        const intervalTypeIdx = col("Billing interval type"), intervalCountIdx = col("Billing interval count");
        const nextOrderIdx = col("Next order date"), lineTitleIdx = col("Line title");
        const lineSkuIdx = col("Line SKU"), lineQtyIdx = col("Line variant quantity");
        const linePriceIdx = col("Line variant price"), lineProductIdx = col("Line product ID");
        const lineVariantIdx = col("Line variant ID"), linePlanNameIdx = col("Line selling plan name");
        const shippingPriceIdx = col("Shipping Price");

        // Group rows by sub ID, get this batch's slice
        const subIds: string[] = [];
        const subRows = new Map<string, string[][]>();
        for (let i = 1; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          const row = parseCSVLine(lines[i]);
          const subId = row[idIdx];
          if (!subId) continue;
          if (!subRows.has(subId)) { subIds.push(subId); subRows.set(subId, []); }
          subRows.get(subId)!.push(row);
        }

        const batchSubIds = subIds.slice(batchIdx * BATCH_SIZE, (batchIdx + 1) * BATCH_SIZE);
        if (batchSubIds.length === 0) return 0;

        // Targeted customer lookup for this batch
        const emails = new Set<string>();
        for (const sid of batchSubIds) {
          const e = subRows.get(sid)![0][emailIdx]?.toLowerCase()?.trim();
          if (e) emails.add(e);
        }
        const custMap = new Map<string, string>();
        const emailArr = [...emails];
        for (let e = 0; e < emailArr.length; e += 100) {
          const { data: custs } = await admin.from("customers")
            .select("id, email").eq("workspace_id", workspace_id)
            .in("email", emailArr.slice(e, e + 100));
          for (const c of custs || []) { if (c.email) custMap.set(c.email.toLowerCase(), c.id); }
        }

        let count = 0;
        for (const subId of batchSubIds) {
          const rows = subRows.get(subId)!;
          const firstRow = rows[0];
          const email = firstRow[emailIdx]?.toLowerCase()?.trim();
          if (!email) continue;

          const customerId = custMap.get(email) || null;
          const rawStatus = firstRow[statusIdx]?.toLowerCase()?.trim();
          const status = rawStatus === "active" ? "active" : rawStatus === "paused" ? "paused" : "cancelled";

          const items = rows.map(row => ({
            title: row[lineTitleIdx]?.trim() || null,
            sku: row[lineSkuIdx]?.trim() || null,
            quantity: parseInt(row[lineQtyIdx]) || 1,
            price_cents: Math.round(parseFloat(row[linePriceIdx] || "0") * 100),
            product_id: row[lineProductIdx]?.trim() || null,
            variant_id: row[lineVariantIdx]?.trim() || null,
            selling_plan: row[linePlanNameIdx]?.trim() || null,
          })).filter(i => i.title);

          const { error } = await admin.from("subscriptions").upsert({
            workspace_id, customer_id: customerId, shopify_contract_id: subId,
            status,
            billing_interval: firstRow[intervalTypeIdx]?.toLowerCase()?.trim() || null,
            billing_interval_count: parseInt(firstRow[intervalCountIdx]) || null,
            next_billing_date: firstRow[nextOrderIdx]?.trim() || null,
            last_payment_status: status === "active" ? "succeeded" : null,
            items,
            delivery_price_cents: Math.round(parseFloat(firstRow[shippingPriceIdx] || "0") * 100),
            updated_at: new Date().toISOString(),
          }, { onConflict: "workspace_id,shopify_contract_id" });

          if (!error) count++;

          if (customerId) {
            const { data: subs } = await admin.from("subscriptions").select("status").eq("customer_id", customerId);
            const hasActive = subs?.some(s => s.status === "active");
            const hasPaused = subs?.some(s => s.status === "paused");
            await admin.from("customers").update({
              subscription_status: hasActive ? "active" : hasPaused ? "paused" : "cancelled",
            }).eq("id", customerId);
          }
        }

        await updateJob({ synced_customers: totalImported + count });
        return count;
      });

      totalImported += imported;
    }

    // Cleanup
    await step.run("complete", async () => {
      await admin.storage.from("imports").remove([file_path]);
      await updateJob({ status: "completed", synced_customers: totalImported, completed_at: new Date().toISOString() });
    });

    return { imported: totalImported };
  }
);
