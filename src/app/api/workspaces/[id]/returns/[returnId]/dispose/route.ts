import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { disposeReturnItems } from "@/lib/shopify-returns";
import type { Disposition } from "@/lib/shopify-returns";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; returnId: string }> },
) {
  const { id: workspaceId, returnId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { disposition, locationId } = body as { disposition: Disposition; locationId?: string };

  if (!disposition) {
    return NextResponse.json({ error: "disposition is required" }, { status: 400 });
  }

  if (disposition === "RESTOCKED" && !locationId) {
    return NextResponse.json({ error: "locationId is required for RESTOCKED disposition" }, { status: 400 });
  }

  const result = await disposeReturnItems(workspaceId, {
    returnId,
    disposition,
    locationId,
  });

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}
