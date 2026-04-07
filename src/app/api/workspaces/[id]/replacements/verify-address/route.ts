import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { verifyAddress } from "@/lib/easypost";

// POST — verify a shipping address via EasyPost
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { street1, street2, city, state, zip, country, name, phone } = body;

  if (!street1 || !city || !state || !zip) {
    return NextResponse.json({ error: "street1, city, state, and zip are required" }, { status: 400 });
  }

  try {
    const result = await verifyAddress(workspaceId, {
      street1,
      street2: street2 || undefined,
      city,
      state,
      zip,
      country: country || "US",
      name: name || undefined,
      phone: phone || undefined,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error("[verify-address] Failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Verification failed" }, { status: 500 });
  }
}
