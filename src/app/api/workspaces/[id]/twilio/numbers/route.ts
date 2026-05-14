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

  // Fire both list calls in parallel. Partial-success pattern: one
  // failure (e.g. shortcode endpoint denied for the account) doesn't
  // kill the whole response — we surface per-endpoint warnings so the
  // UI can render what loaded plus an explanation for what didn't.
  //
  // Note: Twilio's shortcode endpoint sits under /SMS/ — easy to
  // miss because the long-code endpoint doesn't.
  const [longResult, shortResult] = await Promise.allSettled([
    fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PageSize=200`, {
      headers: { Authorization: authHeader },
    }),
    fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/SMS/ShortCodes.json?PageSize=200`, {
      headers: { Authorization: authHeader },
    }),
  ]);

  const warnings: string[] = [];
  const numbers: NumberOption[] = [];

  // Long codes
  if (longResult.status === "fulfilled" && longResult.value.ok) {
    const data = await longResult.value.json() as { incoming_phone_numbers?: TwilioPhoneRow[] };
    for (const r of data.incoming_phone_numbers || []) {
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
  } else if (longResult.status === "fulfilled") {
    const text = await longResult.value.text().catch(() => "");
    warnings.push(`Long codes: ${longResult.value.status} ${text.slice(0, 200)}`);
  } else {
    warnings.push(`Long codes: ${String(longResult.reason).slice(0, 200)}`);
  }

  // Shortcodes
  if (shortResult.status === "fulfilled" && shortResult.value.ok) {
    const data = await shortResult.value.json() as { short_codes?: TwilioPhoneRow[] };
    for (const r of data.short_codes || []) {
      const sc = r.short_code || "";
      numbers.push({
        phone_number: sc,
        display: r.friendly_name ? `${sc} — ${r.friendly_name}` : sc,
        type: "shortcode",
        capabilities: { sms: true, mms: true, voice: false },
      });
    }
  } else if (shortResult.status === "fulfilled") {
    const text = await shortResult.value.text().catch(() => "");
    warnings.push(`Shortcodes: ${shortResult.value.status} ${text.slice(0, 200)}`);
  } else {
    warnings.push(`Shortcodes: ${String(shortResult.reason).slice(0, 200)}`);
  }

  // If BOTH failed, treat it as a hard error so the UI surfaces it
  // distinctly from "loaded but the list is empty."
  if (numbers.length === 0 && warnings.length === 2) {
    return NextResponse.json({ error: warnings.join(" | ") }, { status: 502 });
  }

  return NextResponse.json({ numbers, warnings });
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
