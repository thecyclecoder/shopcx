/**
 * GET /api/developer/realtime-demo — the initial snapshot for the Realtime verification panel.
 *
 * The app reads data client-side through server routes (session-authed), NOT via a browser-side
 * PostgREST call — the browser Supabase client here is used ONLY for the Realtime WebSocket
 * subscription. This route returns the current `realtime_demo` rows so the panel isn't empty before
 * the first live event; every subsequent update arrives over the subscription, not by polling this.
 *
 * See docs/brain/dashboard/realtime-test.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET() {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("realtime_demo")
    .select("id, workspace_id, label, tick, note, updated_at")
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ rows: data ?? [] });
}
