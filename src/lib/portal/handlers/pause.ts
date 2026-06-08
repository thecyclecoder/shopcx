import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, handleAppstleError, checkPortalBan, resolveSub } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { appstleSubscriptionAction } from "@/lib/appstle";

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function formatDateShort(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    }).format(new Date(iso));
  } catch {
    return iso.split("T")[0];
  }
}

export const pause: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const resolved = await resolveSub(createAdminClient(), auth.workspaceId, payload?.contractId, auth.loggedInCustomerId);
  const contractId = resolved?.shopify_contract_id || "";
  const pauseDays = clampInt(payload?.pauseDays, 0);
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);
  if (![30, 60].includes(pauseDays)) return jsonErr({ error: "invalid_pauseDays" }, 400);

  // Resume date is X days from TODAY, not from next billing date
  const resumeAt = addDays(pauseDays);
  const resumeLabel = formatDateShort(resumeAt);

  // Route through the internal-aware wrapper (handles is_internal vs Appstle).
  const pauseResult = await appstleSubscriptionAction(auth.workspaceId, String(contractId), "pause");
  if (!pauseResult.success) return handleAppstleError(new Error(pauseResult.error || "Pause failed"));

  // Update our DB: status + pause_resume_at
  const admin = createAdminClient();
  await admin.from("subscriptions")
    .update({
      status: "paused",
      pause_resume_at: resumeAt,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", auth.workspaceId)
    .eq("shopify_contract_id", String(contractId));

  // Auto-resume handled by hourly cron (portal-auto-resume-cron)
  // No Inngest event needed — cron reads pause_resume_at from DB

  // Log customer event
  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    await logPortalAction({
      workspaceId: auth.workspaceId,
      customerId: customer.id,
      eventType: "portal.subscription.paused",
      summary: `Subscription #${contractId} paused until ${resumeLabel}`,
      properties: { shopify_contract_id: String(contractId), pauseDays, resumeAt },
      createNote: false,
    });
  }

  return jsonOk({
    ok: true, route, contractId, pauseDays, resumeAt,
    patch: { status: "PAUSED", pauseResumeAt: resumeAt },
  });
};
