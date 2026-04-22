// Inngest cron: auto-resume paused subscriptions when pause_resume_at has passed
//
// Runs every hour, picks up all paused subs where pause_resume_at <= now()
// This replaces the old sleep-based approach which died on deploys.
//
// The event-triggered function is kept for backwards compat but is a no-op —
// the cron handles everything.

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

async function appstleResume(workspaceId: string, contractId: string) {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces")
    .select("appstle_api_key_encrypted")
    .eq("id", workspaceId).single();
  if (!ws?.appstle_api_key_encrypted) throw new Error("Appstle not configured");
  const apiKey = decrypt(ws.appstle_api_key_encrypted);

  const res = await fetch(
    `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-status?contractId=${contractId}&status=ACTIVE`,
    { method: "PUT", headers: { "X-API-Key": apiKey }, cache: "no-store" },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Appstle API error: ${res.status} ${text}`);
  }
}

// ── Cron: runs hourly, resumes all past-due paused subs ──
export const portalAutoResumeCron = inngest.createFunction(
  {
    id: "portal-auto-resume-cron",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "15 * * * *" }], // Every hour at :15
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const subs = await step.run("find-resumable-subs", async () => {
      const { data } = await admin
        .from("subscriptions")
        .select("id, workspace_id, shopify_contract_id, customer_id, pause_resume_at")
        .eq("status", "paused")
        .not("pause_resume_at", "is", null)
        .lte("pause_resume_at", new Date().toISOString());
      return data || [];
    });

    if (subs.length === 0) {
      return { status: "no_subs_to_resume" };
    }

    const results: { contractId: string; outcome: string }[] = [];

    for (const sub of subs) {
      const result = await step.run(`resume-${sub.shopify_contract_id}`, async () => {
        try {
          // Double-check status (may have been resumed manually since cron started)
          const { data: current } = await admin.from("subscriptions")
            .select("status")
            .eq("id", sub.id)
            .single();

          if (!current || current.status !== "paused") {
            return { contractId: sub.shopify_contract_id, outcome: "already_active" };
          }

          // Resume in Appstle
          await appstleResume(sub.workspace_id, sub.shopify_contract_id);

          // Update our DB
          await admin.from("subscriptions")
            .update({
              status: "active",
              pause_resume_at: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", sub.id);

          // Log customer event
          if (sub.customer_id) {
            await admin.from("customer_events").insert({
              workspace_id: sub.workspace_id,
              customer_id: sub.customer_id,
              event_type: "portal.subscription.auto_resumed",
              source: "system",
              summary: `Subscription #${sub.shopify_contract_id} automatically resumed after pause period`,
              properties: { shopify_contract_id: sub.shopify_contract_id },
            });
          }

          return { contractId: sub.shopify_contract_id, outcome: "resumed" };
        } catch (err) {
          console.error(`[Auto-Resume] Failed for ${sub.shopify_contract_id}:`, err);
          return { contractId: sub.shopify_contract_id, outcome: `error: ${String(err).slice(0, 100)}` };
        }
      });

      results.push(result);
    }

    return { processed: results.length, results };
  }
);

// ── Event trigger: kept for backwards compat with in-flight runs ──
// New pauses no longer need to fire this event — the cron picks them up.
// But existing sleeping runs will wake up and still work.
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

    // Sleep until the resume date (legacy — existing in-flight runs use this)
    await step.sleepUntil("wait-for-resume-date", new Date(resumeAt));

    // Check if subscription is still paused (cron may have already resumed it)
    const sub = await step.run("check-subscription-status", async () => {
      const admin = createAdminClient();
      const { data } = await admin.from("subscriptions")
        .select("status, pause_resume_at")
        .eq("workspace_id", workspaceId)
        .eq("shopify_contract_id", contractId)
        .single();
      return data;
    });

    if (!sub || sub.status !== "paused") {
      return { skipped: true, reason: "already_active", status: sub?.status };
    }

    // Resume in Appstle
    await step.run("appstle-resume", async () => {
      await appstleResume(workspaceId, contractId);
    });

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

    await step.run("log-event", async () => {
      const admin = createAdminClient();
      const { data: s } = await admin.from("subscriptions")
        .select("customer_id")
        .eq("workspace_id", workspaceId)
        .eq("shopify_contract_id", contractId)
        .single();

      if (s?.customer_id) {
        await admin.from("customer_events").insert({
          workspace_id: workspaceId,
          customer_id: s.customer_id,
          event_type: "portal.subscription.auto_resumed",
          summary: `Subscription #${contractId} automatically resumed after pause period`,
          properties: { shopify_contract_id: contractId },
        });
      }
    });

    return { resumed: true, contractId };
  }
);
