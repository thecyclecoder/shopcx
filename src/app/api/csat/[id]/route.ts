import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createHmac } from "crypto";

function verifyCsatToken(ticketId: string, token: string): boolean {
  const secret = process.env.ENCRYPTION_KEY || "fallback";
  const expected = createHmac("sha256", secret).update(ticketId).digest("hex").slice(0, 32);
  if (expected.length !== token.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return result === 0;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: ticketId } = await params;
  const body = await request.json();
  const { score, token } = body;

  if (!token || !verifyCsatToken(ticketId, token)) {
    return NextResponse.json({ error: "Invalid token" }, { status: 403 });
  }

  if (!score || score < 1 || score > 5) {
    return NextResponse.json({ error: "Score must be 1-5" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("tickets")
    .update({ csat_score: score })
    .eq("id", ticketId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
