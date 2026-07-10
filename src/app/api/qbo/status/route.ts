import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { getQboConnectionStatus, qboAppCreds } from "@/lib/quickbooks";

/** GET /api/qbo/status — non-secret connection status for the Integrations → QuickBooks card. */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "no workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let configured = true;
  try { qboAppCreds(); } catch { configured = false; }

  const status = await getQboConnectionStatus(workspaceId, admin);
  return NextResponse.json({ ...status, configured });
}
