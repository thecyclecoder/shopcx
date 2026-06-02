/**
 * Phase 2 — Cleanup pull for klaviyo_profile_ids that have events in
 * our DB but weren't returned by the TtP53p (SMS subscribers) segment
 * pull. These are typically:
 *   - Email-only subscribers (got Opened Email / Clicked Email events
 *     but never subscribed to SMS)
 *   - Recently-unsubscribed SMS subscribers
 *   - Flow recipients (welcome flows, etc.)
 *
 * Flow:
 *   1. SELECT DISTINCT klaviyo_profile_id FROM profile_events
 *      WHERE workspace_id = ? AND klaviyo_profile_id NOT IN (staging)
 *   2. Batch the resulting IDs into chunks of 100
 *   3. For each batch: GET /api/profiles?filter=any(id,[...])
 *   4. Same mapping + resolution logic as Phase 1b
 *   5. Upsert into klaviyo_profile_staging with source_segment="event_cleanup"
 *
 * Usage:
 *   npx tsx scripts/pull-klaviyo-event-only-profiles.ts
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
import { decrypt } from "@/lib/crypto";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KLAVIYO_REVISION = "2025-01-15";
const BATCH = 100;
const UPSERT_CHUNK = 200;

let interrupted = false;
process.on("SIGINT", () => { interrupted = true; console.log("\n\nSIGINT — finishing current batch then exiting."); });

interface StagingRow {
  workspace_id: string;
  klaviyo_profile_id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  anonymous_id: string | null;
  external_id: string | null;
  locale: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  region: string | null;
  zip: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  ip_address: string | null;
  klaviyo_created: string | null;
  klaviyo_updated: string | null;
  klaviyo_last_event_date: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  consent_form_id: string | null;
  customer_id: string | null;
  resolution_method: "email" | "phone" | null;
  source_segment: string;
}

function mapProfileToRow(p: { id: string; attributes?: Record<string, unknown> }): StagingRow {
  const a = (p.attributes || {}) as Record<string, unknown>;
  const loc = (a.location || {}) as Record<string, unknown>;
  const props = (a.properties || {}) as Record<string, unknown>;
  return {
    workspace_id: WS,
    klaviyo_profile_id: p.id,
    email: (a.email as string | null) || null,
    phone: (a.phone_number as string | null) || null,
    first_name: (a.first_name as string | null) || null,
    last_name: (a.last_name as string | null) || null,
    anonymous_id: (a.anonymous_id as string | null) || null,
    external_id: (a.external_id as string | null) || null,
    locale: (a.locale as string | null) || null,
    address1: (loc.address1 as string | null) || null,
    address2: (loc.address2 as string | null) || null,
    city: (loc.city as string | null) || null,
    region: (loc.region as string | null) || null,
    zip: (loc.zip as string | null) || null,
    country: (loc.country as string | null) || null,
    latitude: (loc.latitude as number | null) || null,
    longitude: (loc.longitude as number | null) || null,
    timezone: (loc.timezone as string | null) || null,
    ip_address: (loc.ip as string | null) || null,
    klaviyo_created: (a.created as string | null) || null,
    klaviyo_updated: (a.updated as string | null) || null,
    klaviyo_last_event_date: (a.last_event_date as string | null) || null,
    utm_source: (props.utm_source as string | null) || null,
    utm_medium: (props.utm_medium as string | null) || null,
    utm_campaign: (props.utm_campaign as string | null) || null,
    utm_content: (props.utm_content as string | null) || null,
    consent_form_id: (props.$consent_form_id as string | null) || null,
    customer_id: null,
    resolution_method: null,
    source_segment: "event_cleanup",
  };
}

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: ws } = await supabase.from("workspaces").select("klaviyo_api_key_encrypted").eq("id", WS).single();
  const apiKey = decrypt(ws!.klaviyo_api_key_encrypted);
  const headers = {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: KLAVIYO_REVISION,
    Accept: "application/json",
  };

  // ── Step 1: find distinct profile_ids in events not in staging ──
  console.log("Finding distinct klaviyo_profile_ids in events NOT in staging...");
  const eventProfiles = new Set<string>();
  let lastDt: string | null = null;
  while (true) {
    let q = supabase.from("profile_events")
      .select("klaviyo_profile_id, datetime")
      .eq("workspace_id", WS)
      .order("datetime", { ascending: true })
      .limit(1000);
    if (lastDt) q = q.gt("datetime", lastDt);
    const { data } = await q;
    if (!data || data.length === 0) break;
    for (const r of data) eventProfiles.add(r.klaviyo_profile_id);
    lastDt = data[data.length - 1].datetime;
    if (data.length < 1000) break;
  }
  console.log(`Distinct profile_ids in events: ${eventProfiles.size}`);

  // Get staged profile_ids
  console.log("Loading staged profile_ids...");
  const staged = new Set<string>();
  let lastId: string | null = null;
  while (true) {
    let q = supabase.from("klaviyo_profile_staging")
      .select("klaviyo_profile_id")
      .eq("workspace_id", WS)
      .order("klaviyo_profile_id", { ascending: true })
      .limit(1000);
    if (lastId) q = q.gt("klaviyo_profile_id", lastId);
    const { data } = await q;
    if (!data || data.length === 0) break;
    for (const r of data) staged.add(r.klaviyo_profile_id);
    lastId = data[data.length - 1].klaviyo_profile_id;
    if (data.length < 1000) break;
  }
  console.log(`Already staged: ${staged.size}`);

  // Difference = profiles to fetch
  const missing = [...eventProfiles].filter(id => !staged.has(id));
  console.log(`To fetch from Klaviyo: ${missing.length}`);
  if (missing.length === 0) { console.log("Nothing to do."); return; }

  // ── Step 2: batch-fetch from Klaviyo ──
  let totalUpserted = 0;
  let totalEmail = 0;
  let totalPhone = 0;
  let totalUnresolved = 0;
  let batchNum = 0;
  const t0 = Date.now();

  for (let i = 0; i < missing.length && !interrupted; i += BATCH) {
    batchNum++;
    const batch = missing.slice(i, i + BATCH);
    const filter = `any(id,[${batch.map(id => `"${id}"`).join(",")}])`;
    const url = `https://a.klaviyo.com/api/profiles?filter=${encodeURIComponent(filter)}&page[size]=${BATCH}`;

    let r: Response;
    let attempt = 0;
    while (true) {
      attempt++;
      r = await fetch(url, { headers });
      if (r.status === 429) {
        await new Promise(res => setTimeout(res, 5000));
        continue;
      }
      if (!r.ok) {
        if (attempt < 3) {
          await new Promise(res => setTimeout(res, 1000 * attempt));
          continue;
        }
        const text = await r.text().catch(() => "");
        console.log(`  batch ${batchNum}: ${r.status} after ${attempt} attempts: ${text.slice(0, 200)}`);
        break;
      }
      break;
    }
    if (!r.ok) continue;

    const body = await r.json() as { data: Array<{ id: string; attributes?: Record<string, unknown> }> };
    const rows = (body.data || []).map(mapProfileToRow);

    // Resolve customer_id batch-style
    if (rows.length > 0) {
      const emails = rows.map(rr => rr.email).filter((e): e is string => !!e).map(e => e.toLowerCase());
      const phones = rows.map(rr => rr.phone).filter((p): p is string => !!p);
      const emailMap = new Map<string, string>();
      if (emails.length > 0) {
        for (let j = 0; j < emails.length; j += 100) {
          const chunk = emails.slice(j, j + 100);
          const { data: ce } = await supabase.from("customers").select("id, email").eq("workspace_id", WS).in("email", [...new Set(chunk)]);
          for (const c of ce || []) if (c.email) emailMap.set(c.email.toLowerCase(), c.id);
        }
      }
      const phoneMap = new Map<string, string>();
      if (phones.length > 0) {
        for (let j = 0; j < phones.length; j += 100) {
          const chunk = phones.slice(j, j + 100);
          const { data: cp } = await supabase.from("customers").select("id, phone").eq("workspace_id", WS).in("phone", [...new Set(chunk)]);
          for (const c of cp || []) if (c.phone) phoneMap.set(c.phone, c.id);
        }
      }
      for (const row of rows) {
        if (row.email) {
          const m = emailMap.get(row.email.toLowerCase());
          if (m) { row.customer_id = m; row.resolution_method = "email"; totalEmail++; continue; }
        }
        if (row.phone) {
          const m = phoneMap.get(row.phone);
          if (m) { row.customer_id = m; row.resolution_method = "phone"; totalPhone++; continue; }
        }
        totalUnresolved++;
      }
    }

    // Upsert
    for (let j = 0; j < rows.length; j += UPSERT_CHUNK) {
      const chunk = rows.slice(j, j + UPSERT_CHUNK);
      const { error } = await supabase
        .from("klaviyo_profile_staging")
        .upsert(chunk, { onConflict: "workspace_id,klaviyo_profile_id" });
      if (error) console.error(`upsert batch ${batchNum}: ${error.message}`);
    }
    totalUpserted += rows.length;

    if (batchNum % 25 === 0) {
      const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
      const rate = (totalUpserted / ((Date.now() - t0) / 1000)).toFixed(1);
      console.log(`  batch ${batchNum} | upserted ${totalUpserted} | email=${totalEmail} phone=${totalPhone} unresolved=${totalUnresolved} | ${elapsedMin}min @ ${rate}/sec`);
    }
  }

  console.log(`\n✓ DONE — batches=${batchNum} upserted=${totalUpserted} email=${totalEmail} phone=${totalPhone} unresolved=${totalUnresolved} time=${((Date.now() - t0) / 60_000).toFixed(1)}min`);
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
