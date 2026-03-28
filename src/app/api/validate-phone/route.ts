import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const phone = req.nextUrl.searchParams.get("phone");
  if (!phone) return NextResponse.json({ valid: false, error: "Phone required" });

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    // No Twilio — basic format check only
    const digits = phone.replace(/\D/g, "");
    return NextResponse.json({ valid: digits.length >= 10, lineType: null });
  }

  try {
    const res = await fetch(
      `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phone)}?Fields=line_type_intelligence`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        },
      }
    );

    if (!res.ok) {
      if (res.status === 404) {
        return NextResponse.json({ valid: false, error: "This number doesn't appear to be valid" });
      }
      return NextResponse.json({ valid: true, lineType: null }); // Fail open
    }

    const data = await res.json();
    const lineType = data.line_type_intelligence?.type || null;
    const valid = data.valid || true;

    return NextResponse.json({ valid, lineType });
  } catch {
    return NextResponse.json({ valid: true, lineType: null }); // Fail open
  }
}
