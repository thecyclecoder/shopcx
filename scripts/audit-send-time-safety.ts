/**
 * TCPA safety audit. For a sample of SMS-subscribed customers,
 * resolve their timezone the same way the scheduler does, compute
 * the UTC instant for the campaign's 9 AM local time, then convert
 * back to local-of-resolved-tz to confirm it really is 9 AM.
 *
 * Flags any case where the computed instant lands < 8 AM local in
 * the resolved tz — that would be a TCPA pre-8am violation.
 *
 * Also samples whether customers.timezone is populated and what
 * the value distribution looks like.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
import { resolveRecipientTimezone, computeSendInstant } from "@/lib/marketing-text-timezone";

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const FALLBACK_TZ = "America/Chicago";
const TARGET_HOUR = 9;
const FALLBACK_HOUR = 10;
const SEND_DATE = new Date().toISOString().slice(0, 10);

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });

  // ── 1. customers.timezone distribution ──
  console.log("=== customers.timezone column distribution (SMS-subscribed) ===");
  const { count: total } = await sb.from("customers").select("id", { count: "exact", head: true }).eq("workspace_id", W).eq("sms_marketing_status", "subscribed");
  const { count: withTz } = await sb.from("customers").select("id", { count: "exact", head: true }).eq("workspace_id", W).eq("sms_marketing_status", "subscribed").not("timezone", "is", null);
  console.log(`  SMS-sub total: ${total}`);
  console.log(`  with non-null timezone: ${withTz} (${((withTz!/total!)*100).toFixed(1)}%)`);

  // Sample distinct timezone values
  const { data: tzSample } = await sb.from("customers").select("timezone").eq("workspace_id", W).eq("sms_marketing_status", "subscribed").not("timezone", "is", null).limit(1000);
  const tzCounts = new Map<string, number>();
  for (const c of tzSample || []) tzCounts.set(c.timezone, (tzCounts.get(c.timezone) || 0) + 1);
  console.log(`  Distinct timezone values in sample of 1000:`);
  for (const [tz, n] of [...tzCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${tz.padEnd(28)} ${n}`);
  }

  // ── 2. End-to-end safety check on 50 sample customers ──
  console.log("\n=== End-to-end audit on 50 sample customers ===");
  const { data: sample } = await sb.from("customers").select("id, email, timezone, default_address, phone").eq("workspace_id", W).eq("sms_marketing_status", "subscribed").limit(50);

  // Stats
  let unsafe = 0;
  let safe = 0;
  const sourceCounts: Record<string, { total: number; unsafe: number }> = {};
  const offsetDist: Record<number, number> = {};
  const examples: Array<{ email: string; tz: string; src: string; utc: string; localHour: number }> = [];

  for (const c of sample || []) {
    const resolved = resolveRecipientTimezone(c, FALLBACK_TZ);
    const plannedHour = resolved.source === "fallback" ? FALLBACK_HOUR : TARGET_HOUR;
    const utc = computeSendInstant(SEND_DATE, plannedHour, resolved.timezone);

    // Convert UTC back to local hour in resolved tz to verify round-trip
    const localHourStr = utc.toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: resolved.timezone });
    const localHour = parseInt(localHourStr, 10);

    if (!sourceCounts[resolved.source]) sourceCounts[resolved.source] = { total: 0, unsafe: 0 };
    sourceCounts[resolved.source].total++;
    if (localHour < 8) {
      sourceCounts[resolved.source].unsafe++;
      unsafe++;
      console.log(`  UNSAFE: ${c.email} | tz=${resolved.timezone} src=${resolved.source} → UTC ${utc.toISOString()} → ${localHour}:00 local`);
    } else {
      safe++;
      if (examples.length < 10) examples.push({ email: c.email, tz: resolved.timezone, src: resolved.source, utc: utc.toISOString(), localHour });
    }
    offsetDist[localHour] = (offsetDist[localHour] || 0) + 1;
  }

  console.log(`\nResults: safe=${safe}, unsafe(<8am)=${unsafe}, total=${sample!.length}`);
  console.log("\nBy source:");
  for (const [src, s] of Object.entries(sourceCounts)) {
    console.log(`  ${src.padEnd(20)} ${s.total} total, ${s.unsafe} unsafe`);
  }
  console.log("\nLocal-hour distribution (should all be 8+):");
  for (const h of Object.keys(offsetDist).sort((a, b) => +a - +b)) {
    console.log(`  ${String(h).padStart(2, "0")}:00  ${offsetDist[+h]}`);
  }
  console.log("\nFirst 10 safe examples:");
  for (const e of examples) {
    console.log(`  ${e.email} | ${e.tz} (${e.src}) → ${e.utc} → ${e.localHour}:00`);
  }

  // ── 3. Test the case where resolved tz might be wrong ──
  // E.g. customer.timezone says New_York but they're actually in LA — we'd
  // schedule 9 AM NY which is 6 AM LA. Without ground-truth we can't check
  // this directly, but we CAN ensure our COMPUTED instant is right relative
  // to the TZ we picked. The above check does that.
  console.log("\n=== Manual sanity checks ===");
  const eastSample = sample!.find(c => {
    const r = resolveRecipientTimezone(c, FALLBACK_TZ);
    return r.timezone === "America/New_York";
  });
  if (eastSample) {
    const r = resolveRecipientTimezone(eastSample, FALLBACK_TZ);
    const utc9 = computeSendInstant(SEND_DATE, 9, r.timezone);
    console.log(`  Eastern recipient: 9 AM ET = ${utc9.toISOString()} UTC`);
    console.log(`    UTC reads as ET: ${utc9.toLocaleString("en-US", { timeZone: "America/New_York" })}`);
    console.log(`    UTC reads as CT: ${utc9.toLocaleString("en-US", { timeZone: "America/Chicago" })}`);
    console.log(`    UTC reads as PT: ${utc9.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}`);
  }
  const westSample = sample!.find(c => {
    const r = resolveRecipientTimezone(c, FALLBACK_TZ);
    return r.timezone === "America/Los_Angeles";
  });
  if (westSample) {
    const r = resolveRecipientTimezone(westSample, FALLBACK_TZ);
    const utc9 = computeSendInstant(SEND_DATE, 9, r.timezone);
    console.log(`  Pacific recipient: 9 AM PT = ${utc9.toISOString()} UTC`);
    console.log(`    UTC reads as PT: ${utc9.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}`);
    console.log(`    UTC reads as ET: ${utc9.toLocaleString("en-US", { timeZone: "America/New_York" })}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
