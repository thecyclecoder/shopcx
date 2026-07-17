import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { cookies } from "next/headers";
import { disconnectSlack } from "@/lib/slack";

export async function POST() {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "no workspace" }, { status: 400 });

  await disconnectSlack(workspaceId);
  return NextResponse.json({ ok: true });
}
