import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";

// ── CSV parser (handles quoted fields with commas) ──

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

const CHUNK_SIZE = 1000;
const UPSERT_BATCH = 250;

// ── Helpers ──

type Admin = ReturnType<typeof createAdminClient>;

async function updateJob(admin: Admin, jobId: string, updates: Record<string, unknown>) {
  await admin.from("import_jobs").update(updates).eq("id", jobId);
}

async function failJob(admin: Admin, jobId: string, error: string, chunkIndex?: number) {
  await admin.from("import_jobs").update({
    status: "failed",
    error,
    ...(chunkIndex != null ? { failed_chunk_index: chunkIndex } : {}),
    completed_at: new Date().toISOString(),
  }).eq("id", jobId);
}


// ── 1. File Upload: validate CSV, count records ──

export const importFileUpload = inngest.createFunction(
  {
    id: "import-file-upload",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "import/file.upload" }],
  },
  async ({ event, step }) => {
    const { workspace_id, job_id, file_path } = event.data as {
      workspace_id: string; job_id: string; file_path: string;
    };
    const admin = createAdminClient();

    const fileInfo = await step.run("validate", async () => {
      await updateJob(admin, job_id, { status: "uploading" });

      const { data: fileData } = await admin.storage.from("imports").download(file_path);
      if (!fileData) throw new Error("File not found in storage");
      const text = await fileData.text();
      const lines = text.split("\n");
      if (lines.length < 2) throw new Error("CSV file is empty");

      const headers = parseCSVLine(lines[0]);
      const idIdx = headers.findIndex(h => h.trim().toLowerCase() === "id");
      const emailIdx = headers.findIndex(h => h.trim().toLowerCase() === "customer email");
      if (idIdx === -1) throw new Error("CSV missing required 'ID' column");
      if (emailIdx === -1) throw new Error("CSV missing required 'Customer email' column");

      // Count unique subscription IDs
      const subIds = new Set<string>();
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const row = parseCSVLine(lines[i]);
        const subId = row[idIdx]?.trim();
        if (subId) subIds.add(subId);
      }

      await updateJob(admin, job_id, { total_records: subIds.size });
      return { totalRecords: subIds.size };
    });

    await step.run("fire-split", async () => {
      await inngest.send({
        name: "import/file.split",
        data: { workspace_id, job_id, file_path, total_records: fileInfo.totalRecords },
      });
    });

    return { totalRecords: fileInfo.totalRecords };
  }
);

// ── 2. File Split: group by sub ID, write chunk CSVs ──

export const importFileSplit = inngest.createFunction(
  {
    id: "import-file-split",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "import/file.split" }],
  },
  async ({ event, step }) => {
    const { workspace_id, job_id, file_path } = event.data as {
      workspace_id: string; job_id: string; file_path: string;
    };
    const admin = createAdminClient();

    const splitResult = await step.run("split", async () => {
      await updateJob(admin, job_id, { status: "splitting" });

      const { data: fileData } = await admin.storage.from("imports").download(file_path);
      if (!fileData) throw new Error("File not found");
      const text = await fileData.text();
      const lines = text.split("\n");
      const headerLine = lines[0];
      const headers = parseCSVLine(headerLine);
      const idIdx = headers.findIndex(h => h.trim().toLowerCase() === "id");

      // Group rows by subscription ID, preserve insertion order
      const subIds: string[] = [];
      const subRows = new Map<string, string[]>();
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const row = parseCSVLine(lines[i]);
        const subId = row[idIdx]?.trim();
        if (!subId) continue;
        if (!subRows.has(subId)) { subIds.push(subId); subRows.set(subId, []); }
        subRows.get(subId)!.push(lines[i]);
      }

      // Write chunk files
      const chunkCount = Math.ceil(subIds.length / CHUNK_SIZE);
      const basePath = file_path.replace(".csv", "");

      for (let c = 0; c < chunkCount; c++) {
        const chunkSubIds = subIds.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
        const chunkLines = [headerLine];
        for (const sid of chunkSubIds) {
          chunkLines.push(...(subRows.get(sid) || []));
        }
        const chunkBlob = new Blob([chunkLines.join("\n")], { type: "text/csv" });
        await admin.storage.from("imports").upload(`${basePath}-chunk-${c}.csv`, chunkBlob, { upsert: true });
      }

      await updateJob(admin, job_id, { total_chunks: chunkCount });
      return { chunkCount };
    });

    // Fire chunk.process events for each chunk
    await step.run("fire-chunks", async () => {
      const basePath = file_path.replace(".csv", "");
      const events = [];
      for (let i = 0; i < splitResult.chunkCount; i++) {
        events.push({
          name: "import/chunk.process" as const,
          data: {
            workspace_id,
            job_id,
            chunk_index: i,
            chunk_path: `${basePath}-chunk-${i}.csv`,
          },
        });
      }
      await inngest.send(events);
    });

    return { chunks: splitResult.chunkCount };
  }
);

// ── 3. Chunk Process: parse, lookup customers, upsert subscriptions ──

export const importChunkProcess = inngest.createFunction(
  {
    id: "import-chunk-process",
    retries: 2,
    concurrency: [{ limit: 10, key: "event.data.workspace_id" }],
    triggers: [{ event: "import/chunk.process" }],
  },
  async ({ event, step }) => {
    const { workspace_id, job_id, chunk_index, chunk_path } = event.data as {
      workspace_id: string; job_id: string; chunk_index: number; chunk_path: string;
    };
    const admin = createAdminClient();

    const result = await step.run("process", async () => {
      // Update status on first chunk
      if (chunk_index === 0) {
        await updateJob(admin, job_id, { status: "processing" });
      }

      const { data: chunkData } = await admin.storage.from("imports").download(chunk_path);
      if (!chunkData) {
        await failJob(admin, job_id, `Chunk file not found: ${chunk_path}`, chunk_index);
        return { count: 0, isLast: false };
      }
      const text = await chunkData.text();
      const lines = text.split("\n");
      const headers = parseCSVLine(lines[0]);

      const col = (n: string) => headers.findIndex(h => h.trim().toLowerCase() === n.toLowerCase());
      const idIdx = col("ID"), statusIdx = col("Status"), emailIdx = col("Customer email");
      const phoneIdx = col("Customer phone");
      const intervalTypeIdx = col("Billing interval type"), intervalCountIdx = col("Billing interval count");
      const nextOrderIdx = col("Next order date"), lineTitleIdx = col("Line title");
      const lineSkuIdx = col("Line SKU"), lineQtyIdx = col("Line variant quantity");
      const linePriceIdx = col("Line variant price"), lineProductIdx = col("Line product ID");
      const lineVariantIdx = col("Line variant ID"), linePlanNameIdx = col("Line selling plan name");
      const shippingPriceIdx = col("Shipping Price");
      const pastOrderNamesIdx = col("Past order names");

      // Group rows by subscription ID
      const subRows = new Map<string, string[][]>();
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const row = parseCSVLine(lines[i]);
        const subId = row[idIdx]?.trim();
        if (!subId) continue;
        if (!subRows.has(subId)) subRows.set(subId, []);
        subRows.get(subId)!.push(row);
      }

      // Build customer lookup maps: email + phone
      const emails = new Set<string>();
      const phones = new Set<string>();
      for (const rows of subRows.values()) {
        const e = rows[0][emailIdx]?.toLowerCase()?.trim();
        const p = rows[0][phoneIdx]?.trim();
        if (e) emails.add(e);
        if (p) phones.add(p);
      }

      const custByEmail = new Map<string, string>();
      const custByPhone = new Map<string, string>();

      // Batch lookup by email
      const emailArr = [...emails];
      for (let e = 0; e < emailArr.length; e += 100) {
        const { data: custs } = await admin.from("customers")
          .select("id, email, phone").eq("workspace_id", workspace_id)
          .in("email", emailArr.slice(e, e + 100));
        for (const c of custs || []) {
          if (c.email) custByEmail.set(c.email.toLowerCase(), c.id);
          if (c.phone) custByPhone.set(c.phone, c.id);
        }
      }

      // Batch lookup by phone (for customers not found by email)
      const phoneArr = [...phones].filter(p => !custByPhone.has(p));
      for (let p = 0; p < phoneArr.length; p += 100) {
        const { data: custs } = await admin.from("customers")
          .select("id, phone").eq("workspace_id", workspace_id)
          .in("phone", phoneArr.slice(p, p + 100));
        for (const c of custs || []) {
          if (c.phone) custByPhone.set(c.phone, c.id);
        }
      }

      // Build subscription records
      const records: Record<string, unknown>[] = [];
      // Track order names → subscription contract IDs for linking
      const orderSubLinks: { order_name: string; contract_id: string }[] = [];

      for (const [subId, rows] of subRows) {
        const firstRow = rows[0];
        const email = firstRow[emailIdx]?.toLowerCase()?.trim();
        const phone = firstRow[phoneIdx]?.trim();
        if (!email && !phone) continue;

        // Shopify ID-first: email primary, phone fallback
        const customerId = (email && custByEmail.get(email))
          || (phone && custByPhone.get(phone))
          || null;

        const rawStatus = firstRow[statusIdx]?.toLowerCase()?.trim();
        const status = rawStatus === "active" ? "active" : rawStatus === "paused" ? "paused" : "cancelled";

        const items = rows.map(row => ({
          title: row[lineTitleIdx]?.trim() || null,
          sku: row[lineSkuIdx]?.trim() || null,
          quantity: parseInt(row[lineQtyIdx]) || 1,
          price_cents: Math.round(parseFloat(row[linePriceIdx] || "0") * 100),
          product_id: row[lineProductIdx]?.trim() || null,
          variant_id: row[lineVariantIdx]?.trim() || null,
          variant_title: null,
          selling_plan: row[linePlanNameIdx]?.trim() || null,
        })).filter(i => i.title);

        records.push({
          workspace_id, customer_id: customerId, shopify_contract_id: subId, status,
          billing_interval: firstRow[intervalTypeIdx]?.toLowerCase()?.trim() || null,
          billing_interval_count: parseInt(firstRow[intervalCountIdx]) || null,
          next_billing_date: firstRow[nextOrderIdx]?.trim() || null,
          last_payment_status: status === "active" ? "succeeded" : null,
          items,
          delivery_price_cents: Math.round(parseFloat(firstRow[shippingPriceIdx] || "0") * 100),
          updated_at: new Date().toISOString(),
        });

        // Extract past order names for order-to-subscription linking
        if (pastOrderNamesIdx !== -1) {
          const pastOrders = firstRow[pastOrderNamesIdx]?.trim();
          if (pastOrders) {
            for (const orderName of pastOrders.split(",")) {
              const trimmed = orderName.trim();
              if (trimmed) orderSubLinks.push({ order_name: trimmed, contract_id: subId });
            }
          }
        }
      }

      // Batch upsert subscriptions
      let count = 0;
      for (let r = 0; r < records.length; r += UPSERT_BATCH) {
        const batch = records.slice(r, r + UPSERT_BATCH);
        const { error } = await admin.from("subscriptions").upsert(batch, { onConflict: "workspace_id,shopify_contract_id" });
        if (!error) count += batch.length;
      }

      // Link orders to subscriptions by order_number
      if (orderSubLinks.length > 0) {
        // Get subscription IDs for the contract IDs in this chunk
        const contractIds = [...new Set(orderSubLinks.map(l => l.contract_id))];
        const subMap = new Map<string, string>();
        for (let s = 0; s < contractIds.length; s += 100) {
          const { data: subs } = await admin.from("subscriptions")
            .select("id, shopify_contract_id").eq("workspace_id", workspace_id)
            .in("shopify_contract_id", contractIds.slice(s, s + 100));
          for (const sub of subs || []) {
            subMap.set(sub.shopify_contract_id, sub.id);
          }
        }

        // Match order names to orders and set subscription_id
        const orderNames = [...new Set(orderSubLinks.map(l => l.order_name))];
        for (let n = 0; n < orderNames.length; n += 100) {
          const batch = orderNames.slice(n, n + 100);
          const { data: orders } = await admin.from("orders")
            .select("id, order_number").eq("workspace_id", workspace_id)
            .in("order_number", batch)
            .is("subscription_id", null);

          if (orders) {
            for (const order of orders) {
              const link = orderSubLinks.find(l => l.order_name === order.order_number);
              if (link) {
                const subId = subMap.get(link.contract_id);
                if (subId) {
                  await admin.from("orders").update({ subscription_id: subId }).eq("id", order.id);
                }
              }
            }
          }
        }
      }

      // Atomic increment via RPC — returns updated counts for completion check
      const { data: jobState } = await admin.rpc("atomic_increment_import_job", {
        p_job_id: job_id,
        p_processed_records: count,
        p_completed_chunks: 1,
      }).single() as { data: { completed_chunks: number; total_chunks: number; finalize_completed: number; finalize_total: number } | null };

      const isLast = jobState
        ? (jobState.completed_chunks >= jobState.total_chunks)
        : false;

      return { count, isLast };
    });

    // If this was the last chunk, fire chunks.complete
    if (result.isLast) {
      await step.run("fire-complete", async () => {
        await inngest.send({
          name: "import/chunks.complete",
          data: { workspace_id, job_id },
        });
      });
    }

    return { processed: result.count };
  }
);

// ── 4. Chunks Complete: determine finalize batches ──

export const importChunksComplete = inngest.createFunction(
  {
    id: "import-chunks-complete",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "import/chunks.complete" }],
  },
  async ({ event, step }) => {
    const { workspace_id, job_id } = event.data as {
      workspace_id: string; job_id: string;
    };
    const admin = createAdminClient();

    const batchInfo = await step.run("prepare-finalize", async () => {
      await updateJob(admin, job_id, { status: "finalizing" });

      // Get distinct customer IDs that have subscriptions in this workspace
      const { data: customers } = await admin
        .from("subscriptions")
        .select("customer_id")
        .eq("workspace_id", workspace_id)
        .not("customer_id", "is", null);

      const uniqueIds = [...new Set((customers || []).map(c => c.customer_id).filter(Boolean))] as string[];
      const batchCount = Math.max(1, Math.ceil(uniqueIds.length / 1000));

      await updateJob(admin, job_id, { finalize_total: batchCount });

      return { customerIds: uniqueIds, batchCount };
    });

    // Fire finalize.batch events
    await step.run("fire-finalize", async () => {
      const events = [];
      for (let i = 0; i < batchInfo.batchCount; i++) {
        const batchIds = batchInfo.customerIds.slice(i * 1000, (i + 1) * 1000);
        events.push({
          name: "import/finalize.batch" as const,
          data: {
            workspace_id,
            job_id,
            batch_index: i,
            customer_ids: batchIds,
          },
        });
      }
      if (events.length > 0) {
        await inngest.send(events);
      }
    });

    return { batches: batchInfo.batchCount };
  }
);

// ── 5. Finalize Batch: update customer subscription statuses ──

export const importFinalizeBatch = inngest.createFunction(
  {
    id: "import-finalize-batch",
    retries: 2,
    concurrency: [{ limit: 10, key: "event.data.workspace_id" }],
    triggers: [{ event: "import/finalize.batch" }],
  },
  async ({ event, step }) => {
    const { workspace_id, job_id, customer_ids } = event.data as {
      workspace_id: string; job_id: string; batch_index: number; customer_ids: string[];
    };
    const admin = createAdminClient();

    const result = await step.run("update-statuses", async () => {
      let updated = 0;

      // For each customer, determine their subscription status
      for (let i = 0; i < customer_ids.length; i += 100) {
        const batch = customer_ids.slice(i, i + 100);

        // Get all subscriptions for this batch of customers
        const { data: subs } = await admin
          .from("subscriptions")
          .select("customer_id, status")
          .in("customer_id", batch);

        if (!subs) continue;

        // Group by customer
        const byCustomer = new Map<string, string[]>();
        for (const sub of subs) {
          if (!byCustomer.has(sub.customer_id)) byCustomer.set(sub.customer_id, []);
          byCustomer.get(sub.customer_id)!.push(sub.status);
        }

        // Determine overall status and batch update
        for (const [custId, statuses] of byCustomer) {
          const hasActive = statuses.includes("active");
          const hasPaused = statuses.includes("paused");
          const status = hasActive ? "active" : hasPaused ? "paused" : "cancelled";

          await admin.from("customers").update({
            subscription_status: status,
            updated_at: new Date().toISOString(),
          }).eq("id", custId);
          updated++;
        }
      }

      // Atomic increment finalize_completed
      const { data: jobState } = await admin.rpc("atomic_increment_import_job", {
        p_job_id: job_id,
        p_processed_records: 0,
        p_completed_chunks: 0,
        p_finalize_completed: 1,
      }).single() as { data: { completed_chunks: number; total_chunks: number; finalize_completed: number; finalize_total: number } | null };

      const isLast = jobState
        ? (jobState.finalize_completed >= jobState.finalize_total)
        : false;

      return { updated, isLast };
    });

    if (result.isLast) {
      await step.run("fire-job-complete", async () => {
        await inngest.send({
          name: "import/job.complete",
          data: { workspace_id, job_id },
        });
      });
    }

    return { updated: result.updated };
  }
);

// ── 6. Job Complete: mark done, cleanup ──

export const importJobComplete = inngest.createFunction(
  {
    id: "import-job-complete",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "import/job.complete" }],
  },
  async ({ event, step }) => {
    const { workspace_id, job_id } = event.data as {
      workspace_id: string; job_id: string;
    };
    const admin = createAdminClient();

    await step.run("complete", async () => {
      // Get final counts
      const { data: job } = await admin.from("import_jobs")
        .select("processed_records, file_path")
        .eq("id", job_id).single();

      await updateJob(admin, job_id, {
        status: "completed",
        completed_at: new Date().toISOString(),
      });

      // Clean up chunk files (keep original)
      if (job?.file_path) {
        const basePath = job.file_path.replace(".csv", "");
        // List and delete chunk files
        const { data: files } = await admin.storage.from("imports").list(
          basePath.substring(0, basePath.lastIndexOf("/")),
        );
        if (files) {
          const chunkFiles = files
            .filter(f => f.name.includes("-chunk-"))
            .map(f => `${basePath.substring(0, basePath.lastIndexOf("/"))}/${f.name}`);
          if (chunkFiles.length > 0) {
            await admin.storage.from("imports").remove(chunkFiles);
          }
        }
      }
    });

    return { status: "completed" };
  }
);
