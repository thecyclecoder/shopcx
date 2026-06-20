/**
 * Reconcile storefront_leads.sms_status against the Twilio truth.
 *
 * Why: the popup-coupon SMS historically sent direct from the short code with
 * NO StatusCallback (and not via the Messaging Service whose callback is
 * wired), so Twilio never reported delivery back and storefront_leads.sms_status
 * froze at the `queued` we wrote on send — even after Twilio delivered the text
 * (ticket 8e9e325e; Harvey's WELCOME-P2RJD was delivered but read `queued`).
 * The popup send now passes an explicit StatusCallback so new rows advance
 * truthfully; this backfills the rows sent BEFORE that fix.
 *
 * Match: storefront_leads with sms_status='queued' AND sms_message_sid present.
 * For each, GET the Twilio Messages API (account-level credentials) and sync
 * sms_status + sms_status_at to the real Twilio status (and date_updated).
 *
 * Idempotent (re-running re-reads Twilio; only writes when the status differs)
 * and resumable (cursor-paginated by created_at). Defaults to dry-run; pass
 * --apply to write.
 *
 *   npx tsx scripts/backfill-popup-sms-status.ts            # dry-run
 *   npx tsx scripts/backfill-popup-sms-status.ts --apply    # write
 */
import { createAdminClient } from "./_bootstrap";

const APPLY = process.argv.includes("--apply");
const PAGE = 500;

type LeadRow = {
  id: string;
  email: string | null;
  sms_message_sid: string | null;
  sms_status: string | null;
  created_at: string;
};

type TwilioMessage = {
  sid: string;
  status: string; // queued | sending | sent | delivered | undelivered | failed | ...
  date_updated?: string | null; // RFC 2822, e.g. "Sat, 20 Jun 2026 03:23:47 +0000"
  date_sent?: string | null;
  error_code?: number | null;
};

/** GET a single message from the Twilio REST API. Returns null on any error. */
async function fetchTwilioMessage(
  accountSid: string,
  authToken: string,
  messageSid: string,
): Promise<TwilioMessage | null> {
  const authHeader = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}.json`,
    { headers: { Authorization: `Basic ${authHeader}` } },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.log(`  ✗ ${messageSid}: Twilio ${res.status} ${err.message || ""}`.trim());
    return null;
  }
  return (await res.json()) as TwilioMessage;
}

/** Convert Twilio's date_updated (RFC 2822) to an ISO string, or null. */
function toIso(d: string | null | undefined): string | null {
  if (!d) return null;
  const ms = Date.parse(d);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

async function main() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set");
  }

  const admin = createAdminClient();
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log("Scanning storefront_leads stuck at sms_status='queued' with a message SID...\n");

  let cursor = "1970-01-01T00:00:00Z";
  let scanned = 0;
  let toFix = 0;
  let fixed = 0;
  const samples: string[] = [];

  for (;;) {
    const { data: rows, error } = await admin
      .from("storefront_leads")
      .select("id, email, sms_message_sid, sms_status, created_at")
      .eq("sms_status", "queued")
      .not("sms_message_sid", "is", null)
      .gt("created_at", cursor)
      .order("created_at", { ascending: true })
      .limit(PAGE);
    if (error) throw new Error(error.message);
    if (!rows || rows.length === 0) break;

    for (const lead of rows as LeadRow[]) {
      scanned++;
      const sid = lead.sms_message_sid;
      if (!sid) continue;

      const msg = await fetchTwilioMessage(accountSid, authToken, sid);
      if (!msg) continue;

      // Twilio still says queued → genuinely stuck, nothing to sync yet.
      if (msg.status === "queued") continue;

      toFix++;
      const statusAt = toIso(msg.date_updated) || toIso(msg.date_sent) || new Date().toISOString();
      if (samples.length < 15) {
        samples.push(
          `  ${lead.email || lead.id.slice(0, 8)} ${sid.slice(0, 10)}… queued → ${msg.status}` +
            (msg.error_code ? ` (err ${msg.error_code})` : ""),
        );
      }
      if (APPLY) {
        const { error: upErr } = await admin
          .from("storefront_leads")
          .update({ sms_status: msg.status, sms_status_at: statusAt, updated_at: new Date().toISOString() })
          .eq("id", lead.id);
        if (upErr) console.log(`  ✗ ${lead.id}: ${upErr.message}`);
        else fixed++;
      }
    }
    cursor = (rows[rows.length - 1] as LeadRow).created_at;
    if (rows.length < PAGE) break;
  }

  console.log(samples.join("\n"));
  if (toFix > samples.length) console.log(`  ... and ${toFix - samples.length} more`);
  console.log(`\nScanned ${scanned} queued leads with a message SID.`);
  console.log(`${toFix} have a newer Twilio status to sync.`);
  if (APPLY) console.log(`✓ Updated ${fixed} leads.`);
  else console.log("\nDry-run only. Re-run with --apply to write.");
}

main().catch((e) => { console.error(e); process.exit(1); });
