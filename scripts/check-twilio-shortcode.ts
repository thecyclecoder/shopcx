/**
 * Query Twilio for shortcode + sender details + throughput limits.
 *
 * Reports:
 *   - All short codes on the account (with country, capabilities)
 *   - All Messaging Services with attached senders
 *   - The configured workspace short code (from workspaces.twilio_phone_number)
 *
 * Twilio short code throughput is account-specific and surfaced via
 * the API as `mps` (messages per second). Standard short codes: ~100
 * MPS. Random short codes: ~30 MPS. Long codes: ~1 MPS. 10DLC: varies
 * by brand trust score.
 *
 * Usage:
 *   npx tsx scripts/check-twilio-shortcode.ts
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
const SID = process.env.TWILIO_ACCOUNT_SID!;
const TOKEN = process.env.TWILIO_AUTH_TOKEN!;
const AUTH = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64");

async function tw(path: string): Promise<unknown> {
  const url = path.startsWith("http") ? path : `https://api.twilio.com${path}`;
  const r = await fetch(url, { headers: { Authorization: AUTH } });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`${url}: ${r.status} ${text.slice(0, 300)}`);
  }
  return r.json();
}

async function twMessaging(path: string): Promise<unknown> {
  const r = await fetch(`https://messaging.twilio.com${path}`, { headers: { Authorization: AUTH } });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`messaging${path}: ${r.status} ${text.slice(0, 300)}`);
  }
  return r.json();
}

async function main() {
  // ── Workspace config ──
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data: ws } = await sb.from("workspaces").select("twilio_phone_number, name").eq("id", WS).single();
  console.log(`Workspace: ${ws?.name}`);
  console.log(`Configured sender (workspaces.twilio_phone_number): ${ws?.twilio_phone_number || "(none)"}\n`);

  // ── All short codes on the account ──
  console.log("══ Short codes on account ══");
  try {
    const sc = (await tw(`/2010-04-01/Accounts/${SID}/SMS/ShortCodes.json?PageSize=50`)) as {
      short_codes?: Array<{ short_code: string; sid: string; api_version: string; date_updated: string; sms_url: string | null; sms_method: string | null; sms_fallback_url: string | null; friendly_name: string | null }>;
    };
    if (!sc.short_codes || sc.short_codes.length === 0) {
      console.log("  (no short codes returned by /SMS/ShortCodes.json)\n");
    } else {
      for (const s of sc.short_codes) {
        console.log(`  ${s.short_code}  sid=${s.sid}  name=${s.friendly_name || "(none)"}`);
      }
      console.log();
    }
  } catch (e) {
    console.log(`  Error: ${(e as Error).message}\n`);
  }

  // ── Messaging Services ──
  console.log("══ Messaging Services ══");
  try {
    const ms = (await twMessaging("/v1/Services?PageSize=20")) as {
      services?: Array<{ sid: string; friendly_name: string; mps?: number; inbound_request_url?: string | null; us_app_to_person_registered?: boolean; usecase?: string | null; status_callback?: string | null }>;
    };
    if (!ms.services || ms.services.length === 0) {
      console.log("  (no messaging services on account)\n");
    } else {
      for (const s of ms.services) {
        console.log(`\n  Service: ${s.friendly_name}`);
        console.log(`    sid:           ${s.sid}`);
        console.log(`    use case:      ${s.usecase || "(unset)"}`);
        console.log(`    A2P registered: ${s.us_app_to_person_registered ?? "(unknown)"}`);
        // Attached short codes
        try {
          const scList = (await twMessaging(`/v1/Services/${s.sid}/ShortCodes`)) as {
            short_codes?: Array<{ short_code: string; sid: string; country_code: string; capabilities: { SMS?: boolean; MMS?: boolean } }>;
          };
          if (scList.short_codes && scList.short_codes.length > 0) {
            for (const sc of scList.short_codes) {
              console.log(`    short code:    ${sc.short_code} (${sc.country_code}, sms=${sc.capabilities?.SMS}, mms=${sc.capabilities?.MMS})`);
            }
          }
        } catch (e) {
          console.log(`    short codes:   error ${(e as Error).message}`);
        }
        // Attached phone numbers
        try {
          const pnList = (await twMessaging(`/v1/Services/${s.sid}/PhoneNumbers`)) as {
            phone_numbers?: Array<{ phone_number: string; sid: string; country_code: string; capabilities: string[] }>;
          };
          if (pnList.phone_numbers && pnList.phone_numbers.length > 0) {
            for (const pn of pnList.phone_numbers) {
              console.log(`    phone:         ${pn.phone_number} (${pn.country_code}, ${pn.capabilities.join(",")})`);
            }
          }
        } catch (e) {
          console.log(`    phones:        error ${(e as Error).message}`);
        }
      }
      console.log();
    }
  } catch (e) {
    console.log(`  Error: ${(e as Error).message}\n`);
  }

  // ── Account-level throughput hint ──
  console.log("══ Account info ══");
  try {
    const acct = (await tw(`/2010-04-01/Accounts/${SID}.json`)) as { friendly_name: string; status: string; type: string };
    console.log(`  ${acct.friendly_name} (${acct.type}, ${acct.status})`);
  } catch (e) {
    console.log(`  Error: ${(e as Error).message}`);
  }

  // ── Prepaid balance ──
  console.log("\n══ Prepaid balance ══");
  let balanceUsd: number | null = null;
  try {
    const bal = (await tw(`/2010-04-01/Accounts/${SID}/Balance.json`)) as { balance: string; currency: string };
    balanceUsd = parseFloat(bal.balance);
    console.log(`  ${bal.balance} ${bal.currency}`);
  } catch (e) {
    console.log(`  Error: ${(e as Error).message}`);
  }

  // ── Estimate sends remaining ──
  // US short code SMS (segment): ~$0.0075 per outbound. MMS: ~$0.020.
  // Carrier fees on top: ~$0.0030 per segment for SMS, ~$0.0080 for MMS.
  // Conservative all-in: $0.011 SMS / $0.028 MMS per recipient (1 segment).
  if (balanceUsd !== null) {
    const smsPerMsg = 0.011;
    const mmsPerMsg = 0.028;
    console.log(`\n══ Estimated headroom ══`);
    console.log(`  SMS (1 segment):  ~${Math.floor(balanceUsd / smsPerMsg).toLocaleString()} sends`);
    console.log(`  MMS:              ~${Math.floor(balanceUsd / mmsPerMsg).toLocaleString()} sends`);
    console.log(`  (rough — Twilio rates vary by destination + segment count + carrier fees)`);
  }

  // ── Recent send volume (rough estimate of current throughput) ──
  console.log("\n══ Last 7 days message volume ══");
  try {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const url = `/2010-04-01/Accounts/${SID}/Messages.json?DateSent%3E=${since}&PageSize=1`;
    const head = (await tw(url)) as { uri: string; page_size: number; first_page_uri: string; next_page_uri: string | null; messages?: Array<unknown> };
    // Twilio's pagination doesn't give total count, but we can check the first page to confirm the API is healthy.
    console.log(`  Last week's messages list endpoint reachable. (${head.messages?.length || 0} on first page)`);
  } catch (e) {
    console.log(`  Error: ${(e as Error).message}`);
  }

  console.log("\n💡 Short code MPS limit: not exposed on the API directly. Standard short codes default to 100 MPS (carriers permitting). Random short codes default to 30 MPS. Check console.twilio.com → Messaging → Senders → your short code → 'Throughput' for the real number provisioned for your account.");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
