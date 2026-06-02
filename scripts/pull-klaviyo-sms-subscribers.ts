/**
 * Phase 1b — Pull Klaviyo SMS subscriber profiles (segment TtP53p) into
 * klaviyo_profile_staging, resolving customer_id at insert time.
 *
 * For each profile: extract identity + location + lineage fields, match
 * to a customer via email-first / phone-fallback, upsert to staging.
 * Resumable — re-running picks up from where it left off via the
 * upsert behavior.
 *
 * Usage:
 *   npx tsx scripts/pull-klaviyo-sms-subscribers.ts
 *
 * Logs progress every 25 pages (~2500 profiles) to /tmp/klaviyo-sms-pull.log.
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
const SEGMENT_ID = "TtP53p";  // "All SMS Subscribers"
const KLAVIYO_REVISION = "2025-01-15";
const PAGE_SIZE = 100;
const UPSERT_CHUNK = 200;
const SOURCE_SEGMENT = "TtP53p";

let interrupted = false;
process.on("SIGINT", () => { interrupted = true; console.log("\n\nSIGINT — finishing current page then exiting."); });

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
    customer_id: null,           // resolved per batch below
    resolution_method: null,     // resolved per batch below
    source_segment: SOURCE_SEGMENT,
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

  console.log(`Pulling segment ${SEGMENT_ID} profiles...`);
  let url: string | null =
    `https://a.klaviyo.com/api/segments/${SEGMENT_ID}/profiles?page[size]=${PAGE_SIZE}&additional-fields[profile]=subscriptions`;

  let totalUpserted = 0;
  let totalResolvedEmail = 0;
  let totalResolvedPhone = 0;
  let totalUnresolved = 0;
  let pages = 0;
  const t0 = Date.now();

  while (url && !interrupted) {
    pages++;
    const r: Response = await fetch(url, { headers });
    if (r.status === 429) {
      console.log(`  page ${pages}: 429 — sleeping 5s`);
      await new Promise(res => setTimeout(res, 5000));
      continue;
    }
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`page ${pages} ${r.status}: ${text.slice(0, 400)}`);
    }
    const body = (await r.json()) as {
      data: Array<{ id: string; attributes?: Record<string, unknown> }>;
      links?: { next?: string };
    };
    const rows = (body.data || []).map(mapProfileToRow);

    // Batch-resolve customer_id via email + phone match
    if (rows.length > 0) {
      const emails = rows.map(r => r.email).filter((e): e is string => !!e).map(e => e.toLowerCase());
      const phones = rows.map(r => r.phone).filter((p): p is string => !!p);

      const emailToCustomer = new Map<string, string>();
      if (emails.length > 0) {
        const { data: ce } = await supabase
          .from("customers")
          .select("id, email")
          .eq("workspace_id", WS)
          .in("email", [...new Set(emails)]);
        for (const c of ce || []) if (c.email) emailToCustomer.set(c.email.toLowerCase(), c.id);
      }
      const phoneToCustomer = new Map<string, string>();
      if (phones.length > 0) {
        const { data: cp } = await supabase
          .from("customers")
          .select("id, phone")
          .eq("workspace_id", WS)
          .in("phone", [...new Set(phones)]);
        for (const c of cp || []) if (c.phone) phoneToCustomer.set(c.phone, c.id);
      }

      for (const row of rows) {
        if (row.email) {
          const m = emailToCustomer.get(row.email.toLowerCase());
          if (m) { row.customer_id = m; row.resolution_method = "email"; totalResolvedEmail++; continue; }
        }
        if (row.phone) {
          const m = phoneToCustomer.get(row.phone);
          if (m) { row.customer_id = m; row.resolution_method = "phone"; totalResolvedPhone++; continue; }
        }
        totalUnresolved++;
      }
    }

    // Upsert
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK);
      const { error } = await supabase
        .from("klaviyo_profile_staging")
        .upsert(chunk, { onConflict: "workspace_id,klaviyo_profile_id" });
      if (error) throw new Error(`upsert page ${pages}: ${error.message}`);
    }
    totalUpserted += rows.length;

    if (pages % 25 === 0) {
      const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
      const rate = (totalUpserted / ((Date.now() - t0) / 1000)).toFixed(1);
      console.log(`  page ${pages} | upserted ${totalUpserted} | email=${totalResolvedEmail} phone=${totalResolvedPhone} unresolved=${totalUnresolved} | ${elapsedMin}min @ ${rate}/sec`);
    }

    url = body.links?.next || null;
  }

  const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
  console.log(`\n✓ DONE — pages=${pages} upserted=${totalUpserted} email=${totalResolvedEmail} phone=${totalResolvedPhone} unresolved=${totalUnresolved} time=${elapsedMin}min`);
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
