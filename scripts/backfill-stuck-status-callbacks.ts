/**
 * Backfill: query Twilio for every recipient row currently stuck in
 * 'scheduled' status whose scheduled_send_at has passed. Twilio
 * already delivered them, but status callbacks fired against the
 * pre-fix handler which silently no-op'd. This script catches them up.
 *
 * Idempotent — safe to re-run.
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

const SID = process.env.TWILIO_ACCOUNT_SID!;
const TOKEN = process.env.TWILIO_AUTH_TOKEN!;
const AUTH = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64");
const CAMPAIGN_IDS = [
  "097b86b7-3135-4605-a4b6-c25d246bac14",
  "28477cd2-f195-415d-b1fa-45afffa21df9",
  "cce11d61-7623-4aa1-af16-7cbdedfdd534",
  "7e613281-acbc-40ad-8cae-77836b6c55c7",
];
const CONCURRENCY = 30;

function classifyTwilioError(code: number | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case 21211: case 21217: case 21407: case 21421: case 21614: case 21660: return "invalid";
    case 21408: case 21612: return "carrier_violation";
    case 21610: return "unsubscribed";
    case 30003: case 30004: case 30005: case 30006: case 30007: case 30008: return "blocked";
    default: return null;
  }
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log("Loading stuck recipients (status='scheduled' AND scheduled_send_at <= now)...");
  const stuck: Array<{ id: string; message_sid: string; customer_id: string | null; scheduled_send_at: string }> = [];
  let lastId: string | null = null;
  while (true) {
    let q = sb.from("sms_campaign_recipients")
      .select("id, message_sid, customer_id, scheduled_send_at")
      .in("campaign_id", CAMPAIGN_IDS)
      .eq("status", "scheduled")
      .lte("scheduled_send_at", new Date().toISOString())
      .not("message_sid", "is", null)
      .order("id", { ascending: true })
      .limit(1000);
    if (lastId) q = q.gt("id", lastId);
    const { data } = await q;
    if (!data || data.length === 0) break;
    for (const r of data) stuck.push(r as { id: string; message_sid: string; customer_id: string | null; scheduled_send_at: string });
    lastId = data[data.length - 1].id;
    if (data.length < 1000) break;
  }
  console.log(`${stuck.length} stuck rows to reconcile`);

  let delivered = 0, sent = 0, failedPerm = 0, failed = 0, other = 0, errors = 0;
  const t0 = Date.now();
  const now = new Date().toISOString();

  async function one(r: typeof stuck[number]) {
    try {
      const tr = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages/${r.message_sid}.json`, { headers: { Authorization: AUTH } });
      if (!tr.ok) { errors++; return; }
      const m = await tr.json();
      const status = m.status as string;
      const errCode = m.error_code as number | null;
      const errMsg = m.error_message as string | null;
      const dateSent = m.date_sent as string | null;

      if (status === "delivered") {
        await sb.from("sms_campaign_recipients").update({
          status: "delivered",
          delivered_at: now,
          sent_at: dateSent ? new Date(dateSent).toISOString() : null,
          updated_at: now,
        }).eq("id", r.id).eq("status", "scheduled");
        delivered++;
      } else if (status === "sent") {
        await sb.from("sms_campaign_recipients").update({
          status: "sent",
          sent_at: dateSent ? new Date(dateSent).toISOString() : now,
          updated_at: now,
        }).eq("id", r.id).eq("status", "scheduled");
        sent++;
      } else if (status === "undelivered" || status === "failed") {
        const phoneStatus = classifyTwilioError(errCode || undefined);
        const isFatal = phoneStatus !== null;
        await sb.from("sms_campaign_recipients").update({
          status: isFatal ? "failed_permanent" : "failed",
          error: errCode ? `${errCode}: ${errMsg || ""}` : errMsg || "carrier failure",
          updated_at: now,
        }).eq("id", r.id);
        if (isFatal && r.customer_id) {
          await sb.from("customers").update({
            phone_status: phoneStatus,
            phone_status_code: errCode,
            phone_status_at: now,
          }).eq("id", r.customer_id);
          failedPerm++;
        } else {
          failed++;
        }
      } else {
        other++;
      }
    } catch {
      errors++;
    }
  }

  for (let i = 0; i < stuck.length; i += CONCURRENCY) {
    const wave = stuck.slice(i, i + CONCURRENCY);
    await Promise.all(wave.map(one));
    if ((i + CONCURRENCY) % 300 === 0 || (i + CONCURRENCY) >= stuck.length) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ${Math.min(i + CONCURRENCY, stuck.length)}/${stuck.length} | delivered=${delivered} sent=${sent} fail_perm=${failedPerm} fail=${failed} other=${other} err=${errors} | ${elapsed}s`);
    }
  }

  console.log(`\n✓ DONE — delivered=${delivered} sent=${sent} failed_permanent=${failedPerm} failed=${failed} other=${other} errors=${errors} time=${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
