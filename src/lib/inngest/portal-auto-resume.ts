// Inngest function: auto-resume a paused subscription after pause_resume_at
//
// Flow:
// 1. Triggered by "portal/subscription-paused" event
// 2. Sleeps until resume date
// 3. Checks if subscription is still paused (customer may have resumed early)
// 4. If still paused: Appstle PUT status=ACTIVE, update DB, log event
// 5. If already active: no-op

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

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
}

export const portalAutoResume = inngest.createFunction(
  {
    id: "portal-auto-resume",
    retries: 3,
    triggers: [{ event: "portal/subscription-paused" }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const { workspaceId, contractId, resumeAt } = event.data;

    if (!workspaceId || !contractId || !resumeAt) {
      return { skipped: true, reason: "missing_data" };
    }

    // Sleep until the resume date
    await step.sleepUntil("wait-for-resume-date", new Date(resumeAt));

    // Check if subscription is still paused
    const sub = await step.run("check-subscription-status", async () => {
      const admin = createAdminClient();
      const { data } = await admin.from("subscriptions")
        .select("status, pause_resume_at")
        .eq("workspace_id", workspaceId)
        .eq("shopify_contract_id", contractId)
        .single();
      return data;
    });

    // No-op if already resumed (customer did it manually)
    if (!sub || sub.status !== "paused") {
      return { skipped: true, reason: "already_active", status: sub?.status };
    }

    // Resume in Appstle
    await step.run("appstle-resume", async () => {
      await appstlePut(workspaceId,
        `/api/external/v2/subscription-contracts-update-status?contractId=${contractId}&status=ACTIVE`
      );
    });

    // Update our DB
    await step.run("update-db", async () => {
      const admin = createAdminClient();
      await admin.from("subscriptions")
        .update({
          status: "active",
          pause_resume_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("workspace_id", workspaceId)
        .eq("shopify_contract_id", contractId);
    });

    // Log customer event
    await step.run("log-event", async () => {
      const admin = createAdminClient();
      const { data: sub } = await admin.from("subscriptions")
        .select("customer_id")
        .eq("workspace_id", workspaceId)
        .eq("shopify_contract_id", contractId)
        .single();

      if (sub?.customer_id) {
        await admin.from("customer_events").insert({
          workspace_id: workspaceId,
          customer_id: sub.customer_id,
          event_type: "portal.subscription.auto_resumed",
          summary: `Subscription #${contractId} automatically resumed after pause period`,
          properties: { shopify_contract_id: contractId },
        });
      }
    });

    return { resumed: true, contractId };
  }
);
