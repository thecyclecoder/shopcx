import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

// POST: Abandon a journey session
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  void request;
  const admin = createAdminClient();

  const { data: session } = await admin
    .from("journey_sessions")
    .select("id, workspace_id, status, current_step")
    .eq("token", token)
    .single();

  if (!session) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (session.status === "completed" || session.status === "abandoned") {
    return NextResponse.json({ success: true });
  }

  await admin
    .from("journey_sessions")
    .update({ status: "abandoned" })
    .eq("id", session.id);

  // Only fire event if they got past step 0
  if (session.current_step > 0) {
    await inngest.send({
      name: "journey/session.abandoned",
      data: { session_id: session.id, workspace_id: session.workspace_id },
    });
  }

  return NextResponse.json({ success: true });
}
