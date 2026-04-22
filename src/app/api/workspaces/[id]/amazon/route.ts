import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encrypt, decrypt } from "@/lib/crypto";
import { inngest } from "@/lib/inngest/client";
import { spApiRequest } from "@/lib/amazon/auth";

// GET: list Amazon connections
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data } = await admin
    .from("amazon_connections")
    .select("id, seller_id, marketplace_id, seller_name, is_active, last_sync_at, created_at")
    .eq("workspace_id", workspaceId);

  return NextResponse.json(data || []);
}

// POST: save new connection or test existing
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { action, seller_id, marketplace_id, refresh_token, connection_id } = body;

  const admin = createAdminClient();

  if (action === "test") {
    // Test existing connection
    if (!connection_id) return NextResponse.json({ error: "connection_id required" }, { status: 400 });

    const { data: conn } = await admin.from("amazon_connections")
      .select("id, marketplace_id")
      .eq("id", connection_id)
      .eq("workspace_id", workspaceId)
      .single();

    if (!conn) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

    try {
      const res = await spApiRequest(connection_id, conn.marketplace_id, "GET", "/sellers/v1/marketplaceParticipations");
      if (!res.ok) throw new Error(`SP-API returned ${res.status}`);
      return NextResponse.json({ ok: true, message: "Connection successful" });
    } catch (err) {
      return NextResponse.json({ ok: false, error: String(err) }, { status: 400 });
    }
  }

  if (action === "sync-orders") {
    if (!connection_id) return NextResponse.json({ error: "connection_id required" }, { status: 400 });
    const days = body.days || 30;

    await inngest.send({
      name: "amazon/sync-orders",
      data: { workspace_id: workspaceId, connection_id, days },
    });

    return NextResponse.json({ ok: true, message: `Order sync triggered (${days} days)` });
  }

  if (action === "sync-asins") {
    if (!connection_id) return NextResponse.json({ error: "connection_id required" }, { status: 400 });

    await inngest.send({
      name: "amazon/sync-asins",
      data: { workspace_id: workspaceId, connection_id },
    });

    return NextResponse.json({ ok: true, message: "ASIN sync triggered" });
  }

  // Save new connection
  if (!seller_id || !refresh_token) {
    return NextResponse.json({ error: "seller_id and refresh_token required" }, { status: 400 });
  }

  const { data: conn, error } = await admin.from("amazon_connections").upsert({
    workspace_id: workspaceId,
    seller_id,
    marketplace_id: marketplace_id || "ATVPDKIKX0DER",
    refresh_token_encrypted: encrypt(refresh_token),
    seller_name: body.seller_name || null,
    is_active: true,
  }, { onConflict: "workspace_id,seller_id" }).select("id").single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Auto-trigger ASIN sync
  if (conn) {
    await inngest.send({
      name: "amazon/sync-asins",
      data: { workspace_id: workspaceId, connection_id: conn.id },
    });
  }

  return NextResponse.json({ ok: true, connection_id: conn?.id }, { status: 201 });
}
