import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET: Load journey session (public, no auth — token IS the auth)
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  void request;

  const admin = createAdminClient();

  const { data: session } = await admin
    .from("journey_sessions")
    .select("*, journey_definitions(name, config), customers(first_name), workspaces(name, help_logo_url, help_primary_color)")
    .eq("token", token)
    .single();

  if (!session) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Check expiry
  if (new Date(session.token_expires_at) < new Date() && session.status !== "completed") {
    if (session.status !== "expired") {
      await admin.from("journey_sessions").update({ status: "expired" }).eq("id", session.id);
    }
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }

  // Already completed
  if (session.status === "completed") {
    const config = session.config_snapshot || (session.journey_definitions as { config: unknown })?.config || {};
    return NextResponse.json({
      status: "completed",
      outcome: session.outcome,
      config,
      customerFirstName: (session.customers as { first_name: string | null })?.first_name || null,
    });
  }

  // First load: mark as in_progress
  if (session.status === "pending") {
    await admin
      .from("journey_sessions")
      .update({ status: "in_progress", started_at: new Date().toISOString() })
      .eq("id", session.id);
  }

  // Use config_snapshot (frozen at session creation) or fall back to definition
  let config = session.config_snapshot || (session.journey_definitions as { config: unknown })?.config || {};

  // For code-driven journeys, dynamically build steps if not already built
  const configObj = config as Record<string, unknown>;

  // Rebuild cancel journey config if metadata or cancel reasons are missing
  const hasReasons = ((configObj.steps as unknown[]) || []).length > 0;
  if (configObj.codeDriven && configObj.cancelJourney && (!(configObj.metadata as Record<string, unknown>)?.subscriptions || !hasReasons)) {
    const { buildJourneySteps } = await import("@/lib/journey-step-builder");
    const built = await buildJourneySteps(
      session.workspace_id,
      (configObj.journeyType as string) || "cancel_subscription",
      session.customer_id,
      session.ticket_id || "",
    );
    config = { ...configObj, ...built };
    await admin.from("journey_sessions").update({ config_snapshot: config }).eq("id", session.id);
  }

  if (configObj.codeDriven && configObj.journeyType && !(configObj.steps as unknown[])?.length && !configObj.cancelJourney) {
    const { buildJourneySteps } = await import("@/lib/journey-step-builder");
    const built = await buildJourneySteps(
      session.workspace_id,
      configObj.journeyType as string,
      session.customer_id,
      session.ticket_id || "",
    );
    config = { ...configObj, ...built };

    // Cache the built steps back to the session so subsequent loads are instant
    await admin.from("journey_sessions").update({ config_snapshot: config }).eq("id", session.id);
  }

  // Merge workspace branding into config if not already present
  const ws = session.workspaces as { name?: string; help_logo_url?: string; help_primary_color?: string } | null;
  const mergedConfig = { ...config as Record<string, unknown> };
  if (ws && !(mergedConfig.branding as Record<string, unknown>)?.logoUrl) {
    mergedConfig.branding = {
      ...(mergedConfig.branding as Record<string, unknown> || {}),
      ...(ws.help_logo_url ? { logoUrl: ws.help_logo_url } : {}),
      ...(ws.help_primary_color ? { primaryColor: ws.help_primary_color } : {}),
    };
  }

  return NextResponse.json({
    status: session.status === "pending" ? "in_progress" : session.status,
    currentStep: session.current_step,
    responses: session.responses,
    config: mergedConfig,
    journeyName: (session.journey_definitions as { name: string })?.name || "",
    customerFirstName: (session.customers as { first_name: string | null })?.first_name || null,
    workspaceName: ws?.name || "",
  });
}
