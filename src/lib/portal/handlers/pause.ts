import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, handleAppstleError } from "@/lib/portal/helpers";
import { decrypt } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

async function appstlePut(workspaceId: string, path: string) {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces")
    .select("appstle_api_key_encrypted")
    .eq("id", workspaceId).single();
  if (!ws?.appstle_api_key_encrypted) throw new Error("Appstle not configured");
  const apiKey = decrypt(ws.appstle_api_key_encrypted);

  const res = await fetch(`https://subscription-admin.appstle.com${path}`, {
    method: "PUT",
    headers: { "X-API-Key": apiKey },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Appstle API error: ${res.status} ${text}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

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

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const contractId = clampInt(payload?.contractId, 0);
  const pauseDays = clampInt(payload?.pauseDays, 0);
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);
  if (![30, 60].includes(pauseDays)) return jsonErr({ error: "invalid_pauseDays" }, 400);

  // Resume date is X days from TODAY, not from next billing date
  const resumeAt = addDays(pauseDays);
  const resumeLabel = formatDateShort(resumeAt);

  try {
    // Real pause in Appstle
    await appstlePut(auth.workspaceId,
      `/api/external/v2/subscription-contracts-update-status?contractId=${contractId}&status=PAUSED`
    );
  } catch (e) {
    return handleAppstleError(e);
  }

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

  // Fire Inngest event for scheduled auto-resume
  await inngest.send({
    name: "portal/subscription-paused",
    data: {
      workspaceId: auth.workspaceId,
      contractId: String(contractId),
      pauseDays,
      resumeAt,
    },
  });

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
