import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getEasyPostClient } from "@/lib/easypost";

// POST — test EasyPost connection by creating a test address
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const client = await getEasyPostClient(workspaceId);

    // Create a test address to verify the API key works
    await client.Address.create({
      street1: "417 Montgomery Street",
      city: "San Francisco",
      state: "CA",
      zip: "94104",
      country: "US",
      verify: ["delivery"],
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[test-connection] EasyPost test failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Connection failed" },
      { status: 500 },
    );
  }
}
