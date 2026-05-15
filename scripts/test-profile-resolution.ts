/**
 * Test the Klaviyo profile → customer resolution logic on a 100-event
 * sample. No DB writes. Just reports how often the match succeeds and
 * what the failure shapes look like.
 *
 * Match policy (per user, May 15 2026):
 *   1. Email match (case-insensitive) — if Klaviyo profile has an email
 *      that matches a customer.email, resolved.
 *   2. Phone match (exact) — fallback if no email match.
 *   3. Otherwise → null customer_id. These are typically phone-only
 *      Klaviyo profiles that represent non-buyers we have no record of.
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

import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SAMPLE_SIZE = 100;

async function main() {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces")
    .select("klaviyo_api_key_encrypted").eq("id", W).single();
  const apiKey = decrypt(ws!.klaviyo_api_key_encrypted);

  // Step 1: sample 100 distinct profile_ids from attributed Received SMS events
  console.log("=== Sampling 100 distinct profile_ids from attributed events ===");
  const profileIds = new Set<string>();
  let lastDt: string | null = null;
  while (profileIds.size < SAMPLE_SIZE * 3) {  // overfetch to ensure 100 unique
    let q = admin.from("klaviyo_profile_events")
      .select("klaviyo_profile_id, datetime")
      .eq("workspace_id", W)
      .not("attributed_klaviyo_campaign_id", "is", null)
      .order("datetime", { ascending: true })
      .limit(1000);
    if (lastDt) q = q.gt("datetime", lastDt);
    const { data } = await q;
    if (!data || data.length === 0) break;
    for (const r of data) {
      profileIds.add(r.klaviyo_profile_id);
      if (profileIds.size >= SAMPLE_SIZE * 3) break;
    }
    lastDt = data[data.length - 1].datetime;
    if (data.length < 1000) break;
  }
  // Take first N
  const sample = [...profileIds].slice(0, SAMPLE_SIZE);
  console.log(`Sampled ${sample.length} profile_ids\n`);

  // Step 2: batch-fetch from Klaviyo (max ~100 IDs per request)
  console.log("=== Fetching profile data from Klaviyo ===");
  const filter = `any(id,[${sample.map(id => `"${id}"`).join(",")}])`;
  const url = `https://a.klaviyo.com/api/profiles?filter=${encodeURIComponent(filter)}&page[size]=100`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      revision: "2025-01-15",
      Accept: "application/json",
    },
  });
  if (!r.ok) { console.error("Klaviyo error:", r.status, await r.text()); return; }
  const body = await r.json() as {
    data: Array<{
      id: string;
      attributes?: { email?: string | null; phone_number?: string | null; first_name?: string | null; last_name?: string | null };
    }>;
  };
  console.log(`Got ${body.data.length} profiles back from Klaviyo\n`);

  // Step 3: for each profile, try resolution
  console.log("=== Attempting customer resolution per profile ===");

  // Build email + phone lookups in one query each — way faster than per-row queries
  const emails = body.data.map(p => p.attributes?.email).filter((e): e is string => !!e).map(e => e.toLowerCase());
  const phones = body.data.map(p => p.attributes?.phone_number).filter((p): p is string => !!p);

  const emailToCustomer = new Map<string, string>();
  if (emails.length > 0) {
    // Need to do case-insensitive match — fetch then compare in memory since `.in()` is case-sensitive
    const { data: ce } = await admin.from("customers")
      .select("id, email")
      .eq("workspace_id", W)
      .in("email", [...new Set(emails)].concat([...new Set(emails)].map(e => e.toUpperCase()))); // hack: try both cases
    for (const c of ce || []) if (c.email) emailToCustomer.set(c.email.toLowerCase(), c.id);
  }
  const phoneToCustomer = new Map<string, string>();
  if (phones.length > 0) {
    const { data: cp } = await admin.from("customers")
      .select("id, phone")
      .eq("workspace_id", W)
      .in("phone", [...new Set(phones)]);
    for (const c of cp || []) if (c.phone) phoneToCustomer.set(c.phone, c.id);
  }

  // Categorize
  const stats = {
    resolved_by_email: 0,
    resolved_by_phone: 0,
    phone_only_no_match: 0,         // had only phone, phone didn't match any customer
    email_no_match: 0,              // had email, didn't match
    no_email_or_phone: 0,           // profile has neither (shouldn't happen)
    klaviyo_didnt_return: 0,        // we asked but Klaviyo didn't return this id
  };
  const samples = {
    resolved_by_email: [] as string[],
    resolved_by_phone: [] as string[],
    phone_only_no_match: [] as string[],
    email_no_match: [] as string[],
  };

  const klaviyoMap = new Map<string, typeof body.data[number]>();
  for (const p of body.data) klaviyoMap.set(p.id, p);

  for (const profileId of sample) {
    const p = klaviyoMap.get(profileId);
    if (!p) { stats.klaviyo_didnt_return++; continue; }
    const email = p.attributes?.email;
    const phone = p.attributes?.phone_number;
    if (!email && !phone) { stats.no_email_or_phone++; continue; }

    // Try email match first
    if (email) {
      const customerId = emailToCustomer.get(email.toLowerCase());
      if (customerId) {
        stats.resolved_by_email++;
        if (samples.resolved_by_email.length < 3) samples.resolved_by_email.push(`${profileId} (${email}) → ${customerId}`);
        continue;
      }
    }
    // Try phone match
    if (phone) {
      const customerId = phoneToCustomer.get(phone);
      if (customerId) {
        stats.resolved_by_phone++;
        if (samples.resolved_by_phone.length < 3) samples.resolved_by_phone.push(`${profileId} (${phone}) → ${customerId}`);
        continue;
      }
    }
    // Unresolved — categorize
    if (email) {
      stats.email_no_match++;
      if (samples.email_no_match.length < 3) samples.email_no_match.push(`${profileId} (email=${email}, phone=${phone || "none"})`);
    } else {
      stats.phone_only_no_match++;
      if (samples.phone_only_no_match.length < 3) samples.phone_only_no_match.push(`${profileId} (phone=${phone})`);
    }
  }

  // Report
  console.log("\n=== Resolution breakdown ===");
  console.log(`  Resolved by email:        ${stats.resolved_by_email} (${(stats.resolved_by_email/sample.length*100).toFixed(0)}%)`);
  console.log(`  Resolved by phone:        ${stats.resolved_by_phone} (${(stats.resolved_by_phone/sample.length*100).toFixed(0)}%)`);
  console.log(`  Total resolved:           ${stats.resolved_by_email + stats.resolved_by_phone} (${((stats.resolved_by_email + stats.resolved_by_phone)/sample.length*100).toFixed(0)}%)`);
  console.log("");
  console.log(`  Phone-only, no match:     ${stats.phone_only_no_match} (would get NULL customer_id)`);
  console.log(`  Email-having, no match:   ${stats.email_no_match} (would get NULL customer_id — surprising, worth investigating)`);
  console.log(`  No email or phone:        ${stats.no_email_or_phone}`);
  console.log(`  Klaviyo didn't return:    ${stats.klaviyo_didnt_return}`);

  console.log("\n=== Samples ===");
  console.log("Resolved by email:");
  for (const s of samples.resolved_by_email) console.log("  " + s);
  console.log("Resolved by phone:");
  for (const s of samples.resolved_by_phone) console.log("  " + s);
  console.log("Phone-only no match:");
  for (const s of samples.phone_only_no_match) console.log("  " + s);
  console.log("Email-having no match (investigate):");
  for (const s of samples.email_no_match) console.log("  " + s);
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
