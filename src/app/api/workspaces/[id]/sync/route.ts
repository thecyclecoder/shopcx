import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getShopifyCounts,
  syncCustomerPages,
  syncOrderPages,
  finalizeSyncOrderDates,
} from "@/lib/shopify-sync";
import { updateRetentionScores } from "@/lib/retention-score";

// GET: return total counts for progress bar
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  void request;

  try {
    const counts = await getShopifyCounts(workspaceId);
    return NextResponse.json(counts);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to get counts" },
      { status: 500 }
    );
  }
}

// POST: sync one page at a time
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { type, cursor } = body as { type: string; cursor: string | null };

  try {
    if (type === "customers") {
      const result = await syncCustomerPages(workspaceId, cursor || null);
      return NextResponse.json(result);
    }

    if (type === "orders") {
      const result = await syncOrderPages(workspaceId, cursor || null);
      return NextResponse.json(result);
    }

    if (type === "finalize") {
      await finalizeSyncOrderDates(workspaceId);
      await updateRetentionScores(workspaceId);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sync failed" },
      { status: 500 }
    );
  }
}
