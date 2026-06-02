/**
 * Phase 1c — backfill profile_events.customer_id from
 * klaviyo_profile_staging.
 *
 * For each staging row where customer_id IS NOT NULL, UPDATE all
 * events with the same klaviyo_profile_id (and currently NULL
 * customer_id) to set customer_id to the resolved value.
 *
 * Batched at 1000 profile_ids per UPDATE statement to avoid lock
 * contention. Idempotent — safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/backfill-events-customer-id.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";
const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

import { createClient } from "@supabase/supabase-js";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const PROFILE_BATCH = 1000;

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // Build the list of (profile_id, customer_id) pairs from staging — paginated
  console.log("Loading resolved profile→customer mappings from staging...");
  const pairs: Array<{ profile_id: string; customer_id: string }> = [];
  let lastId: string | null = null;
  while (true) {
    let q = supabase.from("klaviyo_profile_staging")
      .select("klaviyo_profile_id, customer_id")
      .eq("workspace_id", WS)
      .not("customer_id", "is", null)
      .order("klaviyo_profile_id", { ascending: true })
      .limit(1000);
    if (lastId) q = q.gt("klaviyo_profile_id", lastId);
    const { data, error } = await q;
    if (error) throw new Error(`staging fetch: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (r.customer_id) pairs.push({ profile_id: r.klaviyo_profile_id, customer_id: r.customer_id });
    }
    lastId = data[data.length - 1].klaviyo_profile_id;
    if (data.length < 1000) break;
  }
  console.log(`Resolved pairs to apply: ${pairs.length}`);

  // Update events in batches — group by customer_id so we can do
  // bulk UPDATE ... WHERE klaviyo_profile_id IN (...) for each customer
  // separately. (A single CASE statement across thousands of customers
  // would be slower than per-customer batched updates.)
  const byCustomer = new Map<string, string[]>();
  for (const p of pairs) {
    if (!byCustomer.has(p.customer_id)) byCustomer.set(p.customer_id, []);
    byCustomer.get(p.customer_id)!.push(p.profile_id);
  }
  console.log(`Distinct customer_ids: ${byCustomer.size}`);

  // Build flat list of (customer_id, profile_id_chunk) tasks
  const tasks: Array<{ customerId: string; chunk: string[] }> = [];
  for (const [customerId, profileIds] of byCustomer.entries()) {
    for (let j = 0; j < profileIds.length; j += PROFILE_BATCH) {
      tasks.push({ customerId, chunk: profileIds.slice(j, j + PROFILE_BATCH) });
    }
  }
  console.log(`Total update tasks: ${tasks.length}`);

  // Run with concurrency to amortize roundtrip latency. 15 instead of
  // 30 — the original run crashed after 18 min on a transient fetch
  // error; lower concurrency reduces the rate of those.
  const CONCURRENCY = 15;
  const RETRIES = 3;
  let totalUpdated = 0;
  let completed = 0;
  let totalErrors = 0;
  const t0 = Date.now();

  async function runOne(t: { customerId: string; chunk: string[] }) {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        const { error, count } = await supabase
          .from("profile_events")
          .update({ customer_id: t.customerId }, { count: "exact" })
          .eq("workspace_id", WS)
          .is("customer_id", null)
          .in("klaviyo_profile_id", t.chunk);
        if (error) throw new Error(`supabase: ${error.message}`);
        totalUpdated += count || 0;
        completed++;
        if (completed % 1000 === 0) {
          const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
          console.log(`  ${completed}/${tasks.length} tasks | events updated: ${totalUpdated} | errors: ${totalErrors} | ${elapsedMin}min`);
        }
        return;
      } catch (err) {
        totalErrors++;
        if (attempt >= RETRIES) {
          console.error(`  ✗ ${t.customerId} failed after ${RETRIES} attempts:`, err instanceof Error ? err.message : err);
          completed++;
          return;
        }
        await new Promise(res => setTimeout(res, 1000 * attempt));  // exponential-ish
      }
    }
  }

  // Process in waves of CONCURRENCY
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const wave = tasks.slice(i, i + CONCURRENCY);
    await Promise.all(wave.map(runOne));
  }

  console.log(`\n✓ DONE — tasks=${tasks.length} events_updated=${totalUpdated} time=${((Date.now() - t0) / 60_000).toFixed(1)}min`);
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
