import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

// POST: Complete a journey session
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const admin = createAdminClient();

  const { data: session } = await admin
    .from("journey_sessions")
    .select("id, workspace_id, status, config_snapshot")
    .eq("token", token)
    .single();

  if (!session) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (session.status === "completed") {
    return NextResponse.json({ success: true, message: "Already completed" });
  }
  if (session.status !== "in_progress") {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }

  const body = await request.json();
  const { outcome } = body;

  if (!outcome) return NextResponse.json({ error: "outcome required" }, { status: 400 });

  // Mark completed
  await admin
    .from("journey_sessions")
    .update({
      status: "completed",
      outcome,
      completed_at: new Date().toISOString(),
    })
    .eq("id", session.id);

  // Fire Inngest event for outcome processing
  await inngest.send({
    name: "journey/session.completed",
    data: {
      session_id: session.id,
      outcome,
      workspace_id: session.workspace_id,
    },
  });

  // Determine thank-you message from config
  const config = session.config_snapshot as {
    messages?: { completedSave?: string; completedCancel?: string; completedDefault?: string };
  } || {};
  const messages = config.messages || {};

  let message: string;
  if (outcome === "cancelled") {
    message = messages.completedCancel || "Your subscription has been cancelled. We're sorry to see you go.";
  } else if (outcome.startsWith("saved_")) {
    message = messages.completedSave || "Great news! We've updated your subscription. Thank you for staying with us!";
  } else {
    message = messages.completedDefault || "Thank you! We've processed your request.";
  }

  return NextResponse.json({ success: true, message });
}
