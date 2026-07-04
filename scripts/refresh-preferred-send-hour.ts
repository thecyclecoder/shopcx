/**
 * Compute customers.preferred_sms_send_hour from Clicked SMS history.
 *
 * For each customer with profile_events.metric_name='Clicked SMS':
 *   1. Pull all their Clicked SMS event datetimes
 *   2. Convert each to local hour (0-23) in their resolved timezone
 *   3. Bucket clicks by local hour
 *   4. Pick the hour with the most clicks (mode). Ties broken by later
 *      hour (people who click later usually re-engage more).
 *   5. If fewer than MIN_CLICKS, leave null — no signal
 *   6. UPSERT customers.preferred_sms_send_hour + _clicks + _at
 *
 * Used by textCampaignScheduled to override target_local_hour, but
 * ONLY when the preferred hour is LATER than the planned hour
 * (never moves a recipient earlier than the campaign's target).
 *
 * Scope: SMS-subscribed customers only. Pass --all to recompute
 * for everyone.
 *
 * Usage:
 *   npx tsx scripts/refresh-preferred-send-hour.ts
 *   npx tsx scripts/refresh-preferred-send-hour.ts --all
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
import type { Client } from "pg";
import { pgClient } from "./_bootstrap";
import { resolveRecipientTimezone } from "@/lib/marketing-text-timezone";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const FALLBACK_TZ = "America/Chicago";
const ALL = process.argv.includes("--all");
const MIN_CLICKS = 3;
const CUSTOMER_BATCH = 500;
const CLICK_BATCH = 100;
// Rows written per set-based UPDATE ... FROM (VALUES ...) statement. At
// ~620K SMS-subscribed customers this is ~620 statements instead of the
// ~620K individual per-row UPDATEs the old Promise.allSettled loop issued.
const UPDATE_BATCH = 1000;

interface HourUpdate {
  id: string;
  hour: number | null;
  clicks: number | null;
}

/**
 * Flush pending preferred-send-hour writes as set-based UPDATEs.
 * One statement per UPDATE_BATCH rows: `UPDATE customers SET ... FROM (VALUES ...) v`.
 * With `force`, drains everything (final flush); otherwise leaves a <UPDATE_BATCH
 * remainder so full-size statements keep round-trips minimal. Returns rows written.
 */
async function flushHourUpdates(
  pg: Client,
  pending: HourUpdate[],
  refreshedAt: string,
  force: boolean,
): Promise<number> {
  let written = 0;
  while (pending.length >= (force ? 1 : UPDATE_BATCH)) {
    const chunk = pending.splice(0, UPDATE_BATCH);
    const params: unknown[] = [refreshedAt];
    const tuples: string[] = [];
    let p = 2;
    for (const u of chunk) {
      tuples.push(`($${p++}::uuid, $${p++}::int, $${p++}::int)`);
      params.push(u.id, u.hour, u.clicks);
    }
    const sql = `UPDATE customers AS c
      SET preferred_sms_send_hour = v.hour,
          preferred_sms_send_hour_clicks = v.clicks,
          preferred_sms_send_hour_at = $1
      FROM (VALUES ${tuples.join(", ")}) AS v(id, hour, clicks)
      WHERE c.id = v.id`;
    const res = await pg.query(sql, params);
    written += res.rowCount ?? 0;
  }
  return written;
}

interface CustomerRow {
  id: string;
  timezone: string | null;
  default_address: Record<string, unknown> | null;
  phone: string | null;
}

function localHour(dateIso: string, tz: string): number {
  // Intl.DateTimeFormat hour=numeric, hour12=false returns "00".."23"
  // or "0".."23" depending on locale. en-GB is consistent 2-digit.
  const h = new Date(dateIso).toLocaleString("en-GB", {
    hour: "2-digit",
    hour12: false,
    timeZone: tz,
  });
  return parseInt(h, 10);
}

function pickMode(buckets: number[]): { hour: number; count: number } | null {
  let best = -1;
  let bestCount = 0;
  // Iterate from 23 → 0 so ties prefer the LATER hour (people who
  // click in the evening tend to be more engaged with subsequent
  // messages).
  for (let h = 23; h >= 0; h--) {
    if (buckets[h] > bestCount) {
      best = h;
      bestCount = buckets[h];
    }
  }
  return best >= 0 && bestCount > 0 ? { hour: best, count: bestCount } : null;
}

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  console.log(`Loading customers (scope: ${ALL ? "all" : "SMS-subscribed"})...`);
  const customers: CustomerRow[] = [];
  let lastId: string | null = null;
  while (true) {
    let q = sb
      .from("customers")
      .select("id, timezone, default_address, phone")
      .eq("workspace_id", WS)
      .order("id", { ascending: true })
      .limit(1000);
    if (!ALL) q = q.eq("sms_marketing_status", "subscribed");
    if (lastId) q = q.gt("id", lastId);
    const { data, error } = await q;
    if (error) throw new Error(`customers fetch: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) customers.push(r as CustomerRow);
    lastId = data[data.length - 1].id;
    if (data.length < 1000) break;
  }
  console.log(`Loaded ${customers.length} customers`);

  let processed = 0;
  let withSignal = 0;
  let noSignal = 0;
  let errors = 0;
  let updated = 0;
  const hourDistribution: number[] = new Array(24).fill(0);
  const t0 = Date.now();

  // Single set-based writer: rows accumulate in `pending` and flush in
  // ~1000-row UPDATE ... FROM (VALUES ...) statements via the pooler.
  const pg = pgClient();
  await pg.connect();
  const refreshedAt = new Date().toISOString();
  const pending: HourUpdate[] = [];

  try {
  for (let i = 0; i < customers.length; i += CUSTOMER_BATCH) {
    const batch = customers.slice(i, i + CUSTOMER_BATCH);
    const ids = batch.map((c) => c.id);

    // Pull Clicked SMS events for the batch (180-day lookback)
    const since = new Date(Date.now() - 180 * 86_400_000).toISOString();
    const clicksByCustomer = new Map<string, string[]>();
    for (let j = 0; j < ids.length; j += CLICK_BATCH) {
      const chunk = ids.slice(j, j + CLICK_BATCH);
      const { data } = await sb
        .from("profile_events")
        .select("customer_id, datetime")
        .eq("workspace_id", WS)
        .in("customer_id", chunk)
        .eq("metric_name", "Clicked SMS")
        .gte("datetime", since);
      for (const e of data || []) {
        if (!e.customer_id) continue;
        if (!clicksByCustomer.has(e.customer_id)) clicksByCustomer.set(e.customer_id, []);
        clicksByCustomer.get(e.customer_id)!.push(e.datetime);
      }
    }

    // Compute preferred hour for each customer
    const updates: Array<{ id: string; hour: number | null; clicks: number | null }> = [];
    for (const c of batch) {
      const clicks = clicksByCustomer.get(c.id) || [];
      if (clicks.length < MIN_CLICKS) {
        updates.push({ id: c.id, hour: null, clicks: clicks.length });
        noSignal++;
        processed++;
        continue;
      }
      // Resolve their timezone — uses the same chain as the campaign
      // scheduler so the hour we infer is the same hour the
      // scheduler will apply.
      const tz = resolveRecipientTimezone(c, FALLBACK_TZ).timezone;
      const buckets: number[] = new Array(24).fill(0);
      for (const dt of clicks) {
        const h = localHour(dt, tz);
        if (!Number.isNaN(h)) buckets[h]++;
      }
      const mode = pickMode(buckets);
      if (mode) {
        updates.push({ id: c.id, hour: mode.hour, clicks: mode.count });
        hourDistribution[mode.hour]++;
        withSignal++;
      } else {
        updates.push({ id: c.id, hour: null, clicks: clicks.length });
        noSignal++;
      }
      processed++;
    }

    // Write back — accumulate and flush in ~1000-row set-based statements.
    pending.push(...updates);
    updated += await flushHourUpdates(pg, pending, refreshedAt, false);

    if (processed % 5000 === 0 || processed === customers.length) {
      const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
      const rate = (processed / ((Date.now() - t0) / 1000)).toFixed(1);
      console.log(`  ${processed}/${customers.length} | signal=${withSignal} no_signal=${noSignal} updated=${updated} errors=${errors} | ${elapsedMin}min @ ${rate}/sec`);
    }
  }

  // Drain the remainder.
  updated += await flushHourUpdates(pg, pending, refreshedAt, true);
  } finally {
    await pg.end();
  }

  console.log(`\n✓ DONE — processed=${processed} signal=${withSignal} no_signal=${noSignal} updated=${updated} errors=${errors} time=${((Date.now() - t0) / 60_000).toFixed(1)}min`);
  console.log(`\nPreferred-hour distribution (customers with signal):`);
  for (let h = 0; h < 24; h++) {
    if (hourDistribution[h] > 0) {
      const bar = "█".repeat(Math.round((hourDistribution[h] / withSignal) * 80));
      console.log(`  ${String(h).padStart(2, "0")}:00  ${String(hourDistribution[h]).padStart(6)}  ${bar}`);
    }
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
