/**
 * List Twilio numbers + shortcodes available on the account.
 * Used by the Text Marketing settings page to give the admin a
 * pick-from-list flow instead of typing the number from memory.
 *
 * Twilio account creds are global env vars (TWILIO_ACCOUNT_SID +
 * TWILIO_AUTH_TOKEN) — same as src/lib/twilio.ts. We're a
 * single-account setup; if we ever do per-workspace Twilio accounts
 * the cred lookup moves here.
 *
 * Returns BOTH long codes and shortcodes in one response, lightly
 * shaped so the UI can render a single picker list.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

interface TwilioPhoneRow {
  sid: string;
  phone_number: string;
  friendly_name: string | null;
  capabilities?: { sms?: boolean; mms?: boolean; voice?: boolean };
  // Shortcodes use `short_code` not `phone_number`.
  short_code?: string;
}

interface NumberOption {
  phone_number: string;       // normalized — bare digits for shortcodes, +1XXX… for long codes
  display: string;            // human label
  type: "long_code" | "shortcode";
  capabilities: { sms: boolean; mms: boolean; voice: boolean };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin", "marketing"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    return NextResponse.json({ error: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not configured" }, { status: 500 });
  }
  const authHeader = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;

  // Fire both list calls in parallel.
  const [longRes, shortRes] = await Promise.all([
    fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PageSize=200`, {
      headers: { Authorization: authHeader },
    }),
    fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/ShortCodes.json?PageSize=200`, {
      headers: { Authorization: authHeader },
    }),
  ]);

  if (!longRes.ok) {
    const text = await longRes.text().catch(() => "");
    return NextResponse.json({ error: `Twilio IncomingPhoneNumbers error: ${longRes.status} ${text.slice(0, 200)}` }, { status: 502 });
  }
  if (!shortRes.ok) {
    const text = await shortRes.text().catch(() => "");
    return NextResponse.json({ error: `Twilio ShortCodes error: ${shortRes.status} ${text.slice(0, 200)}` }, { status: 502 });
  }

  const longData = await longRes.json() as { incoming_phone_numbers?: TwilioPhoneRow[] };
  const shortData = await shortRes.json() as { short_codes?: TwilioPhoneRow[] };

  const numbers: NumberOption[] = [];

  for (const r of longData.incoming_phone_numbers || []) {
    numbers.push({
      phone_number: r.phone_number,
      display: formatLongCode(r.phone_number, r.friendly_name),
      type: "long_code",
      capabilities: {
        sms: !!r.capabilities?.sms,
        mms: !!r.capabilities?.mms,
        voice: !!r.capabilities?.voice,
      },
    });
  }

  for (const r of shortData.short_codes || []) {
    const sc = r.short_code || "";
    numbers.push({
      phone_number: sc,
      display: r.friendly_name ? `${sc} — ${r.friendly_name}` : sc,
      type: "shortcode",
      // Shortcodes are SMS+MMS by default in the US; Twilio's API
      // doesn't expose capabilities here, so we assume both.
      capabilities: { sms: true, mms: true, voice: false },
    });
  }

  return NextResponse.json({ numbers });
}

/**
 * Pretty-print a US long code like "+18005551234" → "(800) 555-1234"
 * with the friendly name appended in parens when set + non-empty.
 */
function formatLongCode(phone: string, friendly: string | null | undefined): string {
  const digits = phone.replace(/\D/g, "");
  let pretty = phone;
  if (digits.length === 11 && digits.startsWith("1")) {
    pretty = `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (friendly && friendly !== phone && friendly.trim()) {
    return `${pretty} — ${friendly}`;
  }
  return pretty;
}
