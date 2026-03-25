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
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

const CHUNK_SIZE = 500;

export const importSubscriptions = inngest.createFunction(
  {
    id: "import-subscriptions",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "import/subscriptions" }],
  },
  async ({ event, step }) => {
    const { workspace_id, job_id, file_path } = event.data as {
      workspace_id: string;
      job_id: string;
      file_path: string;
    };

    const admin = createAdminClient();

    async function updateJob(updates: Record<string, unknown>) {
      await admin.from("sync_jobs").update(updates).eq("id", job_id);
    }

    // Step 1: Count total subscriptions
    const totalSubs: number = await step.run("count-subs", async () => {
      await updateJob({ status: "running", phase: "customers" });

      const { data: fileData } = await admin.storage.from("imports").download(file_path);
      if (!fileData) throw new Error("Failed to download CSV");

      const csvText = await fileData.text();
      const lines = csvText.split("\n");
      const headers = parseCSVLine(lines[0]);
      const idIdx = headers.findIndex((h) => h.trim().toLowerCase() === "id");

      const ids = new Set<string>();
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const row = parseCSVLine(lines[i]);
        if (row[idIdx]) ids.add(row[idIdx]);
      }

      await updateJob({ total_customers: ids.size });
      return ids.size;
    });

    // Step 2+: Process in chunks — each chunk loads its own customer lookups
    const totalChunks = Math.ceil(totalSubs / CHUNK_SIZE);
    let totalImported = 0;

    for (let ci = 0; ci < totalChunks; ci++) {
      const chunkIdx = ci;

      const imported: number = await step.run(`chunk-${chunkIdx}`, async () => {
        // Load customer emails for lookup (within chunk step)
        const custMap = new Map<string, string>();
        let cOffset = 0;
        while (true) {
          const { data: batch } = await admin.from("customers")
            .select("id, email").eq("workspace_id", workspace_id).range(cOffset, cOffset + 999);
          if (!batch || batch.length === 0) break;
          for (const c of batch) { if (c.email) custMap.set(c.email.toLowerCase(), c.id); }
          cOffset += batch.length;
          if (batch.length < 1000) break;
        }

        const { data: fileData } = await admin.storage.from("imports").download(file_path);
        if (!fileData) return 0;

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

        // Group all rows by subscription ID
        const subsMap = new Map<string, string[][]>();
        for (let i = 1; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          const row = parseCSVLine(lines[i]);
          const subId = row[idIdx];
          if (!subId) continue;
          if (!subsMap.has(subId)) subsMap.set(subId, []);
          subsMap.get(subId)!.push(row);
        }

        // Get this chunk's subscription IDs
        const allSubIds = [...subsMap.keys()];
        const chunkSubIds = allSubIds.slice(chunkIdx * CHUNK_SIZE, (chunkIdx + 1) * CHUNK_SIZE);

        let count = 0;
        for (const subId of chunkSubIds) {
          const rows = subsMap.get(subId)!;
          const firstRow = rows[0];
          const email = firstRow[emailIdx]?.toLowerCase()?.trim();
          if (!email) continue;

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
            workspace_id,
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

          if (!error) count++;

          // Update customer subscription status
          if (customerId) {
            const { data: allSubs } = await admin.from("subscriptions").select("status").eq("customer_id", customerId);
            const hasActive = allSubs?.some((s) => s.status === "active");
            const hasPaused = allSubs?.some((s) => s.status === "paused");
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
    await step.run("cleanup", async () => {
      await admin.storage.from("imports").remove([file_path]);
      await updateJob({
        status: "completed",
        synced_customers: totalImported,
        completed_at: new Date().toISOString(),
      });
    });

    return { imported: totalImported };
  }
);
