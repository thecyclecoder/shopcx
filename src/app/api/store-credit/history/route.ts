import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { cookies } from "next/headers";
import { getStoreCreditHistory } from "@/lib/store-credit";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const customerId = searchParams.get("customerId");
  if (!customerId) return NextResponse.json({ error: "customerId required" }, { status: 400 });

  const history = await getStoreCreditHistory(workspaceId, customerId);
  return NextResponse.json({ history });
}
