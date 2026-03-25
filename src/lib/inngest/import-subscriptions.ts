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

    // Step 1: Download and parse CSV
    const parsed: { totalSubs: number; subChunks: string[][] } = await step.run("parse-csv", async () => {
      await updateJob({ status: "running", phase: "customers" }); // reuse phase for "processing"

      const { data: fileData, error } = await admin.storage.from("imports").download(file_path);
      if (error || !fileData) throw new Error("Failed to download CSV");

      const csvText = await fileData.text();
      const lines = csvText.split("\n");
      const headers = parseCSVLine(lines[0]);

      const col = (name: string) => headers.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
      const idIdx = col("ID");

      // Group rows by subscription ID
      const subsMap = new Map<string, string[]>();
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const row = parseCSVLine(lines[i]);
        const subId = row[idIdx];
        if (!subId) continue;
        if (!subsMap.has(subId)) subsMap.set(subId, []);
        subsMap.get(subId)!.push(lines[i]);
      }

      // Split into chunks of 500 subscriptions
      const allSubIds = [...subsMap.keys()];
      const chunks: string[][] = [];
      for (let i = 0; i < allSubIds.length; i += 500) {
        chunks.push(allSubIds.slice(i, i + 500));
      }

      await updateJob({ total_customers: subsMap.size }); // reuse total_customers for total subs

      // Store the full CSV lines per sub in a temp format
      // We'll re-download the CSV in each chunk step
      return { totalSubs: subsMap.size, subChunks: chunks };
    });

    // Step 2: Preload customer lookup
    const customerMap: Record<string, string> = await step.run("load-customers", async () => {
      const map: Record<string, string> = {};
      let offset = 0;
      while (true) {
        const { data: batch } = await admin.from("customers")
          .select("id, email").eq("workspace_id", workspace_id).range(offset, offset + 999);
        if (!batch || batch.length === 0) break;
        for (const c of batch) { if (c.email) map[c.email.toLowerCase()] = c.id; }
        offset += batch.length;
        if (batch.length < 1000) break;
      }
      return map;
    });

    // Step 3: Process chunks (re-download CSV in each chunk to avoid step data limits)
    let totalImported = 0;

    for (let chunkIdx = 0; chunkIdx < parsed.subChunks.length; chunkIdx++) {
      const subIds = parsed.subChunks[chunkIdx];
      const ci = chunkIdx;

      const imported: number = await step.run(`chunk-${ci}`, async () => {
        // Re-download CSV for this chunk
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

        // Collect rows for this chunk's subscription IDs
        const subIdSet = new Set(subIds);
        const subsRows = new Map<string, string[][]>();
        for (let i = 1; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          const row = parseCSVLine(lines[i]);
          const subId = row[idIdx];
          if (!subIdSet.has(subId)) continue;
          if (!subsRows.has(subId)) subsRows.set(subId, []);
          subsRows.get(subId)!.push(row);
        }

        let count = 0;
        for (const [subId, rows] of subsRows) {
          const firstRow = rows[0];
          const email = firstRow[emailIdx]?.toLowerCase()?.trim();
          if (!email) continue;

          const customerId = customerMap[email] || null;
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
        }

        // Update customer statuses for this chunk
        const uniqueEmails = [...new Set(subsRows.values().next().value?.[0] ?
          [...subsRows.values()].map(rows => rows[0][emailIdx]?.toLowerCase()?.trim()).filter(Boolean) : [])];

        for (const email of uniqueEmails) {
          const cid = customerMap[email];
          if (!cid) continue;
          const { data: allSubs } = await admin.from("subscriptions").select("status").eq("customer_id", cid);
          const hasActive = allSubs?.some((s) => s.status === "active");
          const hasPaused = allSubs?.some((s) => s.status === "paused");
          await admin.from("customers").update({
            subscription_status: hasActive ? "active" : hasPaused ? "paused" : "cancelled",
          }).eq("id", cid);
        }

        await updateJob({ synced_customers: totalImported + count });
        return count;
      });

      totalImported += imported;
    }

    // Step 4: Cleanup
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
