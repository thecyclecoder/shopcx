import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, handleAppstleError, checkPortalBan, resolveSub } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
// ⭐ Vendor writes go through the commerce SDK, never the Appstle wrapper directly. Calling the
// vendor straight bypasses billing_source resolution, so a migrated subscription's change would
// hit Appstle for a contract it no longer holds — failing there and returning BEFORE the local
// write, leaving the customer's change silently unapplied.
import { subscriptionAction } from "@/lib/commerce/subscription";
import { computePausedRenewalDate } from "@/lib/portal/pause-renewal-date";

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

  // Pause counts from the next renewal, not from today: the new renewal is the old
  // next_billing_date + pauseDays (falling back to today when there's no future date).
  const resumeAt = computePausedRenewalDate(resolved?.next_billing_date ?? null, pauseDays, new Date());
  const resumeLabel = formatDateShort(resumeAt);

  // Route through the internal-aware wrapper (handles is_internal vs Appstle).
  const pauseResult = await subscriptionAction(auth.workspaceId, String(contractId), "pause");
  if (!pauseResult.success) return handleAppstleError(new Error(pauseResult.error || "Pause failed"));

  // Update our DB: status + pause_resume_at
  const admin = createAdminClient();
  await admin.from("subscriptions")
    .update({
      status: "paused",
      pause_resume_at: resumeAt,
      // The chosen renewal IS the next billing date now — auto-resume honors this future date
      // instead of re-deriving one off the cycle grid.
      next_billing_date: resumeAt,
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
      summary: `Subscription #${contractId} paused — your next order is now ${resumeLabel}`,
      properties: { shopify_contract_id: String(contractId), pauseDays, resumeAt },
      createNote: false,
    });
  }

  return jsonOk({
    ok: true, route, contractId, pauseDays, resumeAt,
    patch: { status: "PAUSED", pauseResumeAt: resumeAt },
  });
};
