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
    .select("*, journey_definitions(name, config, trigger_intent), customers(first_name), workspaces(name, help_logo_url, help_primary_color)")
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

  const configObj = config as Record<string, unknown>;
  const definitionIntent = (session.journey_definitions as { trigger_intent?: string })?.trigger_intent || "";
  const triggerIntent = definitionIntent || (configObj.journeyType as string) || "";

  // Every journey is live-rendered. The orchestrator only inserted ids
  // into config_snapshot; we rebuild steps + metadata here from
  // current data on every click. No caching back to config_snapshot —
  // even old sessions get fresh subscriptions, addresses, loyalty
  // state, linked accounts, etc. Single code path means one less
  // class of "data went stale between send and click" bugs.
  const isCancel =
    triggerIntent === "cancel_subscription" ||
    triggerIntent === "cancel" ||
    triggerIntent === "cancellation" ||
    configObj.cancelJourney === true;

  if (triggerIntent) {
    const { buildJourneySteps } = await import("@/lib/journey-step-builder");
    const built = await buildJourneySteps(
      session.workspace_id,
      triggerIntent,
      session.customer_id,
      session.ticket_id || "",
    );

    // Cancel-specific affordance: if the orchestrator passed a
    // subscription_id on the session, pre-select it so the picker step
    // is auto-completed (single-sub customers never see it).
    if (isCancel && session.subscription_id && built.metadata) {
      (built.metadata as Record<string, unknown>).selectedSubscriptionId = session.subscription_id;
    }

    config = {
      ...configObj,
      ...built,
      codeDriven: true,
      liveRendered: true,
      journeyType: triggerIntent,
      ...(isCancel ? { cancelJourney: true } : {}),
    };
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
